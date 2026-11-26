import { expect, test } from "bun:test";
import { createAgendaAgent } from "eumenes-agency/agenda";
import { keepsPromise, mayStep } from "./always-on-cycle";
import type { AgendaScope } from "./always-on-scope";

/**
 * The agenda steps the conversation on screen; a conversation the agent owes work to (an assignment or research
 * waiting or running, a report not told yet) steps too, so work asked there starts and its result is told there.
 */
function scope(id: string) {
	const agent = createAgendaAgent({
		llm: { call: async () => ({ text: "" }) },
		startedAt: 0,
		notes: () => [],
	} as unknown as Parameters<typeof createAgendaAgent>[0]);
	agent.observe({ id: `${id}-u1`, who: "user", text: "絵を描いて", at: 0 });
	return { id, agent, tickets: [] } as unknown as AgendaScope;
}
function host(active: string, convs: AgendaScope[]) {
	return {
		on: () => true,
		active: () => active,
		convs: new Map(convs.map((c) => [c.id, c])),
		busy: () => false,
		deps: { store: { read: () => false } },
	} as unknown as Parameters<typeof mayStep>[0];
}

test("a conversation not on screen steps only while the agent owes it an assignment", () => {
	const main = scope("main");
	const other = scope("verify");
	const h = host("main", [main, other]);
	expect(mayStep(h, main)).toBe(true);
	expect(keepsPromise(other)).toBe(false);
	expect(mayStep(h, other)).toBe(false);
	const asked = other.agent.requestResearch({
		text: "夕焼けの海の絵を描く",
		at: 0,
		delegatedTo: "画像生成",
	});
	expect("item" in asked).toBe(true);
	expect(keepsPromise(other)).toBe(true);
	expect(mayStep(h, other)).toBe(true);
	// Ended (here: cancelled): nothing is owed any more.
	other.agent.assignmentEnded({
		itemId: (asked as { item: { id: string } }).item.id,
		at: 1,
		status: "dropped",
	});
	expect(mayStep(h, other)).toBe(false);
});
