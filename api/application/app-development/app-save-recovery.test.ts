import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitObservation } from "../../domains/git-observation";
import { waitFor } from "../../infrastructure/wait-for";
import { fixture, movies, date } from "./app-development.fixture";
import type { SaveTicket } from "./save-recovery";
import { readingNotes } from "./app-records.fixture";

type Harness = Awaited<ReturnType<typeof fixture>>;
const input = (ticket: SaveTicket) => ({
	...ticket,
	stateRevision: String(ticket.stateRevision),
});
async function save(h: Harness) {
	const w = (await h.source()).data.work;
	return h.action("save", {
		workRef: w.workRef,
		expectedRevision: String(w.revision),
		expectedSavedRevision: String(w.savedRevision),
		digest: w.confirmation.digest,
	});
}
async function failed(h: Harness) {
	await waitFor(async () => !!(await h.source()).data.work.reopenSave);
	return (await h.source()).data.work;
}
async function editable(h: Harness) {
	await waitFor(async () => !(await h.source()).data.work.storageState);
	return (await h.source()).data.work;
}

const url = "https://example.com/Foo_(bar)";
const composite = {
	...movies,
	schemas: readingNotes.schemas,
	storage: readingNotes.storage,
	screen: {
		definition: { view: "grouped-list", groups: [] },
		bindings: {
			inputs: {},
			sections: { ...movies.screen.bindings.sections, path: [] },
		},
	},
	workflow: {
		...movies.workflow,
		input: {
			...movies.workflow.input,
			fixed: { ...movies.workflow.input.fixed, date, sourceUrl: url },
		},
	},
};

test("a revoked initial save can reopen without publishing, then be edited and confirmed again", async () => {
	const h = await fixture({
		request: `${url} の一覧と記録を保存するアプリ`,
		draft: composite,
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose(`${url} の一覧と記録を保存するアプリ`);
		const root = join(h.dir, "app-storage");
		writeFileSync(root, "fault");
		await save(h);
		const w = await failed(h),
			ticket = input(w.reopenSave);
		rmSync(root);
		h.appRuntime!.attachDialogue({
			...h.dialogue,
			specialistMessageSourceInTransaction: () => null,
		});
		expect(
			(await h.action("retry-save", ticket, undefined, undefined, "rejected"))
				.errorCode,
		).toBe("workflow_pipeline_invalid");
		const eventId = crypto.randomUUID();
		await h.action("reopen-save", ticket, undefined, eventId);
		await h.action("reopen-save", ticket, undefined, eventId);
		const reopened = await editable(h);
		expect(reopened.savedRevision).toBe(0);
		expect((await h.source(ticket.appId)).data.viewing).toBeNull();
		const state = h.store.read((db) =>
			h.appRuntime!.apps.storage.get(db, ticket.appId)!,
		);
		expect(state).toMatchObject({
			operationId: null,
			jobId: null,
			saveJson: null,
			storageId: null,
			storageRevision: 0,
		});
		expect(existsSync(root)).toBe(false);
		await h.action("retry-save", ticket, undefined, undefined, "rejected");
		await h.action("reopen-save", ticket, undefined, undefined, "rejected");
		await h.action("source", {
			workRef: reopened.workRef,
			expectedRevision: String(reopened.revision),
			text: JSON.stringify({ ...composite, title: "修正した案" }),
		});
		await save(h);
		await waitFor(
			async () =>
				(await h.source(ticket.appId)).data.viewing?.savedRevision === 1,
		);
		expect((await h.source(ticket.appId)).data.viewing.title).toBe(
			"修正した案",
		);
	} finally {
		await h.close();
	}
}, 20000);

test("a displayed app cannot retry or reopen another app's failed save", async () => {
	const h = await fixture({
		request: "読書メモを作って",
		draft: readingNotes,
		git: createGitObservation("/unused"),
	});
	try {
		const a = await h.create();
		h.appRuntime!.attachDialogue({
			...h.dialogue,
			specialistSessionLiveInTransaction: () => true,
		});
		const b = await h.store.write((db) => {
			const apps = h.appRuntime!.apps;
			const opened = apps.open(db, {
				sessionId: crypto.randomUUID(),
				targetRef: null,
			});
			apps.commit(db, opened.workRef, {
				revision: 0,
				value: { ...readingNotes, title: "作業B" },
			});
			return apps.draft(db, opened.workRef);
		});
		let directory = "";
		await h.store.write((db) => {
			const w = h.appRuntime!.apps.draft(db, b.id);
			const op = crypto.randomUUID();
			const source = h.appRuntime!.adapter.sourceInTransaction(
				db,
				"query:app-development.studio@2",
				undefined,
				{},
			) as { data: { work: { confirmation: { digest: string } } } };
			h.appRuntime!.adapter.invokeInTransaction(db, {
				requestId: op,
				issuedAt: new Date().toISOString(),
				operationName: "app-development.save",
				origin: { kind: "ui", scope: "default", actionRequestId: op },
				input: {
					workRef: w.id,
					expectedRevision: w.revision,
					expectedSavedRevision: 0,
					digest: source.data.work.confirmation.digest,
				},
			});
			directory = join(
				h.dir,
				"app-storage",
				h.appRuntime!.apps.storage.get(db, b.appId)!.storageId!,
			);
			writeFileSync(directory, "fault");
		});
		const ticket = input((await failed(h)).reopenSave);
		rmSync(directory);
		for (const action of ["retry-save", "reopen-save"])
			expect(
				(await h.action(action, ticket, a, undefined, "rejected")).errorCode,
			).toBe("app_target_mismatch");
		expect((await h.source(a)).data.viewing.savedRevision).toBe(1);
		const oldWork = h.store.read(
			(db) =>
				(
					h.appRuntime!.adapter.sourceInTransaction(
						db,
						"query:app-development.studio@1",
						undefined,
						{},
					) as { data: { work: Record<string, unknown> } }
				).data.work,
		);
		expect(oldWork.retrySave).toBeTruthy();
		expect(oldWork.reopenSave).toBeUndefined();
		await h.action("reopen-save", ticket);
		await editable(h);
		await h.store.write((db) => h.appRuntime!.apps.end(db, b.id, "discard"));
		expect(h.store.read((db) => h.appRuntime!.apps.state(db, b.id))).toBeNull();
	} finally {
		await h.close();
	}
}, 20000);

test("reopening an upgrade retains records, reconciles the physical version and invalidates the failed approval", async () => {
	const h = await fixture({
		request: "読書メモを作って",
		draft: readingNotes,
		git: createGitObservation("/unused"),
	});
	const adapter = h.appRuntime!.adapter,
		publish = adapter.finishSave;
	try {
		const id = await h.create();
		await h.action(
			"storage-record",
			{
				appId: id,
				revision: "1",
				collection: "notes",
				record: JSON.stringify({
					operation: "create",
					values: { title: "保存済みの本", memo: "元の感想" },
				}),
			},
			id,
		);
		const original = (await h.source(id)).data.viewing.storage.rows;
		const upgraded = {
			...readingNotes,
			schemas: [
				{
					...readingNotes.schemas[0],
					schema: {
						...readingNotes.schemas[0]!.schema,
						properties: {
							...readingNotes.schemas[0]!.schema.properties,
							extra: { type: "string", maxLength: 100 },
						},
					},
				},
			],
		};
		const w = (await h.source()).data.work;
		await h.action("source", {
			workRef: w.workRef,
			expectedRevision: String(w.revision),
			text: JSON.stringify(upgraded),
		});
		adapter.finishSave = () => {
			throw new Error("publication_fixture_fault");
		};
		await save(h);
		const ticket = input((await failed(h)).reopenSave);
		await h.appRuntime!.recover();
		expect((await h.source()).data.work.reopenSave.stateRevision).toBe(
			Number(ticket.stateRevision),
		);
		adapter.finishSave = publish;
		await h.action("reopen-save", ticket, id);
		await editable(h);
		const app = (await h.source(id)).data.viewing;
		expect(app.savedRevision).toBe(1);
		expect(app.storage.rows).toEqual(original);
		expect(
			h.store.read((db) => h.appRuntime!.apps.storage.get(db, id)),
		).toMatchObject({
			storageRevision: 2,
			operationId: null,
			saveJson: null,
			preparedPlanJson: expect.any(String),
		});
		const reopened = (await h.source()).data.work;
		expect(
			(
				await h.action(
					"source",
					{
						workRef: reopened.workRef,
						expectedRevision: String(reopened.revision),
						text: JSON.stringify(readingNotes),
					},
					undefined,
					undefined,
					"rejected",
				)
			).errorCode,
		).toBe("app_storage_migration_incompatible");
		await save(h);
		await waitFor(
			async () => (await h.source(id)).data.viewing?.savedRevision === 2,
		);
		expect((await h.source(id)).data.viewing.storage.rows).toEqual(original);
		await h.action("retry-save", ticket, id, undefined, "rejected");
		await h.action("reopen-save", ticket, id, undefined, "rejected");
		expect(
			h.store.read((db) => h.appRuntime!.apps.storage.get(db, id)),
		).toMatchObject({ storageRevision: 3, preparedPlanJson: null });
	} finally {
		adapter.finishSave = publish;
		await h.close();
	}
}, 20000);
