import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { StewardPort } from "../contracts";
import { testConversationAgent } from "./conversation-agent.fixture";
import { choice, setup, type Harness } from "./generation.fixture";

/**
 * The id of a `memory` request is unique across conversations (spec/memory-recall-implementation-2026-11-23.md
 * section 2.4): two conversations whose utterances have the same numbers and ask for the same target do not meet the
 * steward inbox's `request_conflict`.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The steward's inbox rule that matters here: a row id another conversation made is refused. */
function conflictingSteward() {
	const owners = new Map<string, string>();
	const ids: string[] = [];
	const steward: StewardPort = {
		runEndedInTransaction: () => {},
		requestInTransaction: (_db, input) => {
			const id = input.requestId ?? crypto.randomUUID();
			ids.push(id);
			const owner = owners.get(id);
			if (owner !== undefined && owner !== input.conversationId)
				throw new Error("request_conflict");
			owners.set(id, input.conversationId);
			return { id, replay: owner !== undefined };
		},
		excludedInTransaction: () => true,
		targetRequestInTransaction: () => {},
		hasPendingForgetInTransaction: () => false,
		takeUnresolvedTargetsInTransaction: () => [],
	};
	return { steward, ids };
}

const toolResults = (calls: Harness["state"]["calls"]) =>
	calls.flatMap((call) =>
		call.messages
			.filter((m) => (m.role as string) === "tool")
			.map((m) => String(m.content)),
	);

async function say(conversationId: string, text: string) {
	const accepted = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId,
		text,
	});
	await waitFor(() => h!.dialogue.get(accepted.id)?.status === "completed");
	return h!.dialogue.get(accepted.id)!;
}

const forget = {
	calls: [
		{
			name: "memory",
			args: {
				operation: "request",
				kind: "forget",
				what: "元カノの話は全部",
			},
		},
	],
};

test("the same utterance numbers and the same forget target in two conversations are both accepted", async () => {
	const { steward, ids } = conflictingSteward();
	h = await setup({
		memory: true,
		steward,
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
	});
	for (const conversationId of ["main", "other"]) {
		h.state.steps.push(choice({ choice: "none" }), forget, {
			text: "対象を探します。",
		});
		const run = await say(conversationId, "元カノの話は全部忘れて");
		expect(run.error).toBeNull();
	}
	const results = toolResults(h.state.calls);
	expect(results.join("\n")).not.toContain("request_conflict");
	expect(
		results.filter((r) => r.includes('"status":"resolving"')),
	).toHaveLength(2);
	// The two rows are different, and each carries its conversation.
	expect(new Set(ids).size).toBe(2);
	expect(ids.some((id) => id.startsWith("main:"))).toBe(true);
	expect(ids.some((id) => id.startsWith("other:"))).toBe(true);
	expect(h.state.targetRequests.map((r) => r.requestId)).toEqual(ids);
});

test("the same request asked again in one conversation is the same row", async () => {
	const { steward, ids } = conflictingSteward();
	h = await setup({
		memory: true,
		steward,
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
	});
	h.state.steps.push(choice({ choice: "none" }), forget, forget, {
		text: "対象を探します。",
	});
	await say("main", "元カノの話は全部忘れて");
	// A retried call finds the first: the steward is asked once.
	expect(ids).toHaveLength(1);
	expect(ids[0]).toStartWith("main:");
});
