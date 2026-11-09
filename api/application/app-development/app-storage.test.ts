import { expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLiveLarm } from "../../../scripts/live-larm";
import { createGitObservation } from "../../domains/git-observation";
import { workflowRunInTransaction } from "../../domains/pipelines";
import { workflowRefs } from "./workflow-operations";
import { waitFor } from "../../infrastructure/wait-for";
import { artifact, fixture } from "./app-development.fixture";

const readingRequest =
	"読んだ本の題名と感想を記録してあとから編集できるアプリを作ってください";
const readingNotes = {
	version: 1,
	title: "読書メモ",
	schemas: [
		{
			name: "reading-note",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["title"],
				properties: {
					title: {
						type: "string",
						title: "題名",
						minLength: 1,
						maxLength: 120,
					},
					memo: { type: "string", title: "感想", maxLength: 4000 },
				},
			},
		},
	],
	storage: {
		version: 1,
		collections: [
			{
				id: "notes",
				schema: "reading-note",
				operations: ["list", "get", "create", "update", "delete"],
			},
		],
	},
	screen: {
		definition: {
			view: "form",
			title: "本を記録",
			fields: [
				{ id: "title", label: "題名", type: "text", required: true },
				{ id: "memo", label: "感想", type: "textarea" },
			],
		},
		storage: { collection: "notes", inputs: { title: "title", memo: "memo" } },
	},
};

test("a missing record schema is reported at the collection reference before creating SQLite", async () => {
	const draft = {
		...readingNotes,
		storage: {
			version: 1,
			collections: [
				{ ...readingNotes.storage.collections[0], schema: "absent" },
			],
		},
	};
	const h = await fixture({
		request: readingRequest,
		draft,
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose(readingRequest);
		const { work } = (await h.source()).data;
		expect(work.confirmation).toBeNull();
		expect(work.rejected.issues).toEqual([
			{
				path: "storage.collections.0.schema",
				rule: "app_storage_schema_missing",
				detail: expect.stringContaining("reading-note"),
			},
		]);
		expect(existsSync(join(h.dir, "app-storage"))).toBe(false);
	} finally {
		await h.close();
	}
}, 10000);

test("a record form without its storage binding identifies the missing field", async () => {
	const draft = {
		...readingNotes,
		screen: { definition: readingNotes.screen.definition },
	};
	const h = await fixture({
		request: readingRequest,
		draft,
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose(readingRequest);
		const { work } = (await h.source()).data;
		expect(work.confirmation).toBeNull();
		expect(work.rejected.issues).toEqual([
			{
				path: "screen.storage",
				rule: "app_storage_screen_required",
				detail: expect.stringContaining("collection"),
			},
		]);
		expect(existsSync(join(h.dir, "app-storage"))).toBe(false);
	} finally {
		await h.close();
	}
}, 10000);

test("record apps isolate their SQLite files, validate writes and delete only the confirmed app", async () => {
	const h = await fixture({
		request: readingRequest,
		draft: readingNotes,
		git: createGitObservation("/unused"),
	});
	try {
		const id = await h.create();
		const { session } = await (
			await h.request("/api/conversations/main/specialist")
		).json();
		await h.dialogue.specialistCommand(session.id, "close", {
			requestId: crypto.randomUUID(),
			expectedRevision: session.revision,
		});
		const other = await h.create();
		expect(id).not.toBe(other);
		const dirs = (appId: string) =>
			h.store.read((db) => {
				const state = h.appRuntime!.apps.storage.get(db, appId);
				return join(h.dir, "app-storage", state!.storageId!);
			});
		const dbPath = dirs(id);
		const otherPath = dirs(other);
		expect(existsSync(join(dbPath, "app.sqlite"))).toBe(true);
		expect(existsSync(join(otherPath, "app.sqlite"))).toBe(true);
		const write = (
			appId: string,
			payload: unknown,
			eventId?: string,
			status?: string,
		) =>
			h.action(
				"storage-record",
				{
					appId,
					revision: "1",
					collection: "notes",
					record: JSON.stringify(payload),
				},
				appId,
				eventId,
				status,
			);
		const eventId = crypto.randomUUID();
		const confidential = "private_fixture_reading_note";
		const create = {
			operation: "create",
			values: { title: "本A", memo: confidential },
		};
		await write(id, create, eventId);
		await write(id, create, eventId);
		await write(other, { operation: "create", values: { title: "本B" } });
		const first = (await h.source(id)).data.viewing.storage;
		expect(first.rows).toHaveLength(1);
		expect(first.rows[0].values).toEqual(create.values);
		const log = h.store.read((db) =>
			db
				.query<{ canonical_input_json: string }, [string]>(
					"SELECT canonical_input_json FROM tool_action_requests WHERE event_id=?",
				)
				.get(eventId),
		);
		expect(log!.canonical_input_json).not.toContain(confidential);
		const row = first.rows[0];
		await write(id, {
			operation: "update",
			id: row.id,
			expectedRevision: 1,
			values: { title: "本A 改訂" },
		});
		expect(
			(
				await write(
					id,
					{
						operation: "update",
						id: row.id,
						expectedRevision: 1,
						values: { title: "古い版" },
					},
					undefined,
					"rejected",
				)
			).errorCode,
		).toBe("app_storage_record_conflict");
		expect(
			(
				await write(
					id,
					{ operation: "create", values: { title: 5 } },
					undefined,
					"rejected",
				)
			).errorCode,
		).toBe("app_storage_record_invalid");
		const params = encodeURIComponent(
			JSON.stringify({
				revision: 1,
				collection: "notes",
				request: { operation: "get", id: row.id },
			}),
		);
		const result = await h.request(
			`/api/toolchain-artifacts/${artifact}/sources/app-records?target=${id}&params=${params}`,
		);
		expect(result.status).toBe(200);
		expect((await result.json()).data).toMatchObject({
			revision: 2,
			values: { title: "本A 改訂" },
		});
		const digest = (await h.source(id)).data.viewing.deleteDigest;
		expect(
			(
				await h.action(
					"app-delete",
					{ appId: id, revision: "1", digest: "0".repeat(64) },
					id,
					undefined,
					"rejected",
				)
			).errorCode,
		).toBe("app_revision_conflict");
		// A symlink forces the asynchronous deletion to fail with the file still present.
		const blocked = join(dbPath, "blocked");
		symlinkSync(otherPath, blocked);
		const deletion = { appId: id, revision: "1", digest };
		await h.action("app-delete", deletion, id);
		await waitFor(
			async () =>
				(await h.source(id)).data.viewing?.storageError ===
				"app_storage_path_invalid",
		);
		expect(existsSync(join(dbPath, "app.sqlite"))).toBe(true);
		expect((await h.source(id)).data.history).toContainEqual(
			expect.objectContaining({ id, storageState: "deleting" }),
		);
		expect((await write(id, create, undefined, "rejected")).errorCode).toBe(
			"app_revision_conflict",
		);
		rmSync(blocked);
		writeFileSync(join(dbPath, "app.sqlite-wal"), "");
		writeFileSync(join(dbPath, "app.sqlite-shm"), "");
		await h.action("app-delete", deletion, id);
		await waitFor(async () => (await h.source(id)).data.viewing === null);
		expect(existsSync(dbPath)).toBe(false);
		expect(
			(await h.source(id)).data.history.map((item: { id: string }) => item.id),
		).toEqual([other]);
		expect((await h.source(other)).data.viewing.storage.rows[0].values).toEqual(
			{ title: "本B" },
		);
		expect(readdirSync(join(h.dir, "app-storage"))).toHaveLength(1);
	} finally {
		await h.close();
	}
}, 25000);

test("workflow reads publish record references and app deletion stops its schedule and admitted runs", async () => {
	const draft = {
		...readingNotes,
		screen: {
			...readingNotes.screen,
			definition: {
				view: "layout",
				children: [
					readingNotes.screen.definition,
					{ view: "data-table", columns: [{ header: "記録ID" }], rows: [[""]] },
				],
			},
			bindings: {
				inputs: {},
				table: { path: [1], rowsKey: "records", columns: ["id"] },
			},
		},
		workflow: {
			version: 1,
			trigger: "schedule",
			input: {
				schemaRef: workflowRefs.storageInput,
				fixed: { collection: "notes", operation: "list" },
			},
			pipeline: {
				request: readingRequest,
				steps: [
					{
						id: "refs",
						bundle: "storage.records",
						from: ["request"],
						task: "保存済み記録を照会",
						result: "記録参照",
					},
				],
				output: { from: ["refs"], deliver: "記録参照の一覧" },
			},
			publish: {
				kind: "dataset",
				from: "refs",
				schemaRef: workflowRefs.storageReferences,
			},
		},
	};
	const h = await fixture({
		request: readingRequest,
		draft,
		git: createGitObservation("/unused"),
	});
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
					values: { title: "記録の本文" },
				}),
			},
			id,
		);
		const base = { appId: id, revision: "1" };
		const values = { ...base, values: "{}" };
		await h.action("run", values, id);
		const result = await h.completed(id);
		const { viewing } = (await h.source(id)).data;
		expect(result.result.value).toEqual({
			collection: "notes",
			hasMore: false,
			records: [{ id: viewing.storage.rows[0].id, revision: 1 }],
		});
		await h.action(
			"schedule",
			{ ...base, anchor: new Date(Date.now() + 3600000).toISOString() },
			id,
		);
		const { schedule } = (await h.source(id)).data.viewing.status;
		const submitted = await h.action("run", values, id);
		const active = submitted.result.receipt.runId;
		await h.action("app-delete", { ...base, digest: viewing.deleteDigest }, id);
		await waitFor(async () => (await h.source(id)).data.viewing === null);
		expect(
			h.store.read(
				(db) => h.scheduler.getInTransaction(db, schedule.id)?.state,
			),
		).toBe("cancelled");
		expect(
			h.store.read(
				(db) => workflowRunInTransaction(db, "default", active)?.state,
			),
		).toBe("cancelled");
		expect(readdirSync(join(h.dir, "app-storage"))).toEqual([]);
	} finally {
		await h.close();
	}
}, 20000);

const liveEnabled = process.env.EUMENES_APP_WORKFLOW_LIVE === "1";

test.skipIf(!liveEnabled)(
	"live real LLM authors, saves and deletes a persistent reading app",
	async () => {
		const model = createLiveLarm(process.env, { agentSessions: true });
		const h = await fixture({
			request: readingRequest,
			draft: null,
			git: createGitObservation("/unused"),
			live: { model },
		});
		try {
			const id = await h.create(2);
			const { viewing } = (await h.source(id)).data;
			expect(viewing.hasStorage).toBe(true);
			const { storage } = viewing;
			expect(storage.operations).toEqual(
				expect.arrayContaining(["list", "create", "update"]),
			);
			const fields = viewing.storedDefinition.screen.definition;
			const form = (node: {
				view?: string;
				children?: unknown[];
			}): { fields: Array<{ id: string; label: string }> } | undefined =>
				node.view === "form"
					? (node as never)
					: node.children?.flatMap(
							(child) => form(child as typeof node) ?? [],
						)[0];
			const fieldsByName = form(fields)!.fields;
			const key = (label: RegExp) =>
				storage.inputs[
					fieldsByName.find((field) => label.test(field.label))?.id ?? ""
				];
			const title = key(/題名|タイトル|書名|本の名前/);
			const memo = key(/感想/);
			expect(title && memo).toBeTruthy();
			const write = (record: unknown) =>
				h.action(
					"storage-record",
					{
						appId: id,
						revision: "1",
						collection: storage.collection,
						record: JSON.stringify(record),
					},
					id,
				);
			await write({
				operation: "create",
				values: { [title]: "銀河鉄道の夜", [memo]: "読了後のメモ" },
			});
			const [row] = (await h.source(id)).data.viewing.storage.rows;
			expect(row.values[title]).toBe("銀河鉄道の夜");
			await write({
				operation: "update",
				id: row.id,
				expectedRevision: row.revision,
				values: { ...row.values, [memo]: "読み返した感想" },
			});
			expect(
				(await h.source(id)).data.viewing.storage.rows[0].values[memo],
			).toBe("読み返した感想");
			const root = join(h.dir, "app-storage");
			expect(readdirSync(root)).toHaveLength(1);
			await h.action(
				"app-delete",
				{ appId: id, revision: "1", digest: viewing.deleteDigest },
				id,
			);
			await waitFor(async () => (await h.source(id)).data.viewing === null);
			expect(readdirSync(root)).toEqual([]);
			console.log(
				JSON.stringify({
					phase: "live_reading_app_verified",
					appId: id,
					created: true,
					updated: true,
					deleted: true,
				}),
			);
		} finally {
			await h.close();
		}
	},
	600000,
);
