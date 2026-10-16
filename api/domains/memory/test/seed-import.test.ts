import { afterEach, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { memoryClient } from "../../../../client/memory";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService } from "..";
import {
	memorySeedInputSchema,
	parseMemorySeedJsonl,
	seedStateText,
	type MemorySeed,
} from "../contracts";
import { registerMemory } from "../controller";
import {
	setupMemory,
	memoryTestMigrations,
	type MemoryHarness,
} from "./memory.fixture";

const open: MemoryHarness[] = [];
const extra: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of extra.splice(0)) await close();
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}
// Synthetic candidate data only. Real personal Seed data never becomes a test fixture.
function seed(
	id: string,
	target: MemorySeed["proposed_target"] = "state",
): MemorySeed {
	const quote = "旅行の相談では徒歩の移動を好みます";
	return {
		schema_version: 1,
		id,
		status: "candidate",
		category: "移動",
		subject: "self",
		semantic_key: `travel.${id}`,
		memory: quote,
		scope: "旅行の相談",
		evidence_basis: "inferred",
		confidence: "medium",
		proposed_target: target,
		proposed_state_kind: target === "state" ? "preference" : null,
		proposed_state_origin: target === "state" ? "agent_inferred" : null,
		use_when: "旅程を考えるとき",
		limitations: "現在の希望を優先する",
		review: { after_days: 30, on: "本人の訂正時" },
		evidence: [
			{
				evidence_id: `e-${id}`,
				thread_id: "external-thread",
				message_id: "external-message",
				timestamp: "2026-10-01T00:00:00Z",
				speaker: "user",
				source_path: "/not-read/external.jsonl",
				source_line: 1,
				source_text_sha256: "a".repeat(64),
				range_utf8: { start: 0, end: Buffer.byteLength(quote) },
				quote,
			},
		],
	};
}
const sources = (h: MemoryHarness) =>
	h.store.read((db) => db.query("SELECT * FROM memory_seed_source").all());
const receipt = (h: MemoryHarness) =>
	h.store.read((db) => db.query("SELECT * FROM memory_seed_import").all());

test("public API preview/import is additive, preserves settings and identity, and distinguishes candidate sources", async () => {
	const h = await setup();
	const existing = await h.seed("既存の好み", "travel.old");
	await h.memory.setEnabled(false);
	const before = h.memory.list(true);
	const seeds = [
		seed("old"),
		seed("new"),
		seed("procedure", "host_procedure"),
		seed("note", "continuity"),
	];
	const app = new Hono();
	registerMemory(app, h.memory);
	const client = memoryClient({
		identity: "isolated",
		call: async (path, init) => app.request(path, init),
	});
	expect(await client.previewMemorySeeds(seeds)).toMatchObject({
		status: "ready",
	});
	const post = (action: string, body: unknown) =>
		app.request(`/api/memory/seeds/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const preview = await post("preview", { seeds });
	expect(preview.status).toBe(200);
	expect(await preview.json()).toMatchObject({
		status: "ready",
		registered: 0,
		counts: { total: 4, state: 2, hostProcedure: 1, continuity: 1 },
	});
	expect(h.memory.list(true)).toEqual(before);
	expect(sources(h)).toHaveLength(0);
	const response = await post("import", { seeds });
	expect(response.status).toBe(200);
	const result = await response.json();
	expect(result).toMatchObject({ status: "imported", registered: 1 });
	expect(
		result.entries.map((e: { result: string }) => e.result).sort(),
	).toEqual(["deferred", "deferred", "existing_key", "registered"]);
	expect(h.memory.status()).toMatchObject({ enabled: false, healthy: true });
	expect(h.memory.list(true).find((i) => i.id === existing.id)).toEqual(
		existing,
	);
	const item = h.memory.list().find((i) => i.semanticKey === "travel.new")!;
	expect(item).toMatchObject({
		text: seedStateText(seed("new")),
		origin: "agent_inferred",
		capturedBy: "agent",
		sourceMessageIds: [],
		evidence: [
			{
				messageId: null,
				quote: seeds[1]!.memory,
				source: {
					namespace: "memory-seed",
					kind: "candidate",
					label: "未確認のSeed候補",
				},
			},
		],
	});
	expect(sources(h)).toHaveLength(1);
	expect(await client.memoryItems()).toEqual(h.memory.list());
	expect(await client.importMemorySeeds(seeds)).toMatchObject({
		status: "unchanged",
		registered: 0,
	});
	expect(JSON.stringify(sources(h))).toContain("external-thread");
	expect(
		h.store.read((db) => db.query("SELECT COUNT(*) AS n FROM messages").get()),
	).toEqual({ n: 1 });
	expect((await post("import", { seeds })).status).toBe(200);
	expect(await (await post("preview", { seeds })).json()).toMatchObject({
		status: "unchanged",
		registered: 0,
	});
	expect(h.memory.list(true)).toHaveLength(2);
	expect(
		await (await post("import", { seeds: [seed("different")] })).json(),
	).toMatchObject({ status: "blocked", reason: "different_dataset" });
	expect(
		(await post("import", { seeds: [{ ...seed("bad"), subject: "other" }] }))
			.status,
	).toBe(400);
});

test("Seed contract rejects forged confirmation, duplicate identity and inconsistent byte ranges", () => {
	expect(parseMemorySeedJsonl(JSON.stringify(seed("ok")))).toHaveLength(1);
	for (const bad of [
		{ ...seed("x"), proposed_state_origin: "user_confirmed" },
		{ ...seed("x", "continuity"), proposed_state_kind: "preference" },
		{
			...seed("x"),
			evidence: [
				{ ...seed("x").evidence[0], range_utf8: { start: 0, end: 1 } },
			],
		},
	])
		expect(memorySeedInputSchema.safeParse({ seeds: [bad] }).success).toBe(
			false,
		);
	expect(
		memorySeedInputSchema.safeParse({ seeds: [seed("x"), seed("x")] }).success,
	).toBe(false);
	expect(() => parseMemorySeedJsonl("private invalid data")).toThrow(
		"invalid_memory_seed_line_1",
	);
});

test("transaction failure leaves neither State nor receipt nor source archive", async () => {
	const h = await setup();
	await h.store.write((db) =>
		db.exec(
			"CREATE TRIGGER reject_seed BEFORE INSERT ON memory_seed_source WHEN (SELECT COUNT(*) FROM memory_seed_source) > 0 BEGIN SELECT RAISE(ABORT, 'test_seed_write_failure'); END",
		),
	);
	await expect(
		h.memory.importSeeds({ seeds: [seed("one"), seed("two")] }),
	).rejects.toThrow("test_seed_write_failure");
	expect(h.memory.list(true)).toEqual([]);
	expect(sources(h)).toEqual([]);
	expect(receipt(h)).toEqual([]);
	await h.store.write((db) => db.exec("DROP TRIGGER reject_seed"));
	expect(
		await h.memory.importSeeds({ seeds: [seed("one"), seed("two")] }),
	).toMatchObject({ status: "imported", registered: 2 });
});

test("capacity rejects the whole batch without changing existing memory", async () => {
	const h = await setup();
	const id = await h.say("user", "既存項目");
	await h.curate(
		Array.from({ length: 99 }, (_, i) => ({
			op: "remember" as const,
			kind: "preference" as const,
			key: `existing.${i}`,
			text: `項目${i}`,
			messageId: id,
		})),
	);
	const before = h.memory.list(true);
	expect(before).toHaveLength(99);
	expect(
		await h.memory.importSeeds({ seeds: [seed("one"), seed("two")] }),
	).toMatchObject({ status: "blocked", reason: "capacity", availableSlots: 1 });
	expect(h.memory.list(true)).toEqual(before);
	expect(receipt(h)).toEqual([]);
	expect(sources(h)).toEqual([]);
}, 30_000);

test("correction and partial forget persist across repeat import; candidate evidence can be consolidated without promotion", async () => {
	const h = await setup();
	const seeds = [seed("one"), seed("two"), seed("three")];
	await h.memory.importSeeds({ seeds });
	const first = h.memory.list().find((i) => i.semanticKey === "travel.one")!;
	const second = h.memory.list().find((i) => i.semanticKey === "travel.two")!;
	const correctedText = "旅行では列車を利用したい";
	const messageId = await h.say("user", correctedText);
	const [corrected] = await h.curate([
		{
			op: "update",
			itemId: first.id,
			revision: first.revision,
			text: correctedText,
			messageId,
			quote: correctedText,
			explicit: true,
		},
	]);
	expect(corrected).toMatchObject({ status: "applied" });
	await h.forget([second.id]);
	expect(sources(h)).toHaveLength(2);
	expect(await h.memory.importSeeds({ seeds })).toMatchObject({
		status: "unchanged",
		registered: 0,
	});
	expect(h.memory.list().map((i) => i.text)).toContain(correctedText);
	expect(h.memory.list(true).some((i) => i.semanticKey === "travel.two")).toBe(
		false,
	);
	const confirmed = h.memory.list().find((i) => i.text === correctedText)!;
	const candidate = h.memory
		.list()
		.find((i) => i.semanticKey === "travel.three")!;
	const [merged] = await h.curate([
		{
			op: "merge",
			sources: [confirmed, candidate].map((i) => ({
				itemId: i.id,
				revision: i.revision,
			})),
			key: "travel.combined",
			text: "旅程の移動手段の候補",
			negated: false,
		},
	]);
	expect(merged).toMatchObject({ status: "applied" });
	if (merged?.status !== "applied") throw new Error("merge_failed");
	const item = h.memory.list().find((i) => i.id === merged.id)!;
	expect(item.origin).toBe("agent_inferred");
	expect(item.evidence.some((e) => e.source?.namespace === "memory-seed")).toBe(
		true,
	);
	await h.forget([item.id]);
	expect(sources(h)).toEqual([]);
	expect(h.memory.list(true)).toEqual([]);
	expect(await h.memory.importSeeds({ seeds })).toMatchObject({
		status: "unchanged",
		registered: 0,
	});
	expect(await h.memory.recover()).toMatchObject({ healthy: true });
	expect(h.memory.list(true)).toEqual([]);
});

for (const backupBeforeImport of [true, false])
	test(`forget replay over ${backupBeforeImport ? "pre-import" : "post-import"} database prevents Seed resurrection`, async () => {
		const h = await setup();
		const seeds = [seed("one"), seed("two")];
		const backup = join(h.dir, "backup.sqlite3");
		const backupNow = async () => {
			await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
			copyFileSync(join(h.dir, "db.sqlite3"), backup);
		};
		if (backupBeforeImport) await backupNow();
		await h.memory.importSeeds({ seeds });
		if (!backupBeforeImport) await backupNow();
		const forgotten = h.memory
			.list()
			.find((i) => i.semanticKey === "travel.one")!;
		await h.forget([forgotten.id]);
		await h.store.close();
		copyFileSync(backup, join(h.dir, "db.sqlite3"));
		const store = openStore(join(h.dir, "db.sqlite3"), memoryTestMigrations);
		extra.push(() => store.close());
		const conversation = createConversationService(store);
		const continuity = createContinuityService(store, () => h.time.now);
		const memory = createMemoryService(store, conversation, continuity, {
			journalPath: join(h.dir, "journal.jsonl"),
			clock: () => h.time.now,
		});
		expect(memory.status().healthy).toBe(false);
		expect(await memory.recover()).toMatchObject({ healthy: true });
		expect(await memory.importSeeds({ seeds })).toMatchObject({
			status: "unchanged",
			registered: 0,
		});
		expect(memory.list(true).some((i) => i.semanticKey === "travel.one")).toBe(
			false,
		);
		expect(memory.list()).toHaveLength(backupBeforeImport ? 0 : 1);
		const archives = store.read((db) =>
			db.query("SELECT * FROM memory_seed_source").all(),
		);
		expect(archives).toHaveLength(backupBeforeImport ? 0 : 1);
	});
