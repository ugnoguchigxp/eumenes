import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, movies, date } from "./app-development.fixture";
import { createGitObservation } from "../../domains/git-observation";
import {
	workflowScheduleInTransaction,
	workflowRunInTransaction,
} from "../../domains/pipelines";
import { saveRequestContext } from "../../domains/app-development/test/legacy.fixture";
import { waitFor } from "../../infrastructure/wait-for";

type Harness = Awaited<ReturnType<typeof fixture>>;
async function save(h: Harness) {
	const work = (await h.source()).data.work;
	return h.action("save", {
		workRef: work.workRef,
		expectedRevision: String(work.revision),
		expectedSavedRevision: String(work.savedRevision),
		digest: work.confirmation.digest,
	});
}

const scheduledMovies = {
	...movies,
	screen: {
		definition: { view: "grouped-list", groups: [] },
		bindings: {
			inputs: {},
			sections: { ...movies.screen.bindings.sections, path: [] },
		},
	},
	workflow: {
		...movies.workflow,
		trigger: "schedule",
		input: {
			...movies.workflow.input,
			fixed: { ...movies.workflow.input.fixed, date },
		},
	},
};

test("a new confirmed screen stops its old schedule and active workflow", async () => {
	let clock = Date.now();
	const h = await fixture({
		request: "毎日の上映一覧アプリを作って",
		draft: scheduledMovies,
		git: createGitObservation("/unused"),
		timerNow: () => clock,
	});
	try {
		const id = await h.create();
		await h.action(
			"schedule",
			{
				appId: id,
				revision: "1",
				anchor: new Date(clock + 86400000).toISOString(),
			},
			id,
		);
		const binding = h.store.read((db) =>
			workflowScheduleInTransaction(db, "default", id),
		)!;
		await h.action("run", { appId: id, revision: "1", values: "{}" }, id);
		const runId = (await h.source(id)).data.viewing.status.runId;
		const work = (await h.source()).data.work;
		await h.action("source", {
			workRef: work.workRef,
			expectedRevision: String(work.revision),
			text: JSON.stringify({
				version: 1,
				title: "画面だけ",
				screen: { definition: { view: "text-block", title: "案内" } },
				schemas: [],
			}),
		});
		const confirmation = (await h.source()).data.work;
		await expect(
			h.store.write((db) => {
				const operationId = crypto.randomUUID();
				h.appRuntime!.adapter.invokeInTransaction(db, {
					requestId: operationId,
					issuedAt: new Date().toISOString(),
					operationName: "app-development.save",
					origin: {
						kind: "ui",
						scope: "default",
						actionRequestId: operationId,
					},
					input: {
						workRef: confirmation.workRef,
						expectedRevision: confirmation.revision,
						expectedSavedRevision: confirmation.savedRevision,
						digest: confirmation.confirmation.digest,
					},
				});
				throw new Error("publication_interrupted");
			}),
		).rejects.toThrow("publication_interrupted");
		expect(h.scheduler.get(binding.schedule_id)?.state).toBe("active");
		expect(h.store.read((db) => h.appRuntime!.apps.app(db, id))?.revision).toBe(
			1,
		);
		await save(h);
		expect((await h.source(id)).data.viewing.workflow).toBeNull();
		expect(h.scheduler.get(binding.schedule_id)?.state).toBe("cancelled");
		expect(
			h.store.read((db) => workflowScheduleInTransaction(db, "default", id)),
		).toBeNull();
		expect(
			h.store.read((db) => workflowRunInTransaction(db, "default", runId))
				?.state,
		).toBe("cancelled");
		clock += 86400001;
		await h.scheduler.tick();
		expect(
			h.store.read((db) => workflowScheduleInTransaction(db, "default", id)),
		).toBeNull();
	} finally {
		await h.close();
	}
}, 15000);

test("recovery cancels a legacy schedule whose workflow is no longer the app's published revision", async () => {
	const h = await fixture({
		request: "毎日の上映一覧アプリを作って",
		draft: scheduledMovies,
		git: createGitObservation("/unused"),
	});
	try {
		const id = await h.create();
		await h.action(
			"schedule",
			{
				appId: id,
				revision: "1",
				anchor: new Date(Date.now() + 86400000).toISOString(),
			},
			id,
		);
		const binding = h.store.read((db) =>
			workflowScheduleInTransaction(db, "default", id),
		)!;
		const work = (await h.source()).data.work;
		// Reproduce a store published by the old implementation, which left its old schedule active.
		await h.store.write((db) => {
			const apps = h.appRuntime!.apps;
			const changed = apps.commit(db, work.workRef, {
				revision: work.revision,
				value: {
					version: 1,
					title: "案内",
					screen: { definition: { view: "text-block", title: "案内" } },
				},
			});
			apps.publish(db, {
				workRef: work.workRef,
				draftRevision: changed.revision,
				expectedSavedRevision: 1,
				digest: "legacy-publication",
				workflowRevision: null,
				screenRevision: null,
			});
		});
		expect(h.scheduler.get(binding.schedule_id)?.state).toBe("active");
		await h.appRuntime!.recover();
		expect(h.scheduler.get(binding.schedule_id)?.state).toBe("cancelled");
		expect(
			h.store.read((db) => workflowScheduleInTransaction(db, "default", id)),
		).toBeNull();
		expect((await h.source(id)).data.viewing.savedRevision).toBe(2);
	} finally {
		await h.close();
	}
}, 10000);

test("a later explicit URL change preserves the original request and adopts the current intent", async () => {
	let changed = false,
		baseRevision = 0;
	const request = "検証劇場の上映一覧アプリを作って";
	const url = "https://example.net/new-official";
	const updated = {
		...movies,
		workflow: {
			...movies.workflow,
			input: {
				...movies.workflow.input,
				fixed: { ...movies.workflow.input.fixed, sourceUrl: url },
			},
			pipeline: {
				...movies.workflow.pipeline,
				request: `${request}。取得先は ${url}`,
			},
		},
	};
	const h = await fixture({
		request,
		draft: movies,
		git: createGitObservation("/unused"),
		specialist: () => ({
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision,
				title: "下書き",
				content: changed ? updated : movies,
			},
			text: "下書きを更新しました。",
		}),
	});
	try {
		const id = await h.create();
		baseRevision = (await h.source()).data.work.revision;
		changed = true;
		await h.propose("取得先を見直してください");
		expect((await h.source()).data.work.rejected.issues).toContainEqual(
			expect.objectContaining({ rule: "workflow_source_url_unconfirmed" }),
		);
		await h.propose(`取得先を ${url} に変更してください`);
		const work = (await h.source()).data.work;
		expect(work.rejected).toBeNull();
		expect(work.confirmation).toBeTruthy();
		await save(h);
		const saved = h.store.read((db) => h.appRuntime!.apps.app(db, id))!;
		expect(saved.request).toBe(request);
		expect(saved.requestContext?.current).toBe(
			updated.workflow.pipeline.request,
		);
		expect(saved.requestContext?.sources.length).toBeGreaterThanOrEqual(2);
	} finally {
		await h.close();
	}
}, 15000);

test("a missing required workflow input is rejected before the draft can be confirmed", async () => {
	const draft = {
		...movies,
		screen: {
			definition: { view: "grouped-list", groups: [] },
			bindings: {
				inputs: {},
				sections: { ...movies.screen.bindings.sections, path: [] },
			},
		},
	};
	const h = await fixture({
		request: "日付を指定する上映一覧を作って",
		draft,
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose("日付を指定する上映一覧を作って");
		const work = (await h.source()).data.work;
		expect(work.revision).toBe(0);
		expect(work.confirmation).toBeNull();
		expect(work.rejected.issues).toContainEqual(
			expect.objectContaining({
				rule: "workflow_screen_input_missing",
				path: "screen.bindings.inputs",
			}),
		);
	} finally {
		await h.close();
	}
}, 10000);

test("a failed initial save can be resumed once without a backend restart", async () => {
	const draft = {
		version: 1,
		title: "メモ",
		schemas: [
			{
				name: "note",
				schema: {
					type: "object",
					properties: { title: { type: "string", maxLength: 100 } },
					required: ["title"],
					additionalProperties: false,
				},
			},
		],
		storage: {
			version: 1,
			collections: [
				{ id: "notes", schema: "note", operations: ["list", "create"] },
			],
		},
		screen: {
			definition: {
				view: "form",
				title: "入力",
				fields: [{ id: "title", label: "題名", type: "text", required: true }],
			},
			storage: { collection: "notes", inputs: { title: "title" } },
		},
	};
	const h = await fixture({
		request: "題名を保存するメモアプリを作って",
		draft,
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose("題名を保存するメモアプリを作って");
		const root = join(h.dir, "app-storage");
		writeFileSync(root, "fault");
		await save(h);
		await waitFor(async () => !!(await h.source()).data.work.retrySave);
		const retry = (await h.source()).data.work.retrySave;
		rmSync(root);
		h.appRuntime!.attachDialogue({
			...h.dialogue,
			specialistSessionLiveInTransaction: () => false,
		});
		const eventId = crypto.randomUUID();
		const input = { ...retry, stateRevision: String(retry.stateRevision) };
		await h.action("retry-save", input, undefined, eventId);
		await h.action("retry-save", input, undefined, eventId);
		await waitFor(
			async () =>
				(await h.source(retry.appId)).data.viewing?.storageState === "active",
		);
		expect((await h.source(retry.appId)).data.viewing.savedRevision).toBe(1);
		expect((await h.source()).data.work.retrySave).toBeUndefined();
		await h.action("retry-save", input, undefined, undefined, "rejected");
	} finally {
		await h.close();
	}
}, 15000);

test("invalid execution values are a domain refusal, not an internal server error", async () => {
	const h = await fixture({
		request: "日付を指定する上映一覧アプリを作って",
		draft: movies,
		git: createGitObservation("/unused"),
	});
	try {
		const id = await h.create();
		const result = await h.action(
			"run",
			{
				appId: id,
				revision: "1",
				values: JSON.stringify({ date: "not-a-date" }),
			},
			id,
			undefined,
			"rejected",
		);
		expect(result.errorCode).toBe("workflow_pipeline_invalid");
	} finally {
		await h.close();
	}
}, 10000);

test("a conversation handoff delivers the earlier agreed conditions to the app specialist", async () => {
	let handoff: unknown;
	const h = await fixture({
		request: "先ほどの条件でアプリを作って",
		draft: movies,
		git: createGitObservation("/unused"),
		specialist: (messages) => {
			const packet = messages.find((message) =>
				message.content.startsWith("CONVERSATION_HANDOFF="),
			);
			handoff = packet
				? JSON.parse(packet.content.slice("CONVERSATION_HANDOFF=".length))
				: null;
			return {
				action: "invoke",
				tool: "doc.write",
				arguments: { baseRevision: 0, title: "一覧", content: movies },
				text: "下書きを作りました。",
			};
		},
	});
	try {
		await h.conversation.append({
			conversationId: "main",
			role: "user",
			text: "対象は検証劇場、日付を選んで作品別に確認したい",
			id: crypto.randomUUID(),
			runId: null,
			createdAt: new Date().toISOString(),
		});
		await h.propose("先ほどの条件でアプリを作って");
		expect(JSON.stringify(handoff)).toContain("作品別に確認したい");
	} finally {
		await h.close();
	}
}, 10000);

test("legacy saved URLs resolve a retained original user message without inventing provenance", async () => {
	const request = "取得先は https://example.com/Foo_(bar)。一覧を作って";
	let revision = 0,
		editing = false;
	const draft = {
		...movies,
		workflow: {
			...movies.workflow,
			input: {
				...movies.workflow.input,
				fixed: {
					...movies.workflow.input.fixed,
					sourceUrl: "https://example.com/Foo_(bar)",
				},
			},
		},
	};
	const h = await fixture({
		request,
		draft,
		git: createGitObservation("/unused"),
		specialist: () => ({
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision: revision,
				title: "一覧",
				content: editing ? { ...draft, title: "新しい題名" } : draft,
			},
			text: "下書きを更新しました。",
		}),
	});
	try {
		const id = await h.create();
		const prior = (await h.source()).data.work;
		const original = h.store.read((db) =>
			h.dialogue.specialistOriginalRequestSourcesInTransaction(
				db,
				"main",
				request,
			),
		);
		expect(original).toHaveLength(1);
		await h.conversation.append({
			conversationId: "elsewhere",
			role: "user",
			text: request,
			id: crypto.randomUUID(),
			runId: null,
			createdAt: new Date().toISOString(),
		});
		await h.conversation.append({
			conversationId: "main",
			role: "assistant",
			text: request,
			id: crypto.randomUUID(),
			runId: null,
			createdAt: new Date().toISOString(),
		});
		await h.store.write((db) => {
			const apps = h.appRuntime!.apps,
				published = apps.app(db, id)!;
			saveRequestContext(db, "default", prior.workRef, null);
			apps.publish(db, {
				workRef: prior.workRef,
				draftRevision: prior.revision,
				expectedSavedRevision: 1,
				digest: "legacy",
				workflowRevision: published.workflowRevision,
				screenRevision: published.screenRevision,
			});
			expect(apps.storedApp(db, id)?.requestContext).toBeNull();
		});
		revision = (await h.source()).data.work.revision;
		editing = true;
		await h.propose("題名だけ変更してください");
		const changed = (await h.source()).data.work;
		expect(changed.rejected).toBeNull();
		expect(changed.confirmation).toBeTruthy();
		const sources = h.store.read(
			(db) =>
				h.appRuntime!.apps.draft(db, changed.workRef).requestContext!.sources,
		);
		expect(sources).toContainEqual({
			kind: "message",
			conversationId: "main",
			messageId: original[0]!.messageId,
			digest: original[0]!.digest,
		});
		await save(h);
		expect((await h.source(id)).data.viewing.savedRevision).toBe(3);
		await h.conversation.retract({ messageId: original[0]!.messageId });
		expect(
			h.store.read((db) =>
				h.dialogue.specialistOriginalRequestSourcesInTransaction(
					db,
					"main",
					request,
				),
			),
		).toEqual([]);
	} finally {
		await h.close();
	}
}, 15000);
