import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ChatMessage } from "../service/context";
import {
	KEEPER_SCHEMA,
	keeperOutput,
	type KeeperInference,
} from "../service/context-keeper";
import { sectionLines, setup, type Harness } from "./generation.fixture";

/**
 * The context keeper (the conversation input specification, section 7.3): after the agent's utterance reached the
 * user and the talk is quiet, it reads the conversation on its prompt under a strict schema and may move the cut.
 * Its output is checked by the host before it is taken; what it writes of the state is held until it passes its
 * evaluation (the tool-call reliability design, P2).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

type KeeperCall = {
	messages: ChatMessage[];
	maxOutputTokens: number;
	structuredOutput: boolean;
	outputSchema: unknown;
};

/** A scripted inference for the keeper: each call answers the next output (JSON text) and records what it read. */
function keeperInference(outputs: string[]) {
	const calls: KeeperCall[] = [];
	const accepted: string[] = [];
	const rejected: string[] = [];
	let limit = 0;
	let structured = false;
	const inference: KeeperInference = {
		captureMaintenanceControlInTransaction: (_db, input) => {
			limit = input.maxOutputTokens;
			structured = !!input.structuredOutput;
			return `keeper-${calls.length + 1}`;
		},
		executeControl: async (requestId, messages, _signal, control) => {
			calls.push({
				messages: messages as ChatMessage[],
				maxOutputTokens: limit,
				structuredOutput: structured,
				outputSchema: control?.outputSchema,
			});
			// A warm-up asks for one token: its answer is dropped.
			const value = limit === 1 ? "{}" : (outputs.shift() ?? '{"ops":[]}');
			return { requestId, attemptId: `${requestId}-a`, value };
		},
		acceptInTransaction: (_db, receipt) => {
			accepted.push(receipt.requestId);
			return true;
		},
		rejectControlInTransaction: (_db, receipt, code) => {
			rejected.push(`${receipt.requestId}:${code}`);
		},
	};
	return { inference, calls, accepted, rejected };
}

const keeperCalls = (k: ReturnType<typeof keeperInference>) =>
	k.calls.filter((call) => call.maxOutputTokens > 1);

/** Three exchanges: from then on the keeper has a cut point to offer (a2, the newest two stay). */
async function talk(turns = 3) {
	// Each routed turn chooses nothing (there is no judge), then talks.
	h!.state.steps.push(
		...Array.from({ length: turns + 1 }, (_, i) => [
			{ text: JSON.stringify({ choice: "none" }) },
			{ text: `a${i + 1}` },
		]).flat(),
	);
	for (let i = 1; i <= turns; i++) await h!.say(`u${i}`);
}

test("the keeper reads the shared prefix with its own sections under a strict schema, and what it writes of the state is held", async () => {
	const k = keeperInference([
		JSON.stringify({
			ops: [
				{ op: "set_topic", text: "元気が出る曲を作る" },
				{ op: "add_decision", text: "アップテンポの曲（10-27、本人の希望）" },
			],
		}),
	]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
	});
	await talk();
	await waitFor(() => k.accepted.length === 1);
	const [read] = keeperCalls(k);
	const last = read!.messages.at(-1)!.content;
	expect(sectionLines(last, "Points")).toEqual([
		"- 未反映の始まり:「a1」",
		"- k1「a2」の前で区切れる",
	]);
	expect(last).toContain("## Candidates\n- なし");
	expect(last).toMatch(/\n## Task\n/);
	expect(read!.structuredOutput).toBe(true);
	expect(read!.outputSchema).toBe(KEEPER_SCHEMA);
	await h.say("どんな曲になる？");
	const next = h.state.calls.at(-1)!.messages;
	// Its prefix is the next generation's.
	expect(read!.messages.slice(0, -1)).toEqual(
		next.slice(0, -1).map(({ role, content }) => ({ role, content })),
	);
	// Taken (its receipt accepted), but nothing of it reaches `## State`.
	const state = next.at(-1)!.content;
	expect(state).not.toContain("話題:");
	expect(state).not.toContain("アップテンポ");
});

test("with no cut point to offer, the keeper is not called while its state is held", async () => {
	const k = keeperInference([]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
	});
	await talk(2);
	await Bun.sleep(100);
	expect(keeperCalls(k)).toHaveLength(0);
});

test("the keeper's provider schema keeps each op's shape and types, and leaves the bounds to the host", () => {
	const text = JSON.stringify(KEEPER_SCHEMA);
	expect(text).toContain('"anyOf"');
	expect(text).toContain('"enum":["set_topic"]');
	for (const word of [
		'"oneOf"',
		'"const"',
		'"pattern"',
		'"maxLength"',
		'"$schema"',
	])
		expect(text).not.toContain(word);
	// The host still refuses what the schema lets through.
	expect(
		keeperOutput.safeParse({ ops: [{ op: "resolve_open", id: "x1" }] }).success,
	).toBe(false);
});

test("the keeper offers the World names it reads inside one read transaction", async () => {
	const k = keeperInference(['{"ops":[]}']);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
		// World refuses a read outside a transaction, as its host repository does.
		worldContext: {
			knownNamesInTransaction: (db) => {
				if (!db.inTransaction)
					throw new Error("world_host_transaction_required");
				return ["七里ヶ浜駅"];
			},
		},
	});
	await talk();
	await waitFor(() => k.accepted.length === 1);
	expect(
		sectionLines(keeperCalls(k)[0]!.messages.at(-1)!.content, "Candidates"),
	).toEqual(["- w1 七里ヶ浜駅: World に記録がある対象（World）"]);
});

test("a held state op that breaks a rule is only counted: the cut it chose is taken", async () => {
	const k = keeperInference([
		JSON.stringify({
			ops: [
				{ op: "add_decision", text: "詳しくは https://example.com を見る" },
				{ op: "cut_before", point: "k1" },
			],
		}),
	]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
	});
	await talk();
	await waitFor(() => k.accepted.length === 1);
	expect(k.rejected.filter((r) => r.endsWith(":context_refused"))).toEqual([]);
	await h.say("それで？");
	const messages = h.state.calls.at(-1)!.messages;
	expect(messages.slice(2, -1).map((m) => m.content)).toEqual([
		"a2",
		"u3",
		"a3",
	]);
	expect(messages.at(-1)!.content).not.toContain("example.com");
});

test("a cut at a point it was not offered refuses the whole output", async () => {
	const k = keeperInference([
		JSON.stringify({ ops: [{ op: "cut_before", point: "k9" }] }),
	]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
	});
	await talk();
	await waitFor(() => k.rejected.length === 1);
	expect(k.rejected).toEqual(["keeper-1:context_refused"]);
	expect(k.accepted).toEqual([]);
});

test("the keeper's cut moves the recent conversation, and the new prefix is read ahead", async () => {
	const k = keeperInference([
		JSON.stringify({ ops: [{ op: "cut_before", point: "k1" }] }),
	]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 10 },
	});
	await talk();
	await waitFor(() => k.accepted.length === 1);
	// It cut before a2 (the first point it was offered), and a warm-up followed.
	await waitFor(() => k.calls.some((call) => call.maxOutputTokens === 1));
	await h.say("u4");
	const recent = h.state.calls
		.at(-1)!
		.messages.slice(2, -1)
		.map((m) => m.content);
	expect(recent).toEqual(["a2", "u3", "a3"]);
});

test("a user utterance stops the keeper of that conversation: the answer comes first", async () => {
	const k = keeperInference([]);
	h = await setup({
		harness: "local",
		keeper: { inference: k.inference, quietMs: 200 },
	});
	await talk(4);
	// Each utterance came before the quiet wait ended: the keeper did not run in between.
	expect(keeperCalls(k)).toHaveLength(0);
	await waitFor(() => keeperCalls(k).length === 1);
	// It read every reply of the recent conversation (the last two utterances and the reply before them) in one call.
	expect(
		sectionLines(keeperCalls(k)[0]!.messages.at(-1)!.content, "Points")[0],
	).toBe("- 未反映の始まり:「a2」");
});
