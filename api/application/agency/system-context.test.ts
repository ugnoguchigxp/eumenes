import { expect, test } from "bun:test";
import { defaults } from "../../domains/settings";
import {
	setup as dialogueSetup,
	reply,
} from "../../domains/dialogue/test/generation.fixture";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { agencyReplyParts } from "./system-context";

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
			workChangedInTransaction() {},
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
		expect(system).toContain("Eumenes の会話を担当");
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
