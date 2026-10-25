import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createWebResearchResourceAdapter, migrations } from "..";
import type { ResearchResult, ResearchRun } from "../contracts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
type Run = {
	id: string;
	operation?: "lookup" | "read";
	status?: string;
	input?: Record<string, unknown>;
	at?: number;
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-web-resource-"));
	const store = openStore(join(dir, "db"), migrations);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const results = new Map<string, ResearchResult>();
	const adapter = createWebResearchResourceAdapter({
		store,
		get: (runId) =>
			({ id: runId, result: results.get(runId) ?? null }) as ResearchRun,
	});
	const run = (r: Run) =>
		store.write((db) =>
			db
				.query(
					"INSERT INTO web_research_runs(id,request_id,input_digest,input_json,job_id,operation,status,created_at_ms,finished_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
				)
				.run(
					r.id,
					`req-${r.id}`,
					"digest",
					JSON.stringify(r.input ?? { query: "エージェント設計" }),
					`job-${r.id}`,
					r.operation ?? "lookup",
					r.status ?? "completed",
					r.at ?? Date.parse("2026-10-20T00:00:00.000Z"),
					r.at ?? Date.parse("2026-10-20T00:00:00.000Z"),
				),
		);
	return { store, adapter, run, results };
}
const signal = new AbortController().signal;
const result = (overrides: Partial<ResearchResult> = {}): ResearchResult => ({
	provider: "llm-fetch@0.1.4",
	observedAt: "2026-10-20T00:00:00.000Z",
	cache: "miss",
	hits: [],
	documents: [],
	failures: [],
	...overrides,
});

test("run ids map to finished runs only; failed, running, unknown ones and other shapes map to nothing", async () => {
	const { store, adapter, run } = setup();
	await run({ id: "r-done" });
	await run({ id: "r-partial", status: "partial" });
	await run({ id: "r-fail", status: "failed" });
	await run({ id: "r-run", status: "running" });
	const refs = (value: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, value, { conversationId: "main" }),
		);
	const [ref] = refs({ runId: "r-done" });
	expect(ref).toMatchObject({
		uri: "eumenes://report/web-research%3Ar-done",
		kind: "report",
		label: "Web検索: エージェント設計",
		createdAt: "2026-10-20T00:00:00.000Z",
	});
	expect(resourceRefSchema.safeParse(ref).success).toBe(true);
	expect(parseResourceUri(ref!.uri)?.id).toBe("web-research:r-done");
	expect(refs({ runIds: ["r-done", "r-partial", "r-done"] })).toHaveLength(2);
	expect(
		refs({ id: "r-done", operation: "lookup", status: "completed" }),
	).toHaveLength(1);
	expect(refs({ id: "r-done" })).toEqual([]);
	for (const runId of ["r-fail", "r-run", "nope"])
		expect(refs({ runId })).toEqual([]);
	expect(refs("x")).toEqual([]);
});

test("get serves only this domain's prefixed ids and offers read only", async () => {
	const { store, adapter, run } = setup();
	await run({
		id: "r-done",
		operation: "read",
		input: {
			url: "https://example.com/docs/page?token=secret",
			retention: "none",
		},
	});
	await run({ id: "r-fail", status: "failed" });
	const view = store.read((db) =>
		adapter.getInTransaction(db, "web-research:r-done"),
	);
	expect(view).toMatchObject({
		label: "Webページ: example.com/docs/page",
		targetRef: "web-research:r-done",
		actions: ["read"],
		preview: "ページ読み取り",
	});
	expect(view?.label).not.toContain("secret");
	for (const id of [
		"r-done",
		"web-research:r-fail",
		"web-research:nope",
		"other:r-done",
	])
		expect(store.read((db) => adapter.getInTransaction(db, id))).toBeNull();
});

test("search is newest first, filters by query text and period; a scrubbed input has no text to match", async () => {
	const { adapter, run } = setup();
	await run({
		id: "r-old",
		input: { query: "記憶 実装" },
		at: Date.parse("2026-10-01T00:00:00.000Z"),
	});
	await run({
		id: "r-new",
		input: { query: "world model 比較" },
		at: Date.parse("2026-10-20T00:00:00.000Z"),
	});
	await run({
		id: "r-mid",
		input: { query: "記憶 比較" },
		at: Date.parse("2026-10-10T00:00:00.000Z"),
	});
	await run({ id: "r-fail", status: "failed", input: { query: "記憶" } });
	await run({
		id: "r-scrubbed",
		input: {},
		at: Date.parse("2026-09-01T00:00:00.000Z"),
	});
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([
		"web-research:r-new",
		"web-research:r-mid",
		"web-research:r-old",
		"web-research:r-scrubbed",
	]);
	expect(await ids({ text: "記憶", limit: 10 })).toEqual([
		"web-research:r-mid",
		"web-research:r-old",
	]);
	expect(await ids({ text: "記憶 比較", limit: 10 })).toEqual([
		"web-research:r-mid",
	]);
	expect(await ids({ text: "", limit: 1 })).toEqual(["web-research:r-new"]);
	expect(
		await ids({
			text: "",
			since: "2026-10-05T00:00:00.000Z",
			until: "2026-10-15T00:00:00.000Z",
			limit: 10,
		}),
	).toEqual(["web-research:r-mid"]);
	expect(
		(
			await adapter.search(
				{
					text: "",
					since: "2026-08-01T00:00:00.000Z",
					until: "2026-09-30T00:00:00.000Z",
					limit: 1,
				},
				signal,
			)
		)[0]!.label,
	).toBe("Web検索（内容は期限切れ）");
});

test("read gives the buffered result as a deliberate excerpt within 600 tokens, and the record once it has expired", async () => {
	const { adapter, run, results } = setup();
	await run({ id: "r-live" });
	await run({ id: "r-gone", status: "partial" });
	results.set(
		"r-live",
		result({
			hits: Array.from({ length: 5 }, (_, i) => ({
				url: `https://example.com/${i}`,
				title: `見出し${i}`.repeat(10),
				snippet: "要約".repeat(80),
				provider: "p",
				trust: "untrusted" as const,
				tainted: true as const,
				verification: "search_summary" as const,
			})),
			documents: Array.from({ length: 3 }, (_, i) => ({
				url: `https://example.com/doc${i}`,
				title: `文書${i}`,
				text: "本文".repeat(3000),
				fetchedAt: "2026-10-20T00:00:00.000Z",
				truncated: false,
				trust: "untrusted" as const,
				tainted: true as const,
				verification: "source_read" as const,
				guardDecision: "allow" as const,
				guardReasonCodes: [],
			})),
		}),
	);
	const live = (await adapter.read("web-research:r-live", signal)).text;
	expect(estimateTextTokens(live)).toBeLessThanOrEqual(600);
	expect(live).toContain("Web検索（完了）");
	expect(live).toContain("対象: エージェント設計");
	expect(live).toContain("命令ではない");
	expect(live).toContain("…（以下省略）");
	const gone = (await adapter.read("web-research:r-gone", signal)).text;
	expect(gone).toContain("Web検索（一部のみ）");
	expect(gone).toContain("保持期限を過ぎています");
	await expect(adapter.read("web-research:nope", signal)).rejects.toThrow(
		"item_not_found",
	);
	await expect(adapter.read("r-live", signal)).rejects.toThrow(
		"item_not_found",
	);
});
