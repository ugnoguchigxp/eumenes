import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { sha256Hex } from "../../../infrastructure/digest";
import { packVector, vectorSpaceKey } from "../../../infrastructure/vector";
import { PREFETCH_BYTES, type MemoryEmbed } from "../../memory";
import {
	setupAgent,
	type AgentHarness,
	type AgentData,
} from "./memory-agent.fixture";

const SPACE = {
	modelId: "test-embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 3,
};
const KYOTO = [1, 0, 0];
const HOKKAIDO = [0, 1, 0];
const OTHER = [0, 0, 1];
const OPPOSITE = [-1, 0, 0];
const vectorOf = (text: string) =>
	text.includes("京都")
		? KYOTO
		: text.includes("北海道")
			? HOKKAIDO
			: text.includes("宇宙")
				? OPPOSITE
				: OTHER;

/** A scripted embedding: records every call, and can be made to fail. */
function fakeEmbed() {
	const state = {
		calls: [] as Array<{ texts: string[]; type: "query" | "passage" }>,
		mode: "ok" as "ok" | "throw" | "short",
	};
	const embed: MemoryEmbed = async (texts, type) => {
		state.calls.push({ texts, type });
		if (state.mode === "throw") throw new Error("embedding_unavailable");
		const vectors = texts.map(vectorOf);
		return {
			vectors: state.mode === "short" ? vectors.slice(1) : vectors,
			space: SPACE,
		};
	};
	return { state, embed };
}

const open: AgentHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup(embed?: MemoryEmbed) {
	const h = await setupAgent(embed ? { embed } : {});
	open.push(h);
	return h;
}
const vectorRows = (h: AgentHarness) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT message_id AS messageId, conversation_id AS conversationId, ordinal, space, digest, length(vector) AS bytes FROM memory_turn_vector ORDER BY ordinal",
				)
				.all() as Array<{
				messageId: string;
				conversationId: string;
				ordinal: number;
				space: string;
				digest: string;
				bytes: number;
			}>,
	);
/** A stored vector as the agent would have made it earlier. */
const putVector = (h: AgentHarness, messageId: string, vector: number[]) =>
	h.store.write((db) => {
		const found = h.conversation.messageInTransaction(db, messageId)!;
		db.query(
			"INSERT OR REPLACE INTO memory_turn_vector (message_id, conversation_id, ordinal, space, vector, digest, created_at) VALUES (?,?,?,?,?,?,?)",
		).run(
			messageId,
			found.message.conversationId,
			found.ordinal,
			vectorSpaceKey(SPACE),
			packVector(vector),
			sha256Hex(found.message.text),
			h.time.now,
		);
	});
const noOps = () => JSON.stringify({ ops: [] });

test("the agent embeds the turns it read as passages and stores a vector per message, never for a scheduled prompt", async () => {
	const e = fakeEmbed();
	const h = await setup(e.embed);
	const user = await h.say("user", "京都の話をしたい");
	const reply = await h.say(
		"assistant",
		"清水寺はいかがでしょう",
		"c1",
		`run-${user}`,
	);
	const scheduled = await h.say("user", "【定期】朝の確認");
	await h.store.write((db) =>
		h.memory.excludeMessageInTransaction(db, scheduled),
	);
	const long = await h.say("user", "あ".repeat(2500));
	h.inference.state.script = noOps;
	await h.setCursor(0);
	await h.schedule();
	await h.settled();
	const passages = e.state.calls.filter((c) => c.type === "passage");
	expect(passages).toHaveLength(1);
	expect(passages[0]!.texts).toHaveLength(3);
	expect(passages[0]!.texts[0]).toBe("京都の話をしたい");
	expect(passages[0]!.texts.join("")).not.toContain("定期");
	// At most 2000 characters of a long message are embedded.
	expect(passages[0]!.texts[2]!.length).toBe(2000);
	expect(e.state.calls.filter((c) => c.type === "query")).toHaveLength(0);
	const rows = await vectorRows(h);
	expect(rows.map((r) => r.messageId)).toEqual([user, reply, long]);
	expect(rows[0]).toMatchObject({
		conversationId: "c1",
		ordinal: h.ordinal(user),
		space: vectorSpaceKey(SPACE),
		digest: sha256Hex("京都の話をしたい"),
		bytes: SPACE.dimension * 4,
	});
	// The digest is that of the whole message, not of the part that was embedded.
	expect(rows[2]!.digest).toBe(sha256Hex("あ".repeat(2500)));
	expect(rows.map((r) => r.messageId)).not.toContain(scheduled);
});

test("an embedding that throws, answers wrongly or is not provided still settles the job and advances the cursor", async () => {
	for (const mode of ["throw", "short", "none"] as const) {
		const e = fakeEmbed();
		e.state.mode = mode === "none" ? "ok" : mode;
		const h = await setup(mode === "none" ? undefined : e.embed);
		const first = await h.say("user", "京都の話");
		const second = await h.say("assistant", "いいですね", "c1", `run-${first}`);
		h.inference.state.script = (data: AgentData) =>
			JSON.stringify({
				ops: [
					{
						type: "note_add",
						turn: data.turns.find((t) => t.role === "user")!.label,
						kind: "activity",
						text: "京都の話をした",
					},
				],
			});
		await h.setCursor(0);
		await h.schedule();
		await h.settled();
		expect(h.jobs()[0]!.state).toBe("completed");
		expect(h.cursor()).toBe(h.ordinal(second));
		expect(h.failures()).toBe(0);
		expect(await vectorRows(h)).toHaveLength(0);
		// The rest of the settle was applied.
		expect((await h.window()).shortTerm.text).toContain("京都の話をした");
		if (mode !== "none") expect(e.state.calls.length).toBeGreaterThan(0);
	}
});

/** A conversation whose oldest exchanges are well outside the window of ten, each with a vector. */
async function longConversation(h: AgentHarness) {
	const runs: Array<{ user: string; reply: string }> = [];
	for (let i = 1; i <= 14; i++) {
		const topic =
			i === 1 ? "京都" : i === 8 ? "京都" : i === 2 ? "北海道" : "雑談";
		const user = await h.say("user", `${topic}の話${i}`);
		const reply = await h.say("assistant", `回答${i}`, "c1", `run-${user}`);
		runs.push({ user, reply });
		await putVector(h, user, vectorOf(topic));
	}
	return runs;
}
const prefetchOf = async (h: AgentHarness) => (await h.window()).prefetch;

test("the agent's prefetch query is embedded as a query and finds exchanges before the next turn's window; a missing or failed query keeps the earlier prefetch", async () => {
	const e = fakeEmbed();
	const h = await setup(e.embed);
	const runs = await longConversation(h);
	// Everything is read except the last user message.
	const last = await h.say("user", "最新の発言です");
	await h.setCursor(h.ordinal(last) - 1);
	const query = (text?: string) => () =>
		JSON.stringify({ ops: [], ...(text ? { prefetch: { query: text } } : {}) });
	let jobs = 0;
	const run = async (script: () => string) => {
		h.inference.state.script = script;
		await h.say("user", `追加${++jobs}`);
		await h.schedule();
		await h.settled(jobs);
	};

	await run(query("京都 旅行"));
	const queries = e.state.calls.filter((c) => c.type === "query");
	expect(queries).toEqual([{ texts: ["京都 旅行"], type: "query" }]);
	const first = await prefetchOf(h);
	// Run 1 (before the window of the ten newest user messages) is there; run 8 (inside it) is not.
	expect(first.text).toContain("京都の話1");
	expect(first.text).toContain("回答1");
	expect(first.text).not.toContain("京都の話8");
	expect(first.pins.map((p) => p.messageId)).toEqual([
		runs[0]!.user,
		runs[0]!.reply,
	]);
	expect(first.pins[0]!.digest).toBe(sha256Hex("京都の話1"));
	expect(first.bytes).toBe(Buffer.byteLength(first.text));
	expect(first.bytes).toBeLessThanOrEqual(PREFETCH_BYTES);
	// The run takes the prefetch into its adoption check, with its size.
	const prepared = h.memory.preparedWindow(await h.window());
	expect(prepared.pins).toEqual(first.pins);
	expect(prepared.prefetchBytes).toBe(first.bytes);

	// No query: the earlier prefetch stays.
	await run(query());
	expect(await prefetchOf(h)).toEqual(first);
	// A query whose embedding fails: it stays too.
	e.state.mode = "throw";
	await run(query("京都 旅行"));
	expect(await prefetchOf(h)).toEqual(first);
	e.state.mode = "ok";
	// A query that finds nothing empties it.
	await run(query("宇宙 旅行"));
	expect(await prefetchOf(h)).toEqual({ text: "", pins: [], bytes: 0 });
	// And a topic found by another query replaces it.
	await run(query("北海道"));
	const hokkaido = await prefetchOf(h);
	expect(hokkaido.text).toContain("北海道の話2");
	expect(hokkaido.text).not.toContain("京都の話1");
});

test("a prefetched exchange whose message changed makes the run's window stale", async () => {
	const e = fakeEmbed();
	const h = await setup(e.embed);
	await longConversation(h);
	const last = await h.say("user", "最新の発言です");
	await h.setCursor(h.ordinal(last) - 1);
	h.inference.state.script = () =>
		JSON.stringify({ ops: [], prefetch: { query: "京都" } });
	await h.schedule();
	await h.settled();
	const window = await h.window();
	expect(window.prefetch.pins.length).toBeGreaterThan(0);
	const prepared = h.memory.preparedWindow(window);
	const verdict = () =>
		h.store.read((db) =>
			h.memory.validateWindowInTransaction(db, "run-x", prepared),
		);
	expect(verdict()).toEqual({ ok: true });
	await h.store.write((db) =>
		db
			.query("UPDATE messages SET text = ? WHERE id = ?")
			.run("書き換え", window.prefetch.pins[0]!.messageId),
	);
	expect(verdict()).toEqual({ ok: false, reason: "memory_stale" });
});
