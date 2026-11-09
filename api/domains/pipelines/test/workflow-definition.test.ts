import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentRecord } from "eumenes-pipeline";
import { z } from "zod";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import {
	activeCheckpointWorkflowInTransaction,
	admitWorkflowInTransaction,
	checkWorkflowDefinition,
	finishWorkflowInTransaction,
	migrations,
	recordWorkflowParentInTransaction,
	saveWorkflowInTransaction,
	workflowDraftDigest,
	workflowInputs,
	workflowRevisionInTransaction,
	workflowRunInTransaction,
	type WorkflowCatalog,
} from "..";

function component(entry: string): ComponentRecord {
	return {
		card: {
			entry,
			bundle: entry,
			title: entry,
			summary: entry,
			useWhen: [],
			avoidWhen: [],
			effects: [],
			mayAskUser: false,
			output: { schemaRef: null, origin: "missing" },
		},
		execution: "command",
		enabled: true,
		support: "partial",
		reasons: [],
		evidence: {
			toolchainRevisionId: `toolchain:${entry}@1`,
			definitionHash: null,
			packageRevisionId: null,
			bindingRevisionId: null,
			bindingDigest: null,
			adapterRef: null,
			bundleSource: null,
			toolRevisionIds: [],
			inputSchemaRefs: [],
			outputSchemaRef: null,
			inputOrigin: "missing",
		},
	};
}
const inputRef = "schema:workflow-input@1";
const rowsRef = "schema:rows@1";
const markdownRef = "schema:markdown@1";
const checkpointRef = "schema:cursor@1";
const request = "Read the source and publish the requested result";
const schema = z.strictObject({ day: z.iso.date(), location: z.string() });
const schemas = new Map<string, z.ZodType>([
	[inputRef, schema],
	[rowsRef, z.strictObject({ rows: z.array(z.string()) })],
	[markdownRef, z.strictObject({ text: z.string() })],
	[checkpointRef, z.strictObject({ cursor: z.string() })],
]);
const catalog: WorkflowCatalog = {
	components: [component("source.read"), component("content.write")],
	schema: (ref) => schemas.get(ref) ?? null,
	step: (ref) =>
		ref === "toolchain:source.read@1"
			? {
					operationRef: "source.read@1",
					outputSchemaRef: rowsRef,
					requestSchemas: [inputRef],
					acceptedResultSchemas: [],
					checkpointSchemaRef: checkpointRef,
				}
			: ref === "toolchain:content.write@1"
				? {
						operationRef: "content.write@1",
						outputSchemaRef: markdownRef,
						requestSchemas: "workflow",
						acceptedResultSchemas: [rowsRef],
						coverageSchemaRefs: [checkpointRef],
					}
				: null,
};
const read = {
	id: "read",
	bundle: "source.read",
	task: "Read the source",
	from: ["request"],
	result: "Rows with sources",
};
const manual = {
	version: 1,
	trigger: "manual",
	input: { schemaRef: inputRef, fixed: { location: "source location" } },
	pipeline: {
		request,
		steps: [read],
		output: { from: ["read"], deliver: "Show rows" },
	},
	publish: { kind: "dataset", from: "read", schemaRef: rowsRef },
};
const daily = {
	...manual,
	trigger: "schedule",
	input: {
		...manual.input,
		fixed: { ...manual.input.fixed, day: "2026-11-09" },
	},
	pipeline: {
		request,
		steps: [
			read,
			{
				id: "write",
				bundle: "content.write",
				task: "Write from the supplied sources",
				from: ["read"],
				result: "Markdown with coverage",
			},
		],
		output: { from: ["read", "write"], deliver: "Publish a document" },
	},
	checkpoint: { from: "read", schemaRef: checkpointRef },
	publish: {
		kind: "markdown",
		from: "write",
		schemaRef: markdownRef,
		destinationRef: "destination:document",
	},
};

test("workflow definition uses the existing checker and pins typed completed outputs", () => {
	expect(checkWorkflowDefinition(manual, request, catalog).pins).toEqual([
		{
			stepId: "read",
			toolchainRevisionId: "toolchain:source.read@1",
			operationRef: "source.read@1",
			outputSchemaRef: rowsRef,
		},
	]);
	expect(checkWorkflowDefinition(daily, request, catalog).pins).toHaveLength(2);
	expect(() =>
		checkWorkflowDefinition(
			{ ...daily, checkpoint: undefined },
			request,
			catalog,
		),
	).toThrow("workflow_checkpoint_required");
	expect(() =>
		checkWorkflowDefinition(manual, "Other request", catalog),
	).toThrow("workflow_pipeline_invalid");
	expect(() =>
		checkWorkflowDefinition(
			{ ...daily, input: manual.input },
			request,
			catalog,
		),
	).toThrow("workflow_scheduled_input_incomplete");
	expect(() =>
		checkWorkflowDefinition(
			{ ...manual, publish: { ...manual.publish, schemaRef: markdownRef } },
			request,
			catalog,
		),
	).toThrow("workflow_publish_incompatible");
	const detached = {
		...daily,
		pipeline: {
			...daily.pipeline,
			steps: [read, { ...daily.pipeline.steps[1]!, from: ["request"] }],
		},
	};
	expect(() => checkWorkflowDefinition(detached, request, catalog)).toThrow(
		"workflow_checkpoint_incompatible",
	);
	expect(
		workflowInputs(schema, manual.input.fixed, { day: "2026-11-09" }),
	).toEqual({ day: "2026-11-09", location: "source location" });
	expect(() =>
		workflowInputs(schema, manual.input.fixed, {
			day: "2026-11-09",
			location: "other",
		}),
	).toThrow("workflow_fixed_input_override");
});

test("a run accepts, queues and locks atomically until the matching terminal update", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-run-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store);
	const scope = "owner";
	const workflowId = "daily";
	const draft = {
		definition: daily,
		schemas: [],
		grant: { conversationId: "main" },
	};
	try {
		queue.registerHandler({
			kind: "fixture.workflow",
			payloadVersions: [1],
			schema: z.strictObject({ runId: z.uuid() }),
			recovery: "replay_safe",
			prepareInTransaction: () => ({ status: "ready", input: null }),
			execute: async () => null,
			settleInTransaction: () => "applied",
			cancelInTransaction: () => {},
		});
		await store.write((db) =>
			saveWorkflowInTransaction(
				db,
				{
					scope,
					workflowId,
					operationId: crypto.randomUUID(),
					expectedRevision: 0,
					confirmedDigest: workflowDraftDigest(draft),
					draft,
				},
				request,
				{ ...catalog, schemaDigest: () => null, artifactDigest: () => null },
			),
		);
		const op = {
			scope,
			workflowId,
			revision: 1,
			inputs: {},
			origin: {
				kind: "schedule",
				operationId: "occurrence",
				scheduledAt: 1_000,
			},
		};
		let fail = true;
		const admit = (value: unknown) =>
			store.write((db) =>
				admitWorkflowInTransaction(db, value, {
					nowMs: 1_001,
					deadlineMs: 60_000,
					schema: catalog.schema,
					authorized: () => true,
					enqueue: ({ runId }) => {
						const { job } = queue.enqueueInTransaction(db, {
							kind: "fixture.workflow",
							scope,
							dedupeKey: runId,
							subjectRef: runId,
							lane: "background",
							payload: { runId },
						});
						if (fail) throw new Error("fixture_enqueue_failed");
						return job.id;
					},
				}),
			);
		const active = () =>
			store.read((db) =>
				activeCheckpointWorkflowInTransaction(db, scope, workflowId),
			);
		await expect(admit(op)).rejects.toThrow("fixture_enqueue_failed");
		expect(active()).toBeNull();
		fail = false;
		const first = await admit(op);
		expect(first.fresh).toBe(true);
		expect(active()).toBe(first.runId);
		expect(await admit(op)).toEqual({ ...first, fresh: false });
		await expect(
			admit({ ...op, origin: { ...op.origin, scheduledAt: 1_001 } }),
		).rejects.toThrow("request_conflict");
		const manual = {
			...op,
			origin: { kind: "manual", operationId: crypto.randomUUID() },
		};
		expect(await admit(manual)).toEqual({
			runId: first.runId,
			jobId: null,
			fresh: false,
		});
		const read = (owner = scope) =>
			store.read((db) => workflowRunInTransaction(db, owner, first.runId));
		expect(read()?.scheduledAtMs).toBe(1_000);
		expect(read("other")).toBeNull();
		await store.write((db) => {
			expect(
				recordWorkflowParentInTransaction(db, scope, first.runId, "parent", 1),
			).toBe(true);
			expect(
				finishWorkflowInTransaction(db, scope, first.runId, "completed", 1),
			).toBe(false);
			expect(
				finishWorkflowInTransaction(db, scope, first.runId, "cancelled", 2),
			).toBe(true);
			expect(
				finishWorkflowInTransaction(db, scope, first.runId, "completed", 3),
			).toBe(false);
		});
		expect(read()?.state).toBe("cancelled");
		expect(active()).toBeNull();
		expect(await admit(op)).toEqual({ ...first, fresh: false });
		expect((await admit(manual)).fresh).toBe(true);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("confirmed saves freeze their assets and replay only inside the owning scope", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-definition-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	try {
		const digest = "a".repeat(64);
		const draft = {
			definition: manual,
			schemas: [{ revisionId: inputRef, digest }],
			artifact: { id: "screen", revision: 1, digest },
		};
		const saveCatalog = {
			...catalog,
			schemaDigest: (ref: string) => (ref === inputRef ? digest : null),
			artifactDigest: (id: string, revision: number) =>
				id === "screen" && revision === 1 ? digest : null,
		};
		const input = {
			scope: "owner",
			workflowId: "workflow",
			operationId: crypto.randomUUID(),
			expectedRevision: 0,
			confirmedDigest: workflowDraftDigest(draft),
			draft,
		};
		const save = (value: unknown) =>
			store.write((db) =>
				saveWorkflowInTransaction(db, value, request, saveCatalog),
			);
		const first = await save(input);
		expect(first.revision).toBe(1);
		expect(await save(input)).toEqual(first);
		expect(
			store.read((db) =>
				workflowRevisionInTransaction(db, "other", "workflow"),
			),
		).toBeNull();
		await expect(save({ ...input, expectedRevision: 1 })).rejects.toThrow(
			"request_conflict",
		);
		await expect(
			save({
				...input,
				draft: { ...draft, artifact: { ...draft.artifact, revision: 2 } },
			}),
		).rejects.toThrow("workflow_confirmation_changed");
		const changed = { ...draft, artifact: { ...draft.artifact, revision: 2 } };
		await expect(
			save({
				...input,
				operationId: crypto.randomUUID(),
				expectedRevision: 1,
				draft: changed,
				confirmedDigest: workflowDraftDigest(changed),
			}),
		).rejects.toThrow("workflow_artifact_snapshot_changed");
		expect(
			store.read((db) =>
				workflowRevisionInTransaction(db, "owner", "workflow"),
			),
		).toEqual(first);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
