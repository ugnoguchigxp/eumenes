import { expect, test } from "bun:test";
import { defaults } from "../../domains/settings";
import {
	setup as dialogueSetup,
	reply,
} from "../../domains/dialogue/test/generation.fixture";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { agencyReplyParts } from "./system-context";
import { LEFT_OUT, agendaReplyRules, missingLeftOut } from "./always-on-system";

test("the real dialogue composes Eumenes-owned reply parts and keeps user text outside system", async () => {
	const settings = defaults({});
	settings.general.agentName = "ConversationEumenes";
	settings.agency.interests = ["HostInterest"];
	settings.agency.emotion = true;
	const h = await dialogueSetup({
		conversationAgent: {
			...testConversationAgent,
			system: () => agencyReplyParts(settings.agency, true),
		},
		settings,
		cards: [],
		agency: {
			stateForContextInTransaction: () => [
				"AGENCY_STATE_SENTINEL: work result",
			],
		},
	});
	try {
		h.state.steps.push(...reply("🙂おはようございます。"));
		await h.say("USER_SENTINEL");
		const call = h.state.calls.at(-1)!;
		const systems = call.messages.filter((m) => m.role === "system");
		expect(systems).toHaveLength(1);
		const system = systems[0]!.content;
		expect(system).toContain("パーソナルエージェント");
		expect(system).not.toContain("Eumenes の会話を担当");
		expect(system).toContain("ConversationEumenes");
		expect(system).toContain("HostInterest");
		expect(system).toContain("Emotion");
		expect(system).not.toContain("USER_SENTINEL");
		expect(system).not.toContain("AGENCY_STATE_SENTINEL");
		expect(
			call.messages
				.filter((m) => m.role !== "system")
				.some((m) => m.content.includes("AGENCY_STATE_SENTINEL")),
		).toBe(true);
		expect(system).not.toContain("あなたは利用者と自然に会話する相手です。");
		expect(call.messages.at(-1)?.content).toContain("USER_SENTINEL");
	} finally {
		await h.close();
	}
});

test("the agenda reply's system says where the memory is, and keeps the quiet and date rules the package's lines carried", () => {
	const base = agencyReplyParts(defaults({}).agency, true).base;
	// The memory is read in `## Memory` and with `read_memory`; the state is the last user message's `## Agency`.
	expect(base).toContain("`## Agency`");
	expect(base).toContain("`## Memory`");
	expect(base).toContain("read_memory");
	expect(base).not.toContain(
		"利用者について覚えていること（記憶）と、調べもの担当",
	);
	// A short pause does not promise today, tonight or never speaking again.
	expect(base).toContain("「今日は」「今夜は」「もう話しかけません」");
	// The quiet time ends when the user speaks; only a clear wish for more quiet sets it again.
	expect(base).toContain("利用者が話しかけると終わります");
	expect(base).toContain("もう一度 set_quiet で決めます");
	// The date is the `## State` time (`今:`), not the state's removed `now`.
	expect(base).toContain("`## State` の「今:」の日付");
	expect(base).not.toContain("now の日付");
});

test("the package's left-out lines are matched as whole lines and are all still in the package", () => {
	// A change in the package's text is seen here (not in a reply): a left-out line it no longer has fails this test.
	expect(missingLeftOut()).toEqual([]);
	const rules = agendaReplyRules().split("\n");
	for (const left of LEFT_OUT) expect(rules).not.toContain(left);
	// Whole lines: no left-out line stands for another that merely starts with it.
	for (const left of LEFT_OUT)
		expect(LEFT_OUT.filter((other) => other.startsWith(left))).toEqual([left]);
});
