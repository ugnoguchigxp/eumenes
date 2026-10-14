import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../domains/tool-runtime";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createTtsDictionaryAdapter,
	describeTtsDictionaryAdapter,
	TTS_DICTIONARY_ADAPTER_REF,
} from "./tts-dictionary-adapter";
import { bundleHostOf, hostAdapterDescriptions } from "./toolchain-adapters";

const bundleFile = join(
	import.meta.dir,
	"../domains/capabilities/bundles/settings-dictionary.bundle.json",
);
const host = () =>
	bundleHostOf([
		...hostAdapterDescriptions,
		{
			ref: TTS_DICTIONARY_ADAPTER_REF,
			describe: describeTtsDictionaryAdapter,
		},
	]);

let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	dir = mkdtempSync(join(tmpdir(), "tts-dictionary-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const dictionary = createTtsDictionary(store);
	const adapter = createTtsDictionaryAdapter(dictionary);
	return { store, dictionary, adapter };
}
type Harness = ReturnType<typeof setup>;

function invoke(
	h: Harness,
	operationName: string,
	input: unknown,
	origin: "ui" | "conversation" = "ui",
) {
	const requestId = crypto.randomUUID();
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
}
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const save = (h: Harness, written: string, spoken: string) =>
	invoke(h, "tts-dictionary.save", { written, spoken });
const update = (
	h: Harness,
	written: string,
	expectedSpoken: string,
	spoken: string,
) => invoke(h, "tts-dictionary.update", { written, expectedSpoken, spoken });
const page = (h: Harness, params?: unknown) =>
	h.store.read((db) =>
		h.adapter.sourceInTransaction(
			db,
			"query:tts-dictionary.entries@1",
			undefined,
			params,
		)!,
	);
const items = (h: Harness, params?: unknown) =>
	(
		page(h, params).data as {
			items: Array<{ written: string; spoken: string }>;
		}
	).items;

test("describe offers the entries query and the three writes, and the bundle imports with no issue", async () => {
	const d = describeTtsDictionaryAdapter();
	expect([...d.queries]).toEqual(["query:tts-dictionary.entries@1"]);
	expect(
		Object.fromEntries([...d.operations].map(([n, o]) => [n, o.effect])),
	).toEqual({
		"tts-dictionary.save": "write",
		"tts-dictionary.update": "write",
		"tts-dictionary.delete": "write",
	});
	const h = setup();
	const capabilities = createCapabilities(h.store, new Set(["web"]), {
		bundleHost: host,
	});
	const bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
	const result = await h.store.write((db) =>
		capabilities.importBundleInTransaction(db, bundle, host(), {
			dryRun: true,
		}),
	);
	expect(result.issues).toEqual([]);
});

test("save adds and never replaces; update changes the reading behind the expected reading", async () => {
	const h = setup();
	const added = await save(h, " 今日 ", "きょう");
	expect(added.replay).toBe(false);
	expect(added.receiptRef.owner).toBe("tts-dictionary");
	expect(JSON.stringify(added.receipt)).not.toContain("きょう");
	expect(items(h)).toEqual([{ written: "今日", spoken: "きょう" }]);
	// A registered headword is a conflict on create, even with another reading.
	expect(await codeOf(save(h, "今日", "こんにち"))).toBe("revision_conflict");
	expect(await codeOf(save(h, "今日", "きょう"))).toBe("revision_conflict");
	expect(items(h)[0]!.spoken).toBe("きょう");
	// Update is guarded by the reading the row showed.
	expect(await codeOf(update(h, "今日", "ちがう", "こんにち"))).toBe(
		"revision_conflict",
	);
	expect(items(h)[0]!.spoken).toBe("きょう");
	await update(h, "今日", "きょう", " こんにち ");
	expect(items(h)).toEqual([{ written: "今日", spoken: "こんにち" }]);
	expect(h.dictionary.apply("今日")).toBe("こんにち");
	// A stale row conflicts, a vanished row too. Repeating the saved result is the domain's no-op.
	expect(await codeOf(update(h, "今日", "きょう", "さん"))).toBe(
		"revision_conflict",
	);
	expect(await codeOf(update(h, "今日", "きょう", "こんにち"))).toBe(
		"no_error",
	);
	expect(await codeOf(update(h, "無い", "あ", "い"))).toBe("revision_conflict");
	expect(await codeOf(update(h, "今日", "こんにち", "あ\u0000い"))).toBe(
		"invalid_entry",
	);
	expect(await codeOf(update(h, "今日", "こんにち", "  "))).toBe(
		"invalid_entry",
	);
});

test("invalid entries and inputs are rejected with safe codes and save nothing", async () => {
	const h = setup();
	expect(await codeOf(save(h, "あ、い", "x"))).toBe("invalid_entry");
	expect(await codeOf(save(h, "   ", "x"))).toBe("invalid_entry");
	expect(await codeOf(invoke(h, "tts-dictionary.save", { written: "a" }))).toBe(
		"invalid_input",
	);
	expect(
		await codeOf(
			invoke(h, "tts-dictionary.save", { written: "a", spoken: "b", extra: 1 }),
		),
	).toBe("invalid_input");
	expect(items(h)).toEqual([]);
});

test("delete is guarded by the reading the row showed", async () => {
	const h = setup();
	await save(h, "A", "えー");
	const del = (expectedSpoken: string) =>
		invoke(h, "tts-dictionary.delete", { written: "A", expectedSpoken });
	expect(await codeOf(del("びー"))).toBe("revision_conflict");
	expect(items(h)).toHaveLength(1);
	await del("えー");
	expect(items(h)).toEqual([]);
	// Deleting what is already gone is a no-op, as in the domain.
	expect(await codeOf(del("えー"))).toBe("no_error");
});

test("conversation origin and unknown operations are unavailable", async () => {
	const h = setup();
	expect(
		await codeOf(invoke(h, "tts-dictionary.save", {}, "conversation")),
	).toBe("capability_unavailable");
	expect(await codeOf(invoke(h, "tts-dictionary.other", {}))).toBe(
		"capability_unavailable",
	);
});

test("the source pages, sorts and searches, and its revision follows the entries", async () => {
	const h = setup();
	for (let n = 0; n < 12; n++)
		await save(h, `語${String(n).padStart(2, "0")}`, n % 2 ? "おく" : "ひく");
	const first = page(h);
	expect(first.data).toMatchObject({ pageIndex: 0, pageSize: 10, total: 12 });
	expect(items(h).map((i) => i.written)[0]).toBe("語00");
	expect(items(h, { pageIndex: 1 })).toHaveLength(2);
	// A page past the end shows the last one.
	expect(page(h, { pageIndex: 9 }).data).toMatchObject({ pageIndex: 1 });
	expect(items(h, { desc: true })[0]!.written).toBe("語11");
	expect(items(h, { sort: "spoken", pageSize: 25 })[0]).toEqual({
		written: "語01",
		spoken: "おく",
	});
	expect(items(h, { q: "ひ" })).toHaveLength(6);
	expect(page(h, { q: "ひ" }).revision).toBe(first.revision);
	await save(h, "新", "しん");
	expect(page(h).revision).not.toBe(first.revision);
	expect(() => page(h, { pageSize: 7 })).toThrow("invalid_input");
	expect(() => page(h, { sort: "updated" })).toThrow("invalid_input");
});

test("the registered bundle saves and deletes through the action ledger", async () => {
	const h = setup();
	const capabilities = createCapabilities(h.store, new Set(["web"]), {
		bundleHost: host,
	});
	await capabilities.seed();
	const ledger = createActionRequests({
		store: h.store,
		capabilities,
		registry: createAdapterRegistry([h.adapter]),
		scope: "test-scope",
	});
	const send = (actionId: string, input: unknown, eventId?: string) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: eventId ?? crypto.randomUUID(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: "artifact:settings.dictionary@1",
			source: "dictionary-entries",
			sourceRevision: 0,
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	};
	const eventId = crypto.randomUUID();
	const input = { written: "今日", spoken: "きょう" };
	const first = await send("save", input, eventId);
	expect(first.request.status).toBe("accepted");
	expect(items(h)).toEqual([{ written: "今日", spoken: "きょう" }]);
	// The same event again is the ledger's replay: same answer, no second write.
	const again = await send("save", input, eventId);
	expect(again.replay).toBe(true);
	expect(again.request.status).toBe("accepted");
	// A new event for the same headword with another reading is a conflict.
	const clash = await send("save", { written: "今日", spoken: "こんにち" });
	expect(clash.request.errorCode).toBe("revision_conflict");
	// The row edit form sends the row's headword and shown reading with the new reading.
	const stale0 = await send("edit", {
		written: "今日",
		expectedSpoken: "x",
		spoken: "こんにち",
	});
	expect(stale0.request.errorCode).toBe("revision_conflict");
	const edited = await send("edit", {
		written: "今日",
		expectedSpoken: "きょう",
		spoken: "こんにち",
	});
	expect(edited.request.status).toBe("accepted");
	expect(items(h)).toEqual([{ written: "今日", spoken: "こんにち" }]);
	// Row delete with a stale reading conflicts; with the shown reading it succeeds.
	const stale = await send("delete", { written: "今日", expectedSpoken: "x" });
	expect(stale.request.errorCode).toBe("revision_conflict");
	expect(items(h)).toHaveLength(1);
	const deleted = await send("delete", {
		written: "今日",
		expectedSpoken: "こんにち",
	});
	expect(deleted.request.status).toBe("accepted");
	expect(items(h)).toEqual([]);
	// Fields outside the registered schema never reach the adapter.
	await expect(
		send("save", { written: "a", spoken: "b", path: "$.x" }),
	).rejects.toThrow("invalid_input");
	expect(items(h)).toEqual([]);
});
