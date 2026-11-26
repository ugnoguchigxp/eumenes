import { afterEach, expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import type { AgencyLayerPort, ConversationAgentPort } from "../contracts";
import { testConversationAgent } from "./conversation-agent.fixture";
import { byId } from "../repository";
import type { ExecutorContext } from "../service/executor-context";
import { delegate as delegateTool } from "../service/executor-delegation";
import { agencyOf, IMAGE, setup, type Harness } from "./generation.fixture";
import {
	IMAGE as PINNED_IMAGE,
	setup as setupSpecialist,
} from "./specialist.fixture";

/**
 * `assign` changes the agent's memory outside the transaction, so it is the last statement of the writer: a write
 * that throws earlier leaves no assignment (a resend is then not refused as a duplicate).
 */

/** An agent whose reply hands work over (the agenda's, in the application). */
const handing: ConversationAgentPort = {
	...testConversationAgent,
	handsWork: () => true,
};

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function delegateWith(
	agency: AgencyLayerPort,
	acted: () => unknown,
	card: ToolchainCard = { ...IMAGE, minImpact: "modify_existing" },
) {
	const run = await h!.say("壁紙を変えてほしい");
	const x = {
		deps: {
			store: h!.store,
			conversation: h!.conversation,
			continuity: h!.continuity,
			clock: () => new Date().toISOString(),
			agency,
			toolchains: {
				catalogInTransaction: () => [
					{
						id: card.id,
						revisionId: card.revisionId,
						runtime: { execution: card.execution },
					},
				],
				recordSelectionInTransaction: () => "selection",
			},
		},
		offered: new Map([[card.id, card]]),
		input: { conversationId: "main", offers: [] },
		state: { newlyOffered: new Set<string>(), search: null, exchange: [] },
		current: (db: Parameters<typeof byId>[0]) => byId(db, run.id)!,
		acted,
		actionKey: (target: string) => target,
	} as unknown as ExecutorContext;
	const args = { toolchain: card.id, request: "壁紙を夕暮れの猫に差し替える" };
	return delegateTool(
		x,
		{
			name: "delegate",
			call: { id: "c1", name: "delegate", arguments: JSON.stringify(args) },
			args,
		},
		args,
		new AbortController().signal,
	);
}

test("delegate: an event write that throws leaves no assignment, and the resend is handed over", async () => {
	h = await setup({ conversationAgent: handing });
	h.state.steps.push({ text: "承知しました。" }, { text: "承知しました。" });
	const { agency, assigned } = agencyOf();
	await expect(
		delegateWith(agency, () => {
			throw new Error("event_write_failed");
		}),
	).rejects.toThrow("event_write_failed");
	expect(assigned).toHaveLength(0);
	// The writer's last statement is the assignment: with the event written first, the resend is accepted.
	const outcome = await delegateWith(agency, () => ({}));
	expect(outcome.result).toMatchObject({ delegated: true, assignment: "a1" });
	expect(assigned).toHaveLength(1);
});

test("pinned submit: a selection record that throws leaves no assignment", async () => {
	const { agency, assigned } = agencyOf();
	const p = await setupSpecialist({ agency });
	try {
		p.state.selectionError = "selection_write_failed";
		const run = await p.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "猫を描いて",
			presentation: "artifact",
			toolchainId: PINNED_IMAGE.id,
		});
		await p.finished(run.id);
		expect(p.dialogue.get(run.id)?.status).toBe("failed");
		expect(assigned).toHaveLength(0);
	} finally {
		await p.close();
	}
});
