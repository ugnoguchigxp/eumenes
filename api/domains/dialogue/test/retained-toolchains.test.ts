import { Hono } from "hono";
import { registerDialogue } from "..";
import { estimateJsonTokens, estimateTextTokens } from "../../inference";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { byId } from "../repository";
import {
	retainedReferences,
	resetRetained,
} from "../repository/retained-toolchains";
import {
	prepareRetained,
	retainedOffer,
	retainAdopted,
	validRetainedSources,
	usageReference,
	usageMessage,
} from "../service/retained-toolchains";
import { analysisTools, validateAnalysis } from "../service/initial-decision";
import type { DialogueDeps, GenerateInput } from "../service/context";
import { setup, card } from "./retained-toolchains.fixture";

const open: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function harness() {
	const h = await setup();
	open.push(h);
	return h;
}
const names = (tools: ReturnType<typeof analysisTools>) =>
	tools.map((t) => t.function.name);
const refs = (h: Awaited<ReturnType<typeof setup>>, conversationId = "main") =>
	h.store.read((db) => retainedReferences(db, conversationId));

test("cold discovery offers four new candidates once; a follow-up and changed location reuse a real callable function without discovery", async () => {
	const h = await harness();
	h.find("鎌倉の天気");
	h.use("weather", "鎌倉", "今日");
	const first = await h.ask("鎌倉の天気は？");
	expect(first.status).toBe("completed");
	expect(names(h.offered[0]!.tools)).toEqual([
		"find_toolchain",
		"answer",
		"report_unavailable",
	]);
	expect(h.searches).toHaveLength(1);
	expect(h.embedded).toEqual(["鎌倉の天気"]);
	expect(names(h.offered[1]!.tools)).toEqual([
		"weather_run",
		"stock_run",
		"calendar_run",
		"documents_run",
		"answer",
		"report_unavailable",
	]);
	expect(refs(h).map((r) => r.revision_id)).toEqual(["toolchain:weather@1"]);
	h.use("weather", "鎌倉", "明日");
	expect((await h.ask("明日は？")).status).toBe("completed");
	const reused = h.offered.at(-1)!;
	expect(names(reused.tools)).toContain("weather_run");
	expect(
		reused.tools.find((t) => t.function.name === "weather_run")!.function
			.parameters,
	).toHaveProperty("properties.target");
	expect(JSON.stringify(reused.messages)).toContain("toolchainUsageReference=");
	expect(
		reused.messages.find((m) =>
			m.content.startsWith("toolchainUsageReference="),
		)!.content,
	).not.toContain("を新しく取得しました。");
	h.use("weather", "札幌", "明後日");
	expect((await h.ask("札幌なら明後日は？")).status).toBe("completed");
	expect(h.searches).toHaveLength(1);
	expect(h.embedded).toHaveLength(1);
	expect(h.executed.map((e) => e.args)).toEqual([
		{ target: "鎌倉", when: "今日" },
		{ target: "鎌倉", when: "明日" },
		{ target: "札幌", when: "明後日" },
	]);
	expect(h.offered.at(-1)!.messages.at(-1)!.content).toBe("札幌なら明後日は？");
});

test("chatter does not evict a function; ambiguity can ask one question without searching or executing", async () => {
	const h = await harness();
	h.find("情報取得");
	h.use("weather");
	await h.ask("鎌倉の天気は");
	h.scripts.push(
		{ name: "answer", args: { kind: "chat", freshness: "not_live" } },
		{ name: "prose" },
	);
	expect((await h.ask("ありがとう")).status).toBe("completed");
	h.use("weather");
	expect((await h.ask("さっきの場所の明日は")).status).toBe("completed");
	expect(h.searches).toHaveLength(1);
	expect(refs(h)).toHaveLength(1);
	const before = h.executed.length;
	h.scripts.push({
		name: "report_unavailable",
		args: { reply: "どちらの場所についてですか。" },
	});
	const question = await h.ask("それはどう？");
	expect(h.dialogue.answerText(question.id)).toBe(
		"どちらの場所についてですか。",
	);
	expect(h.executed).toHaveLength(before);
	expect(h.searches).toHaveLength(1);
});

test("a miss excludes every retained revision before the four-candidate limit and does not persist unchosen candidates", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	await h.ask("天気は");
	h.find("株価");
	h.use("stock", "企業A", "現在");
	await h.ask("企業Aの株価");
	expect([...h.searches[1]!.excludeRevisionIds!]).toEqual([
		"toolchain:weather@1",
	]);
	expect(names(h.offered.at(-1)!.tools)).toEqual([
		"stock_run",
		"calendar_run",
		"documents_run",
		"travel_run",
		"answer",
		"report_unavailable",
	]);
	expect(
		refs(h)
			.map((r) => r.revision_id)
			.sort(),
	).toEqual(["toolchain:stock@1", "toolchain:weather@1"]);
	h.find("別の用途");
	h.scripts.push({
		name: "report_unavailable",
		args: { reply: "提示された担当ではできません。" },
	});
	expect((await h.ask("別のことをして")).status).toBe("completed");
	expect(h.searches).toHaveLength(3);
	expect(h.executed).toHaveLength(2);
});

test("embedding failure offers no catalog fallback; another discovery after the one search is rejected", async () => {
	const h = await harness();
	h.state.embedding = false;
	h.find("新しい用途");
	h.scripts.push({
		name: "report_unavailable",
		args: { reply: "担当の検索ができませんでした。" },
	});
	expect((await h.ask("新しいこと")).status).toBe("completed");
	expect(names(h.offered[1]!.tools)).toEqual(["answer", "report_unavailable"]);
	expect(JSON.stringify(h.offered[1]!.messages)).toContain(
		"embedding_unavailable",
	);
	h.state.embedding = true;
	h.find("別用途");
	h.find("再検索");
	h.find("さらに検索");
	expect((await h.ask("別のこと")).status).toBe("failed");
	expect(h.searches).toHaveLength(2);
	expect(h.executed).toHaveLength(0);
	expect(refs(h)).toHaveLength(0);
});

test("retention follows LRU and whole-schema budget limits, never age or an unused candidate", async () => {
	const h = await harness();
	for (const id of ["weather", "stock", "calendar", "documents"]) {
		h.state.matches = [id];
		h.find(id);
		h.use(id);
		expect((await h.ask(id)).status).toBe("completed");
	}
	h.use("weather");
	await h.ask("最初の担当を再利用");
	h.state.matches = ["travel"];
	h.find("旅行");
	h.use("travel");
	await h.ask("旅行を調べる");
	expect(
		refs(h)
			.map((r) => r.revision_id)
			.sort(),
	).toEqual(
		["calendar", "documents", "travel", "weather"].map(
			(id) => `toolchain:${id}@1`,
		),
	);
	h.cards.set("toolchain:huge@1", {
		...card("huge"),
		summary: "大".repeat(5000),
	});
	h.state.matches = ["huge"];
	h.find("長い定義");
	h.use("huge");
	expect((await h.ask("大きい担当を使う")).status).toBe("completed");
	expect(refs(h).some((r) => r.revision_id === "toolchain:huge@1")).toBe(false);
	const external = new Database(h.file, { readonly: true });
	expect(retainedReferences(external, "main")).toHaveLength(4);
	external.close();
});

test("correction and registry revision changes remove old sources; reset prevents an in-flight use from repopulating the workset", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	const first = await h.ask("鎌倉の天気は");
	await h.store.write((db) =>
		h.conversation.correctInTransaction(db, {
			messageId: first.inputMessageId,
			text: "横浜の天気は",
			at: new Date().toISOString(),
		}),
	);
	h.scripts.push({
		name: "report_unavailable",
		args: { reply: "対象を教えてください。" },
	});
	await h.ask("明日は");
	expect(names(h.offered.at(-1)!.tools)).not.toContain("weather_run");
	expect(refs(h)).toHaveLength(0);
	h.find("天気");
	h.use("weather");
	await h.ask("鎌倉の天気は");
	h.scripts.push({
		name: "weather_run",
		args: { target: "鎌倉", when: "明日" },
		during: () => h.dialogue.resetToolchains("main"),
	});
	expect((await h.ask("明日は")).status).toBe("completed");
	expect(refs(h)).toHaveLength(0);
	h.find("天気");
	h.use("weather");
	await h.ask("天気は");
	h.cards.delete("toolchain:weather@1");
	const next = { ...card("weather"), revisionId: "toolchain:weather@2" };
	h.cards.set(next.revisionId, next);
	h.scripts.push({
		name: "report_unavailable",
		args: { reply: "再度指定してください。" },
	});
	await h.ask("続けて");
	expect(names(h.offered.at(-1)!.tools)).not.toContain("weather_run");
	expect(refs(h)).toHaveLength(0);
});

test("a forgotten source or removed capability during inference is rejected; previous approval is never copied into native arguments", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	const first = await h.ask("鎌倉の天気は");
	h.scripts.push({
		name: "weather_run",
		args: { target: "鎌倉", when: "明日" },
		during: async () => {
			h.cards.delete("toolchain:weather@1");
		},
	});
	expect((await h.ask("明日は")).status).toBe("failed");
	expect(h.executed).toHaveLength(1);
	expect(h.traces.get(first.id)?.analysis?.approved).toBe(false);
	expect(
		h.offered.at(-1)!.tools.find((t) => t.function.name === "weather_run")!
			.function.parameters,
	).not.toHaveProperty("properties.approved.default");
});

test("discovery schema enforces bounded query and permission to search, preserving CURRENT_REQUEST", () => {
	const call = (query: string) => [
		{
			id: "call",
			name: "find_toolchain",
			arguments: JSON.stringify({
				kind: "action",
				freshness: "not_live",
				impact: "none",
				approved: false,
				query,
			}),
		},
	];
	expect(validateAnalysis(call("用途"), [], true)).toMatchObject({
		next: "find_toolchain",
		query: "用途",
	});
	for (const query of ["", " ", "a".repeat(2001)])
		expect(() => validateAnalysis(call(query), [], true)).toThrow();
	expect(() => validateAnalysis(call("用途"), [], false)).toThrow();
});

test("source revocation invalidates a frozen prompt, while reset/LRU changes only suppress retention writes from older runs", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	const first = await h.ask("鎌倉の天気は");
	const deps = {
		store: h.store,
		conversation: h.conversation,
		toolchains: h.toolchains,
	} as DialogueDeps;
	const available = new Set([...h.cards.values()].map((c) => c.id));
	const oldInput = (await h.store.write((db) => ({
		routing: {
			conversationId: "main",
			available: [...available],
			retained: prepareRetained(deps, db, first, available, 4096),
		},
	}))) as unknown as GenerateInput;
	expect(h.store.read((db) => validRetainedSources(deps, db, oldInput))).toBe(
		true,
	);
	h.find("株価");
	h.use("stock");
	const second = await h.ask("株価は");
	const before = refs(h);
	await h.store.write((db) =>
		retainAdopted(deps, db, first, oldInput, first.id, "toolchain:weather@1"),
	);
	expect(refs(h)).toEqual(before);
	expect(before[0]!.source_run_id).toBe(second.id);
	await h.store.write((db) => resetRetained(db, "main"));
	expect(h.store.read((db) => validRetainedSources(deps, db, oldInput))).toBe(
		true,
	);
	await h.store.write((db) =>
		retainAdopted(deps, db, first, oldInput, first.id, "toolchain:weather@1"),
	);
	expect(refs(h)).toHaveLength(0);
	const blocked = {
		...deps,
		memory: {
			blockedMessageIdsInTransaction: () => new Set([first.inputMessageId]),
		},
	} as unknown as DialogueDeps;
	expect(
		h.store.read((db) => validRetainedSources(blocked, db, oldInput)),
	).toBe(false);
});

test("a denied adoption or cancelled inference never creates a retained function; conversations stay isolated", async () => {
	const h = await harness();
	h.state.receiptAllowed = false;
	h.find("天気");
	h.use("weather");
	expect((await h.ask("天気は")).status).toBe("failed");
	expect(refs(h)).toHaveLength(0);
	h.state.receiptAllowed = true;
	h.find("天気");
	h.use("weather");
	await h.ask("天気は");
	h.find("天気");
	h.use("weather");
	await h.ask("天気は", "another");
	const other = h.offered.at(-2)!;
	expect(names(other.tools)).toEqual([
		"find_toolchain",
		"answer",
		"report_unavailable",
	]);
	expect(refs(h, "another")[0]!.source_run_id).not.toBe(
		refs(h)[0]!.source_run_id,
	);
	h.scripts.push({
		name: "weather_run",
		args: { target: "鎌倉", when: "明日" },
		during: async () => {
			const latest = h.store.read((db) =>
				db
					.query(
						"SELECT id FROM dialogue_runs WHERE conversation_id='main' ORDER BY seq DESC LIMIT 1",
					)
					.get(),
			) as { id: string };
			await h.dialogue.cancel(latest.id);
		},
	});
	const before = refs(h);
	expect((await h.ask("明日は")).status).toBe("cancelled");
	expect(refs(h)).toEqual(before);
});

test("no age TTL, forgotten sources are pruned without history resurrection, and a small task budget removes whole functions", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	const first = await h.ask("鎌倉の天気は");
	const deps = {
		store: h.store,
		conversation: h.conversation,
		toolchains: h.toolchains,
	} as DialogueDeps;
	const available = new Set(["weather"]);
	await h.store.write((db) =>
		db
			.query(
				"UPDATE dialogue_runs SET updated_at='2000-01-01T00:00:00Z' WHERE id=?",
			)
			.run(first.id),
	);
	// Expiring the audit trace must not give capability retention an implicit TTL.
	h.traces.clear();
	const prepared = await h.store.write((db) =>
		prepareRetained(deps, db, byId(db, first.id)!, available, 4096),
	);
	expect(prepared.entries).toHaveLength(1);
	const input = {
		routing: { available: [...available], retained: prepared },
	} as GenerateInput;
	expect(
		h.store.read((db) => retainedOffer(deps, db, input)).cards,
	).toHaveLength(1);
	const blocked = {
		...deps,
		memory: {
			blockedMessageIdsInTransaction: () => new Set([first.inputMessageId]),
		},
	} as unknown as DialogueDeps;
	h.scripts.push(
		{ name: "answer", args: { kind: "chat", freshness: "not_live" } },
		{ name: "prose" },
	);
	const newInput = await h.ask("ありがとう");
	await h.store.write((db) =>
		prepareRetained(blocked, db, newInput, available, 4096),
	);
	expect(refs(h)).toHaveLength(0);
	await h.store.write((db) =>
		prepareRetained(deps, db, newInput, available, 4096),
	);
	expect(refs(h)).toHaveLength(0);
	h.find("天気");
	h.use("weather");
	const next = await h.ask("天気は");
	await h.store.write((db) => prepareRetained(deps, db, next, available, 1));
	expect(refs(h)).toHaveLength(0);
});

test("oversized structured arguments are omitted whole, and temporary execution failure keeps the reusable capability", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather", "あ".repeat(601));
	await h.ask("対象の天気");
	h.use("weather");
	h.state.instantAllowed = false;
	expect((await h.ask("明日は")).status).toBe("failed");
	const note = h.offered
		.at(-1)!
		.messages.find((m) =>
			m.content.startsWith("toolchainUsageReference="),
		)!.content;
	expect(JSON.parse(note.slice(note.indexOf("=") + 1))[0]).not.toHaveProperty(
		"forwardedRequest",
	);
	expect(refs(h)).toHaveLength(1);
});

test("an approval the selection after a discovery writes is not its own: the discovery's analysis stands", async () => {
	const h = await harness();
	h.find("天気");
	h.scripts.push({
		name: "weather_run",
		args: { target: "鎌倉", when: "今日", approved: true },
	});
	h.use("weather", "鎌倉", "今日");
	expect((await h.ask("鎌倉の今日の天気は")).status).toBe("completed");
	// The selection is not offered the analysis fields; an approval it writes anyway is replaced by the host's.
	expect(h.offered).toHaveLength(2);
	expect(
		Object.keys(
			h.offered[1]!.tools.find((t) => t.function.name === "weather_run")!
				.function.parameters.properties as object,
		),
	).not.toContain("approved");
	expect(h.executed).toHaveLength(1);
	expect([...h.traces.values()][0]!.analysis?.approved).toBe(false);
});

test("an input corrected during a pending text inference revokes the model's signal immediately", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	const first = await h.ask("鎌倉の天気は");
	h.scripts.push({
		name: "weather_run",
		args: { target: "鎌倉", when: "明日" },
		during: async () => {
			await h.store.write((db) =>
				h.conversation.correctInTransaction(db, {
					messageId: first.inputMessageId,
					text: "別の対象に訂正",
				}),
			);
		},
	});
	const run = await h.ask("明日は");
	expect(run.status).toBe("failed");
	expect(h.executed).toHaveLength(1);
});

test("a budget eviction removes oldest uses first even if skipping a larger recent function could retain an older small one", async () => {
	const h = await harness();
	h.cards.set("toolchain:documents@1", {
		...card("documents"),
		summary: "大".repeat(600),
	});
	let latest;
	for (const id of ["stock", "documents", "weather"]) {
		h.state.matches = [id];
		h.find(id);
		h.use(id);
		latest = await h.ask(id);
	}
	const deps = {
		store: h.store,
		conversation: h.conversation,
		toolchains: h.toolchains,
	} as DialogueDeps;
	const before = refs(h);
	expect(before).toHaveLength(3);
	const estimate = (references: typeof before) =>
		h.store.read(
			(db) =>
				estimateJsonTokens(
					analysisTools(references.map((ref) => h.cards.get(ref.revision_id)!)),
				) -
				estimateJsonTokens(analysisTools([])) +
				estimateTextTokens(
					usageMessage(references.map((ref) => usageReference(deps, db, ref)))
						.content,
				) +
				4,
		);
	const budget = estimate(
		before.filter((ref) => ref.revision_id !== "toolchain:documents@1"),
	);
	expect(
		estimate(before.filter((ref) => ref.revision_id !== "toolchain:stock@1")),
	).toBeGreaterThan(budget);
	expect(
		estimate(
			before.filter((ref) => ref.revision_id === "toolchain:documents@1"),
		),
	).toBeLessThanOrEqual(budget);
	await h.store.write((db) =>
		prepareRetained(
			deps,
			db,
			latest!,
			new Set([...h.cards.values()].map((card) => card.id)),
			budget,
		),
	);
	expect(refs(h).map((ref) => ref.revision_id)).toEqual([
		"toolchain:weather@1",
	]);
});

test("usage status comes from the current selection reference, and HTTP reset clears the workset idempotently", async () => {
	const h = await harness();
	h.find("天気");
	h.use("weather");
	await h.ask("天気は");
	const ref = refs(h)[0]!;
	h.toolchains.usageOfRunInTransaction = () => ({
		selectionId: ref.selection_id,
		request: '{"target":"鎌倉","when":"今日"}',
		outcome: "failed",
		code: "temporary_failure",
	});
	const deps = {
		conversation: h.conversation,
		toolchains: h.toolchains,
	} as DialogueDeps;
	expect(h.store.read((db) => usageReference(deps, db, ref))).toMatchObject({
		outcome: "failed",
		code: "temporary_failure",
	});
	const app = new Hono();
	registerDialogue(app, h.dialogue);
	for (let i = 0; i < 2; i++)
		expect(
			(
				await app.request("/api/conversations/main/toolchains/reset", {
					method: "POST",
				})
			).status,
		).toBe(204);
	expect(refs(h)).toHaveLength(0);
	expect(
		(
			await app.request("/api/conversations/empty/toolchains/reset", {
				method: "POST",
			})
		).status,
	).toBe(204);
});
