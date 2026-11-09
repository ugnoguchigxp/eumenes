import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	createCapabilities,
	prepareWorkflowSchema,
} from "../../domains/capabilities";
import { workflowRevisionInTransaction } from "../../domains/pipelines";
import { workflowScreenInTransaction } from "../../domains/ui-compositions";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createWorkflowAuthoring } from "./workflow-authoring";
import { harness } from "../toolchain/toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import {
	admitWorkflowInTransaction,
	recordWorkflowParentInTransaction,
	saveWorkflowInTransaction,
	workflowDraftDigest,
} from "../../domains/pipelines";
import { createWorkflowExecutionAuthority } from "./workflow-execution-source";
import { createWorkflowStepExecution } from "./workflow-step-execution";

test("a confirmed screen, generated type and workflow definition commit or roll back together", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-authoring-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const scope = "owner";
		const workflowId = "source-table";
		const sourceRequest = "Show source rows";
		const source = {
			scope,
			workflowId,
			sourceRequest,
			conversationId: "verified-thread",
			expectedRevision: 0,
		};
		const schema = {
			name: "query",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["day"],
				properties: { day: { type: "string", minLength: 10, maxLength: 10 } },
			},
		};
		const schemaRef = prepareWorkflowSchema({
			...schema,
			scope,
			workflowId,
			revision: 1,
		}).revisionId;
		const rowRef = "domain:source-rows@1";
		const capabilities = createCapabilities(store);
		let allow = true;
		let operationRef = "fixture:collect@1";
		const authoring = createWorkflowAuthoring({
			store,
			capabilities,
			mayConfirm: () => allow,
			catalog: () => ({
				components: [
					{
						card: {
							entry: "fixture",
							bundle: "fixture",
							title: "Fixture",
							summary: "Fixture source",
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
							toolchainRevisionId: "toolchain:fixture@1",
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
					},
				],
				schema: (ref) =>
					ref === rowRef
						? z.strictObject({
								rows: z.array(z.strictObject({ title: z.string() })),
							})
						: null,
				step: () => ({
					operationRef,
					outputSchemaRef: "publish",
					requestSchemas: "workflow",
					acceptedResultSchemas: [],
				}),
			}),
		});
		const draft = {
			definition: {
				version: 1,
				trigger: "manual",
				input: { schemaRef, fixed: {} },
				pipeline: {
					request: sourceRequest,
					steps: [
						{
							id: "collect",
							bundle: "fixture",
							from: ["request"],
							task: "Collect rows",
							result: "Source rows",
						},
					],
					output: { from: ["collect"], deliver: "Show the result" },
				},
				publish: { kind: "dataset", from: "collect", schemaRef: rowRef },
			},
			schemas: [schema],
			screen: {
				definition: {
					view: "layout",
					direction: "stack",
					children: [
						{
							view: "form",
							title: "Query",
							fields: [{ id: "query", label: "Date", type: "text" }],
						},
						{
							view: "data-table",
							columns: [{ header: "Title" }],
							rows: [["Pending"]],
						},
					],
				},
				bindings: {
					inputs: { query: "day" },
					table: { path: [1], rowsKey: "rows", columns: ["title"] },
				},
			},
		};
		const read = (owner = source) =>
			store.read((db) => ({
				definition: workflowRevisionInTransaction(db, owner.scope, workflowId),
				schema: capabilities.workflowSchemaInTransaction(db, schemaRef, owner),
				screen: workflowScreenInTransaction(db, owner, workflowId, 1),
			}));
		const { digest } = authoring.preview(source, draft);
		const empty = { definition: null, schema: null, screen: null };
		expect(read()).toEqual(empty);
		const id = crypto.randomUUID();
		const confirm = () => authoring.confirm(source, draft, id, digest);
		allow = false;
		await expect(confirm()).rejects.toThrow("workflow_confirmation_forbidden");
		allow = true;
		operationRef = "fixture:collect@2";
		await expect(confirm()).rejects.toThrow("workflow_confirmation_changed");
		operationRef = "fixture:collect@1";
		await store.write((db) =>
			db.run(
				"CREATE TRIGGER fail_receipt BEFORE INSERT ON workflow_save_receipts BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END",
			),
		);
		await expect(confirm()).rejects.toThrow("fixture_failure");
		expect(read()).toEqual(empty);
		await store.write((db) => db.run("DROP TRIGGER fail_receipt"));
		const saved = await confirm();
		const published = read();
		expect(published.definition).toEqual(saved);
		expect(published.schema?.digest).toBe(saved.value.schemas[0]?.digest);
		expect(published.screen?.digest).toBe(saved.value.artifact?.digest);
		expect(saved.value.grant?.conversationId).toBe(source.conversationId);
		operationRef = "fixture:collect@3";
		expect(await confirm()).toEqual(saved);
		await expect(
			authoring.confirm(source, { ...draft, schemas: [] }, id, digest),
		).rejects.toThrow("request_conflict");
		expect(read({ ...source, scope: "another" })).toEqual(empty);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the existing pipeline runs a confirmed workflow using typed predecessor values", async () => {
	const sourceRequest = "Publish source counts";
	const operationRef = "fixture:count@1";
	const inputRef = "domain:fixture-input@1";
	const outputRef = "domain:fixture-output@1";
	const inputSchema = z.strictObject({ start: z.number() });
	const outputSchema = z.strictObject({ value: z.number() });
	const schema = (ref: string) =>
		ref === inputRef ? inputSchema : ref === outputRef ? outputSchema : null;
	const authority = createWorkflowExecutionAuthority({
		now: Date.now,
		authorized: () => true,
	});
	const values: number[] = [];
	const h = await harness({
		pipelines: true,
		timers: true,
		compose: () => {
			throw new Error("confirmed_workflow_called_planner");
		},
		command: () => {
			throw new Error("typed_workflow_called_translator");
		},
		workflowRuntime: (agents) => ({
			workflowAuthority: authority,
			workflowSteps: createWorkflowStepExecution({
				authority,
				agents: agents.executions,
				schema: (_db, _child, ref) => schema(ref),
				operations: new Map([
					[
						operationRef,
						{
							prepare: (_db, input) => {
								expect(input.task).toBeUndefined();
								return input.request
									? inputSchema.parse(input.request).start
									: outputSchema.parse(input.predecessors.read).value + 1;
							},
							execute: async (value) => {
								values.push(z.number().parse(value));
								return {
									state: "completed",
									ref: {},
									output: { value },
									modelCalls: 0,
									references: [],
									summary: "counted",
								};
							},
							current: () => {
								throw new Error("fixture_already_complete");
							},
						},
					],
				]),
			}),
		}),
	});
	try {
		const scope = "default";
		const workflowId = "counts";
		const exec = h.toolchain.agents.executions;
		const definition = {
			version: 1,
			trigger: "manual",
			input: { schemaRef: inputRef, fixed: {} },
			pipeline: {
				request: sourceRequest,
				steps: [
					{
						id: "read",
						bundle: "timers.manage",
						from: ["request"],
						task: "Collect count",
						result: "Number",
					},
					{
						id: "count",
						bundle: "timers.manage",
						from: ["read"],
						task: "Count rows",
						result: "Number",
					},
				],
				output: { from: ["count"], deliver: "Publish" },
			},
			publish: {
				kind: "markdown",
				from: "count",
				schemaRef: outputRef,
				destinationRef: "fixture:destination",
			},
		};
		const draft = {
			definition,
			schemas: [],
			grant: { conversationId: "main" },
		};
		const deadline = Date.now() + 60_000;
		const start = await h.store.write((db) => {
			const components = h.executionPort!.pipelineCatalogInTransaction!(db, {
				conversationId: "main",
				messageId: null,
				runId: "fixture",
				request: sourceRequest,
				digest: "fixture",
			});
			const pipeline = h.toolchain.capabilities
				.toolchainsInTransaction(db)
				.find((item) => item.id === "pipeline.execute")!;
			saveWorkflowInTransaction(
				db,
				{
					scope,
					workflowId,
					expectedRevision: 0,
					operationId: crypto.randomUUID(),
					confirmedDigest: workflowDraftDigest(draft),
					draft,
				},
				sourceRequest,
				{
					components,
					schema,
					schemaDigest: () => null,
					artifactDigest: () => null,
					step: () => ({
						operationRef,
						outputSchemaRef: outputRef,
						requestSchemas: [inputRef],
						acceptedResultSchemas: [outputRef],
					}),
				},
			);
			const accepted = admitWorkflowInTransaction(
				db,
				{
					scope,
					workflowId,
					revision: 1,
					origin: { kind: "manual", operationId: crypto.randomUUID() },
					inputs: { start: 7 },
				},
				{
					nowMs: Date.now(),
					deadlineMs: deadline,
					schema,
					authorized: () => true,
					enqueue: () => "fixture",
				},
			);
			const source = authority.sourceInTransaction(db, scope, accepted.runId)!;
			const run = {
				source,
				deadline,
				toolchainRevisionId: pipeline.revisionId,
				requestId: accepted.runId,
			};
			expect(() =>
				exec.startPipelineInTransaction(db, {
					...run,
					definition: definition.pipeline,
				}),
			).toThrow("pipeline_workflow_source_required");
			expect(() =>
				exec.startPipelineInTransaction(db, {
					...run,
					source: { ...source, digest: "fake" },
				}),
			).toThrow("execution_source_invalid");
			const view = exec.startPipelineInTransaction(db, run);
			expect(exec.startPipelineInTransaction(db, run).id).toBe(view.id);
			expect(
				recordWorkflowParentInTransaction(
					db,
					scope,
					accepted.runId,
					view.id,
					1,
				),
			).toBe(true);
			return view.id;
		});
		await waitFor(
			() =>
				exec
					.list("main")
					.some((run) => run.id === start && run.status === "completed"),
			{ timeout: 5000 },
		);
		expect(values).toEqual([7, 8]);
		expect(h.commandContexts).toEqual([]);
	} finally {
		await h.close();
	}
});
