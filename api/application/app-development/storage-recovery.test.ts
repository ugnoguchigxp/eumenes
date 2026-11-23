import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appDraft,
	createAppDevelopment,
	createAppStorageFiles,
} from "../../domains/app-development";
import { compileJsonSchemaSubset } from "../../domains/capabilities";
import { createQueue } from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";
import { waitFor } from "../../infrastructure/wait-for";
import { migrations } from "../migrations";
import {
	createAppStorageRuntime,
	deletionDigest,
	storagePlan,
} from "./storage-runtime";

const draft = appDraft.parse({
	version: 1,
	title: "記録帳",
	screen: { definition: { view: "text-block", title: "記録帳" } },
	schemas: [
		{
			name: "note",
			schema: {
				type: "object",
				required: ["title"],
				additionalProperties: false,
				properties: { title: { type: "string", maxLength: 100 } },
			},
		},
	],
	storage: {
		version: 1,
		collections: [
			{ id: "notes", schema: "note", operations: ["list", "create"] },
		],
	},
});

test("storage lifecycle replays after interruption before creation, after migration, and after unlink", async () => {
	const dir = mkdtempSync(join(tmpdir(), "app-storage-recovery-"));
	const database = join(dir, "main.sqlite");
	const root = join(dir, "app-storage");
	const apps = createAppDevelopment("owner");
	const files = createAppStorageFiles(root, compileJsonSchemaSubset);
	const open = () => {
		const store = openStore(database, migrations);
		const queue = createQueue(store, { pollMs: 10 });
		const runtime = createAppStorageRuntime({
			apps,
			store,
			queue,
			root,
			workflow: () => ({ stopForDeletion() {} }),
			publish: (db, _operation, save) =>
				apps.publish(db, {
					workRef: save.workRef,
					draftRevision: save.expectedRevision,
					expectedSavedRevision: save.expectedSavedRevision,
					digest: save.digest,
					workflowRevision: null,
					screenRevision: null,
				}),
		});
		return {
			store,
			runtime,
			async start() {
				await queue.recover();
				await runtime.recover();
				queue.start();
			},
			async close() {
				await queue.close();
				await store.close();
			},
		};
	};
	let instance = open();
	const get = (appId: string) =>
		instance.store.read((db) => apps.storage.get(db, appId)!);
	const state = (appId: string) => get(appId).state;
	const plan = storagePlan(draft)!;
	try {
		const { appId, workId } = await instance.store.write((db) => {
			const opened = apps.open(db, {
				sessionId: crypto.randomUUID(),
				targetRef: null,
			});
			const work = apps.draft(db, opened.workRef);
			const { revision } = apps.commit(db, work.id, {
				revision: 0,
				value: draft,
			});
			instance.runtime.save(db, work.appId, crypto.randomUUID(), {
				workRef: work.id,
				expectedRevision: revision,
				expectedSavedRevision: 0,
				digest: "first",
				plan,
			});
			return { appId: work.appId, workId: work.id };
		});
		const storageId = get(appId).storageId!;
		const directory = join(root, storageId);
		expect(state(appId)).toBe("initializing");
		expect(existsSync(directory)).toBe(false);
		await instance.close();
		instance = open();
		await instance.start();
		await waitFor(() => state(appId) === "active");
		const otherId = crypto.randomUUID();
		await files.initialize(otherId, 0, 1, plan);
		files.records(
			otherId,
			1,
			plan.collections[0]!,
			{ operation: "create", values: { title: "別の記録" } },
			crypto.randomUUID(),
			"other",
		);
		await instance.store.write((db) => {
			const app = apps.app(db, appId)!;
			instance.runtime.records(
				db,
				app,
				"notes",
				{ operation: "create", values: { title: "再起動前の記録" } },
				crypto.randomUUID(),
			);
		});
		await instance.close();
		instance = open();
		const modified = appDraft.parse({
			...draft,
			schemas: [
				{
					...draft.schemas[0],
					schema: {
						...draft.schemas[0]!.schema,
						properties: {
							title: { type: "string", maxLength: 100 },
							memo: { type: "string", maxLength: 100 },
						},
					},
				},
			],
		});
		const modifiedPlan = storagePlan(modified)!;
		await instance.store.write((db) => {
			const work = apps.draft(db, workId);
			const { revision } = apps.commit(db, workId, {
				revision: work.revision,
				value: modified,
			});
			instance.runtime.save(db, appId, crypto.randomUUID(), {
				workRef: workId,
				expectedRevision: revision,
				expectedSavedRevision: 1,
				digest: "second",
				plan: modifiedPlan,
			});
		});
		await files.initialize(storageId, 1, 2, modifiedPlan);
		await instance.close();
		instance = open();
		await instance.start();
		await waitFor(() => state(appId) === "active");
		expect(
			instance.store.read((db) =>
				instance.runtime.records(db, apps.app(db, appId)!, "notes", {
					operation: "list",
				}),
			),
		).toMatchObject({ rows: [{ values: { title: "再起動前の記録" } }] });
		expect(get(appId).storageId).toBe(storageId);
		await instance.close();
		instance = open();
		await instance.store.write((db) => {
			const app = apps.app(db, appId)!;
			instance.runtime.delete(
				db,
				appId,
				2,
				deletionDigest(app),
				crypto.randomUUID(),
			);
		});
		writeFileSync(join(directory, "app.sqlite-wal"), "");
		writeFileSync(join(directory, "app.sqlite-shm"), "");
		files.remove(storageId);
		expect(state(appId)).toBe("deleting");
		await instance.close();
		instance = open();
		await instance.start();
		await waitFor(() => state(appId) === "deleted");
		expect(existsSync(directory)).toBe(false);
		expect(instance.store.read((db) => apps.storedApp(db, appId))).toBeNull();
		expect(
			files.records(
				otherId,
				1,
				plan.collections[0]!,
				{ operation: "list" },
				"",
				"",
			),
		).toMatchObject({
			rows: [{ values: { title: "別の記録" } }],
		});
		const missing = join(root, otherId, "app.sqlite");
		rmSync(missing);
		expect(() =>
			files.records(
				otherId,
				1,
				plan.collections[0]!,
				{ operation: "list" },
				"",
				"",
			),
		).toThrow("app_storage_file_missing");
		expect(existsSync(missing)).toBe(false);
	} finally {
		await instance.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reopening is guarded against active jobs and replays after unpublished files were removed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "app-reopen-recovery-"));
	const database = join(dir, "main.sqlite"),
		root = join(dir, "app-storage");
	const apps = createAppDevelopment("owner"),
		files = createAppStorageFiles(root, compileJsonSchemaSubset);
	const plan = storagePlan(draft)!;
	const open = () => {
		const store = openStore(database, migrations),
			queue = createQueue(store, { pollMs: 10 });
		const runtime = createAppStorageRuntime({
			store,
			queue,
			apps,
			root,
			workflow: () => ({ stopForDeletion() {} }),
			publish: () => {
				throw new Error("reopen_must_not_publish");
			},
		});
		return {
			store,
			queue,
			runtime,
			async close() {
				await queue.close();
				await store.close();
			},
		};
	};
	let h = open();
	const get = (id: string) => h.store.read((db) => apps.storage.get(db, id)!);
	try {
		const work = await h.store.write((db) => {
			const opened = apps.open(db, {
				sessionId: crypto.randomUUID(),
				targetRef: null,
			});
			apps.commit(db, opened.workRef, { revision: 0, value: draft });
			const w = apps.draft(db, opened.workRef);
			h.runtime.save(db, w.appId, crypto.randomUUID(), {
				workRef: w.id,
				expectedRevision: w.revision,
				expectedSavedRevision: 0,
				digest: "approval",
				plan,
			});
			apps.storage.error(
				db,
				apps.storage.get(db, w.appId)!,
				"app_storage_setup_failed",
			);
			return w;
		});
		const ticket = () => ({
			appId: work.appId,
			operationId: get(work.appId).operationId!,
			stateRevision: get(work.appId).stateRevision,
			digest: "approval",
		});
		await expect(
			h.store.write((db) =>
				h.runtime.reopen(db, ticket(), crypto.randomUUID()),
			),
		).rejects.toThrow("app_operation_pending");
		const before = get(work.appId),
			oldJob = before.jobId!;
		await files.initialize(before.storageId!, 0, 1, plan);
		await h.store.write((db) =>
			h.queue.cancelInTransaction(db, oldJob, "fixture_stop"),
		);
		const approval = ticket();
		await expect(
			h.store.write((db) =>
				h.runtime.reopen(
					db,
					{ ...approval, stateRevision: approval.stateRevision - 1 },
					crypto.randomUUID(),
				),
			),
		).rejects.toThrow("app_storage_retry_conflict");
		await expect(
			h.store.write((db) =>
				h.runtime.reopen(
					db,
					{ ...approval, digest: "changed" },
					crypto.randomUUID(),
				),
			),
		).rejects.toThrow("revision_conflict");
		await h.store.write((db) =>
			h.runtime.reopen(db, approval, crypto.randomUUID()),
		);
		const entry = get(work.appId);
		// Interrupt after the irreversible file removal, before the owner transaction settles it.
		files.remove(entry.storageId!);
		await h.close();
		h = open();
		await h.queue.recover();
		await h.runtime.recover();
		h.queue.start();
		await waitFor(() => get(work.appId).state === "active");
		expect(get(work.appId)).toMatchObject({
			storageId: null,
			storageRevision: 0,
			jobId: null,
			operationId: null,
			saveJson: null,
			reopening: 0,
		});
		expect(h.store.read((db) => apps.storedApp(db, work.appId))).toBeNull();
		expect(
			h.store.read((db) => h.queue.getInTransaction(db, oldJob)?.state),
		).toBe("cancelled");
		await expect(
			h.store.write((db) => h.runtime.retry(db, approval, crypto.randomUUID())),
		).rejects.toThrow("app_storage_retry_conflict");
		await h.store.write((db) => apps.end(db, work.id, "discard"));
		expect(h.store.read((db) => apps.state(db, work.id))).toBeNull();
		const id = crypto.randomUUID();
		await files.initialize(id, 0, 1, plan);
		expect(files.preparedRevision(id, 1)).toBe(1);
		await files.initialize(id, 1, 2, plan);
		expect(files.preparedRevision(id, 1)).toBe(2);
		await files.initialize(id, 2, 3, plan);
		expect(() => files.preparedRevision(id, 1)).toThrow(
			"app_storage_revision_conflict",
		);
		files.remove(id);
		expect(() => files.preparedRevision(id, 1)).toThrow(
			"app_storage_file_missing",
		);
	} finally {
		await h.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
