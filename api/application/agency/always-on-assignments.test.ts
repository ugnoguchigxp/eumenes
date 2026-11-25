import { expect, test } from "bun:test";
import { createAgendaAgent } from "eumenes-agency/agenda";
import { controlAssignment } from "./always-on-assignments";
import { noteFromResult } from "./always-on-memory";
import type { AgendaScope } from "./always-on-scope";
import {
	agendaSources,
	forgetAgenda,
	type AgendaHostSnapshot,
} from "../../domains/dialogue/contracts/agency-always-on";
import type { AgencyHostDeps } from "./host-types";

/**
 * Work the user asks a toolchain for is the agent's own assignment (spec toolchain-assignment-as-research-2026-11-25.md):
 * its result comes back as a work report note, and the reply answers, amends or cancels it through the assignee's
 * own control.
 */
const ticket = {
	id: "t1",
	itemId: "i1",
	agentTicketId: "t1",
	revisionId: "toolchain:claude-code.request@1",
	question: "設定から背景色を変更できる機能を実装する",
	at: 0,
	refs: ["m1"],
	inputs: ["m1"],
	assignment: true as const,
	references: [],
};

test("an assignment's result becomes a work report note: request, result, what was done, what is left, what it made", () => {
	const note = noteFromResult({
		id: "n1",
		ticket,
		summary: JSON.stringify({
			status: "partial",
			summary: "背景色の設定欄を追加した。",
			fulfilled: ["設定の表示欄に背景色を追加した"],
			missing: ["実画面での確認"],
			links: ["eumenes://image/a"],
		}),
		at: 5,
	});
	expect(note).toMatchObject({
		id: "n1",
		title: "作業報告: 設定から背景色を変更できる機能を実装する",
		summary: "背景色の設定欄を追加した。",
		refs: ["m1"],
		ticketId: "t1",
	});
	expect(note!.markdown).toBe(
		[
			"# 作業報告: 設定から背景色を変更できる機能を実装する",
			"## 依頼",
			"設定から背景色を変更できる機能を実装する",
			"## 結果",
			"背景色の設定欄を追加した。",
			"## 達成したこと\n\n- 設定の表示欄に背景色を追加した",
			"## 残ったこと\n\n- 実画面での確認",
			"## 作ったもの\n\n- eumenes://image/a",
		].join("\n\n"),
	);
});

test("an assignment that brought nothing back is no note (the agent tells it failed)", () => {
	expect(
		noteFromResult({
			id: "n1",
			ticket,
			summary: JSON.stringify({ status: "failed", fulfilled: [] }),
			at: 5,
		}),
	).toBeNull();
});

function scopeWith(running: boolean) {
	const agent = createAgendaAgent({
		persona: { name: "test" },
		llm: { call: async () => ({ text: "" }) },
		now: () => 0,
	} as unknown as Parameters<typeof createAgendaAgent>[0]);
	agent.observe({ id: "m1", who: "user", text: "Claude Codeで作って", at: 0 });
	const asked = agent.requestResearch({
		text: ticket.question,
		at: 0,
		delegatedTo: "Claude Code",
	});
	if (!("item" in asked)) throw new Error("not_taken");
	const calls: string[] = [];
	const c = {
		agent,
		tickets: running ? [{ ...ticket, itemId: asked.item.id }] : [],
		assignments: new Map([[asked.item.id, {}]]),
		observed: new Map(),
		scope: "s",
		revision: 0,
		kick: () => calls.push("kick"),
	} as unknown as AgendaScope;
	const deps = {
		store: {
			write: async (fn: (db: unknown) => unknown) => fn({}),
		},
		state: {
			cancelInTransaction: (_db: unknown, root: string) =>
				calls.push(`cancel ${root}`),
			controlAssignmentInTransaction: (
				_db: unknown,
				root: string,
				input: { action: string; text: string },
				messageId: string,
			) => calls.push(`${input.action} ${root} ${input.text} ${messageId}`),
		},
	} as unknown as AgencyHostDeps;
	return { c, deps, calls, id: asked.item.id };
}

test("a cancel stops the running work at its owner and drops the agent's item without a failure", async () => {
	const { c, deps, calls, id } = scopeWith(true);
	const out = await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({ id, action: "cancel" }),
		messageId: "m2",
		at: 1,
	});
	expect(out.content).toBe("cancelled: Claude Codeへの依頼をやめた");
	expect(calls).toEqual(["cancel agency:s:t1", "kick"]);
	expect(c.tickets).toEqual([]);
	expect(c.assignments.size).toBe(0);
	expect(c.agent.view().items.find((i) => i.id === id)?.status).toBe("dropped");
});

test("an answer goes to the assignee's control as the user's words; one not started yet or without text is refused", async () => {
	const running = scopeWith(true);
	expect(
		(
			await controlAssignment({
				deps: running.deps,
				c: running.c,
				arguments: JSON.stringify({
					id: running.id,
					action: "answer",
					text: "会話画面の背景です",
				}),
				messageId: "m2",
				at: 1,
			})
		).content,
	).toBe("answered: Claude Codeに回答を渡した");
	expect(running.calls).toEqual([
		"answer agency:s:t1 会話画面の背景です m2",
		"kick",
	]);
	expect(
		(
			await controlAssignment({
				deps: running.deps,
				c: running.c,
				arguments: JSON.stringify({ id: running.id, action: "answer" }),
				messageId: "m2",
				at: 1,
			})
		).content,
	).toBe("refused: text_required");
	const waiting = scopeWith(false);
	expect(
		(
			await controlAssignment({
				deps: waiting.deps,
				c: waiting.c,
				arguments: JSON.stringify({
					id: waiting.id,
					action: "amend",
					text: "色は青",
				}),
				messageId: "m2",
				at: 1,
			})
		).content,
	).toBe("refused: not_started（担当はまだ始めていない）");
	expect(
		(
			await controlAssignment({
				deps: waiting.deps,
				c: waiting.c,
				arguments: JSON.stringify({ id: "unknown", action: "cancel" }),
				messageId: "m2",
				at: 1,
			})
		).content,
	).toBe("refused: assignment_not_found");
});

test("a reply to no words of the user's (a notice, its own speech) cannot cancel an assignment", async () => {
	const { c, deps, calls, id } = scopeWith(true);
	const out = await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({ id, action: "cancel" }),
		messageId: undefined,
		at: 1,
	});
	expect(out.content).toBe("refused: utterance_required");
	expect(calls).toEqual([]);
	expect(c.agent.view().items.find((i) => i.id === id)?.status).not.toBe(
		"dropped",
	);
});

test("forgetting the words an assignment was asked in takes its start details out of the checkpoint", () => {
	const source = {
		conversationId: "ao",
		messageId: "m1",
		runId: "r1",
		request: "Claude Codeで作って",
		digest: "d",
	};
	const snapshot = {
		kind: "agenda",
		version: 1,
		revision: 0,
		agent: { items: [{ id: "i1", refs: ["m1"] }] },
		tickets: [],
		notes: [],
		assignments: [
			{
				itemId: "i1",
				toolchainId: "claude-code.request",
				revisionId: "r",
				title: "Claude Code",
				references: [],
				source,
			},
		],
	} as unknown as AgendaHostSnapshot;
	expect(agendaSources(snapshot)).toContain("m1");
	expect(forgetAgenda(snapshot, new Set(["m1"])).assignments).toEqual([]);
});
