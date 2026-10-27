import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ChatMessage } from "../service/context";
import type { KeeperInference } from "../service/context-keeper";
import { sectionLines, setup, type Harness } from "./generation.fixture";

/**
 * The context keeper (the conversation input specification, section 7.3): after the agent's utterance reached the
 * user and the talk is quiet, it reads the conversation on its prompt, writes the next version of the state and may
 * move the cut; the next generation shows what it kept. Its output is checked by the host before it is taken.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

type KeeperCall = { messages: ChatMessage[]; maxOutputTokens: number };

/** A scripted inference for the keeper: each call answers the next output (JSON text) and records what it read. */
function keeperInference(outputs: string[]) {
	const calls: KeeperCall[] = [];
	const accepted: string[] = [];
	const rejected: string[] = [];
	let limit = 0;
	const inference: KeeperInference = {
		captureMaintenanceControlInTransaction: (_db, input) => {
			limit = input.maxOutputTokens;
			return `keeper-${calls.length + 1}`;
		},
		executeControl: async (requestId, messages) => {
			calls.push({
				messages: messages as ChatMessage[],
				maxOutputTokens: limit,
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

test("after a reply the keeper reads the shared prefix with its own sections, and the next input shows the state it kept", async () => {
	const k = keeperInference([
		JSON.stringify({
			ops: [
				{ op: "set_topic", text: "元気が出る曲を作る" },
				{ op: "add_decision", text: "アップテンポの曲（10-27、本人の希望）" },
			],
		}),
	]);
	h = await setup({ keeper: { inference: k.inference, quietMs: 10 } });
	h.state.steps.push({ text: "作りますね。" }, { text: "はい。" });
	await h.say("元気が出る曲、アップテンポで");
	await waitFor(() => k.accepted.length === 1);
	const [read] = keeperCalls(k);
	const last = read!.messages.at(-1)!.content;
	// Its prefix is the next generation's: the system part, then the agent's reply.
	expect(read!.messages.slice(0, -1).map((m) => [m.role, m.content])).toEqual([
		["system", h.state.calls[0]!.messages[0]!.content],
		["user", "## Memory\n- なし"],
		["assistant", "作りますね。"],
	]);
	expect(sectionLines(last, "Points")[0]).toBe(
		"- 未反映の始まり:「作りますね。」",
	);
	expect(last).toContain("## Candidates\n- なし");
	expect(last).toMatch(/\n## Task\n/);
	await h.say("どんな曲になる？");
	const next = h.state.calls.at(-1)!.messages.at(-1)!.content;
	expect(sectionLines(next, "State")).toEqual(
		expect.arrayContaining([
			"話題: 元気が出る曲を作る",
			"決まったこと:",
			"- アップテンポの曲（10-27、本人の希望）",
		]),
	);
	// The state's own numbers are the keeper's only.
	expect(next).not.toContain("- d1 ");
});

test("an output that breaks a rule is refused whole and the state stays as it was", async () => {
	const k = keeperInference([
		JSON.stringify({
			ops: [
				{ op: "set_topic", text: "乗換" },
				{ op: "add_decision", text: "詳しくは https://example.com を見る" },
			],
		}),
	]);
	h = await setup({ keeper: { inference: k.inference, quietMs: 10 } });
	h.state.steps.push({ text: "調べますね。" }, { text: "はい。" });
	await h.say("乗換を調べて");
	await waitFor(() => k.rejected.length === 1);
	expect(k.rejected).toEqual(["keeper-1:context_refused"]);
	expect(k.accepted).toEqual([]);
	await h.say("それで？");
	expect(
		sectionLines(h.state.calls.at(-1)!.messages.at(-1)!.content, "State").some(
			(line) => line.startsWith("話題:"),
		),
	).toBe(false);
});

test("the keeper's cut moves the recent conversation, and the new prefix is read ahead", async () => {
	// Two empty outputs, then a cut before a2 (the first point it is offered).
	const k = keeperInference([
		'{"ops":[]}',
		'{"ops":[]}',
		JSON.stringify({ ops: [{ op: "cut_before", point: "k1" }] }),
	]);
	h = await setup({ keeper: { inference: k.inference, quietMs: 10 } });
	h.state.steps.push(
		{ text: "a1" },
		{ text: "a2" },
		{ text: "a3" },
		{ text: "a4" },
	);
	await h.say("u1");
	await waitFor(() => k.accepted.length === 1);
	await h.say("u2");
	await waitFor(() => k.accepted.length === 2);
	await h.say("u3");
	await waitFor(() => k.accepted.length === 3);
	// The third keeper call was offered the points; it cut before the first, and a warm-up followed.
	expect(
		sectionLines(keeperCalls(k)[2]!.messages.at(-1)!.content, "Points"),
	).toContain("- k1「a2」の前で区切れる");
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
	h = await setup({ keeper: { inference: k.inference, quietMs: 200 } });
	h.state.steps.push({ text: "はい。" }, { text: "どうぞ。" });
	await h.say("一つ目");
	// Spoken again before the quiet wait ends: the keeper does not run in between.
	await h.say("二つ目");
	expect(keeperCalls(k)).toHaveLength(0);
	await waitFor(() => keeperCalls(k).length === 1);
	// It read both replies in one call.
	expect(
		sectionLines(keeperCalls(k)[0]!.messages.at(-1)!.content, "Points")[0],
	).toBe("- 未反映の始まり:「はい。」");
});
