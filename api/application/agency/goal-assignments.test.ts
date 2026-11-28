import { expect, test } from "bun:test";
import { createAgendaAgent } from "eumenes-agency/agenda";
import { controlAssignment } from "./always-on-assignments";
import { collectAgendaResults } from "./always-on-cycle";
import type { AgendaScope } from "./always-on-scope";
import {
	GOAL_ASSIGNEE,
	goalNote,
	goalTicket,
	offerGoalItems,
	type GoalWorkPort,
	type GoalWorkView,
} from "./goal-assignments";
import type { AgencyHostDeps } from "./host-types";

/**
 * Registered goals reach the user as the agent's own assignments (spec goal-results-as-assignments-2026-11-26.md):
 * the goal is an item beside the user's other requests, its question is the agent's to ask, the user's answer goes
 * back to the goal, and its report is a work-report note the agent tells.
 */
const goalText =
	"Live2Dの背景を設定でさまざまな色に変更できるようにすること。達成条件は、設定から背景色を変更できること。";
const view = (extra: Partial<GoalWorkView> = {}): GoalWorkView => ({
	goalId: "goal-1",
	revision: 1,
	slot: 1,
	text: goalText,
	conversationId: "main",
	sourceMessageId: "m1",
	progress: "実行中: act 読取",
	question: null,
	report: null,
	...extra,
});

function scope() {
	let clock = 0;
	const agent = createAgendaAgent({
		persona: { name: "test" },
		llm: { call: async () => ({ text: "" }) },
		now: () => clock,
	} as unknown as Parameters<typeof createAgendaAgent>[0]);
	agent.observe({ id: "m1", who: "user", text: goalText, at: 0 });
	const calls: string[] = [];
	const c = {
		id: "main",
		scope: "s",
		agent,
		tickets: [],
		notes: [],
		retired: [],
		assignments: new Map(),
		observed: new Map(),
		finished: new Map(),
		thoughts: [],
		thoughtSeq: 0,
		thoughtsChanged: () => {},
		revision: 0,
		closed: new AbortController(),
		kick: () => calls.push("kick"),
	} as unknown as AgendaScope;
	return {
		c,
		calls,
		tick: (ms: number) => {
			clock += ms;
			return clock;
		},
	};
}

/** The agent's item of the goal, issued by the agent and held as the goal's ticket (what `startResearch` does). */
async function held(c: AgendaScope, shown: GoalWorkView) {
	expect(offerGoalItems(c, [shown], 1)).toBe(true);
	// Quiet: the step issues the assignment's ticket and plans nothing (no model).
	c.agent.setQuiet({ scope: "all", minutes: 60, at: 1 });
	const step = await c.agent.step(
		2,
		() => ({}) as never,
		new AbortController().signal,
	);
	const issued = step.tickets.find((t) => t.kind === "research")!;
	const item = c.agent.view().items.find((i) => i.id === issued.itemId)!;
	const ticket = goalTicket(
		{ ...issued, refs: [...issued.refs] },
		item.text,
		[shown],
		c.id,
	)!;
	c.tickets.push(ticket);
	c.agent.researchStarted(ticket.id, true, 2);
	return { item, ticket };
}

test("each goal of the conversation is the agent's item once, resting on the user's words", async () => {
	const { c } = scope();
	const { item, ticket } = await held(c, view());
	expect(item).toMatchObject({
		kind: "research",
		delegatedTo: GOAL_ASSIGNEE,
		text: goalText,
		refs: ["m1"],
	});
	expect(ticket).toMatchObject({
		itemId: item.id,
		goal: { goalId: "goal-1", revision: 1 },
		inputs: [],
	});
	expect(offerGoalItems(c, [view()], 2)).toBe(false);
	expect(offerGoalItems(c, [view({ conversationId: "other" })], 2)).toBe(false);
	expect(
		c.agent.view().items.filter((i) => i.delegatedTo === GOAL_ASSIGNEE),
	).toHaveLength(1);
});

function host(c: AgendaScope, work: GoalWorkPort) {
	const saved: unknown[] = [];
	const deps = {
		store: {
			read: (fn: (db: unknown) => unknown) => fn({}),
			write: async (fn: (db: unknown) => unknown) => fn({}),
		},
		state: {
			resultsInTransaction: () => [],
			assignmentViewInTransaction: () => null,
		},
		goalWork: work,
	} as unknown as AgencyHostDeps;
	return {
		deps,
		saved,
		host: {
			deps,
			convs: new Map([[c.id, c]]),
			now: () => 5,
			conv: () => c,
			saveInTransaction: (_db: unknown, patch: unknown) => saved.push(patch),
			collected: () => {},
		} as unknown as Parameters<typeof collectAgendaResults>[0],
	};
}

test("a goal's question is the agent's to ask, and the user's answer goes back to the goal", async () => {
	const { c } = scope();
	const asked = view({
		progress: "回答を待っている",
		question: { ref: "q1", prompt: "背景色を確かめる方法を指定できますか？" },
	});
	const { item } = await held(c, asked);
	const controls: string[] = [];
	const work: GoalWorkPort = {
		viewsInTransaction: () => [asked],
		heldUntilInTransaction: () => null,
		reportedInTransaction: () => {},
		control: async ({ action, text, messageId, view: shown }) => {
			controls.push(`${action} ${shown.question?.ref} ${text} ${messageId}`);
			return "answered: 登録目標に回答を渡した";
		},
	};
	const { host: h, deps } = host(c, work);
	await collectAgendaResults(h);
	expect(c.agent.view().items.find((i) => i.id === item.id)).toMatchObject({
		question: "背景色を確かめる方法を指定できますか？",
		progress: "回答を待っている",
	});
	// The agent owes the user the question, once.
	expect(
		c.agent
			.view()
			.items.filter(
				(i) => i.kind === "talk" && i.text.includes("背景色を確かめる方法"),
			),
	).toHaveLength(1);
	const out = await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({
			id: item.id,
			action: "answer",
			text: "試験で確かめて",
		}),
		messageId: "m2",
		at: 6,
		save: async () => true,
	});
	expect(out.content).toBe("answered: 登録目標に回答を渡した");
	expect(controls).toEqual(["answer q1 試験で確かめて m2"]);
	// Without the user's words nothing reaches the goal.
	expect(
		(
			await controlAssignment({
				deps,
				c,
				arguments: JSON.stringify({ id: item.id, action: "answer", text: "x" }),
				messageId: undefined,
				at: 7,
				save: async () => true,
			})
		).content,
	).toBe("refused: utterance_required");
});

test("a met goal's report becomes a work-report note once, told by the agent; the goal's report is marked told", async () => {
	const { c } = scope();
	const met = view({
		progress: null,
		report: {
			id: "r1",
			text: "設定画面から背景色を保存し、描画に反映されることを試験で確かめた。",
			checked: ["useAvatarBackdrop.test.tsx: 保存・削除・失敗時の保持"],
			sources: ["memory-input:proof"],
		},
	});
	const { item, ticket } = await held(c, met);
	const reported: string[] = [];
	const work: GoalWorkPort = {
		viewsInTransaction: () => (reported.length ? [] : [met]),
		heldUntilInTransaction: () => null,
		reportedInTransaction: (_db, shown) => reported.push(shown.report!.id),
		control: async () => "",
	};
	const { host: h, saved } = host(c, work);
	await collectAgendaResults(h);
	expect(reported).toEqual(["r1"]);
	expect(saved).toHaveLength(1);
	expect(c.tickets).toEqual([]);
	expect(c.notes).toHaveLength(1);
	expect(c.notes[0]).toMatchObject({
		title: `作業報告: ${goalText.slice(0, 50)}`,
		ticketId: ticket.id,
		refs: ["m1"],
	});
	expect(c.notes[0]!.markdown).toContain("## 確かめたこと");
	// The note rests on what the report rests on: forgetting that takes the note too.
	expect(c.notes[0]!.inputs).toEqual(["memory-input:proof"]);
	const agent = c.agent.view();
	expect(agent.items.find((i) => i.id === item.id)?.status).toBe("done");
	expect(
		agent.items.filter(
			(i) => i.kind === "talk" && i.text.includes(GOAL_ASSIGNEE),
		),
	).toHaveLength(1);
	await collectAgendaResults(h);
	expect(c.notes).toHaveLength(1);
});

test("a goal that went (withdrawn or revised) ends its item without a word; a cancel withdraws the goal", async () => {
	const { c } = scope();
	const { item } = await held(c, view());
	const { host: gone } = host(c, {
		viewsInTransaction: () => [],
		heldUntilInTransaction: () => null,
		reportedInTransaction: () => {},
		control: async () => "",
	});
	await collectAgendaResults(gone);
	expect(c.tickets).toEqual([]);
	expect(c.agent.view().items.find((i) => i.id === item.id)?.status).toBe(
		"dropped",
	);

	const other = scope();
	const { item: kept } = await held(other.c, view());
	const controls: string[] = [];
	const { deps } = host(other.c, {
		viewsInTransaction: () => [view()],
		heldUntilInTransaction: () => null,
		reportedInTransaction: () => {},
		control: async ({ action }) => {
			controls.push(action);
			return "cancelled: 登録目標を取り下げた";
		},
	});
	const out = await controlAssignment({
		deps,
		c: other.c,
		arguments: JSON.stringify({ id: kept.id, action: "cancel" }),
		messageId: "m3",
		at: 4,
		save: async () => true,
	});
	expect(out.content).toBe("cancelled: 登録目標を取り下げた");
	expect(controls).toEqual(["cancel"]);
	expect(other.c.tickets).toEqual([]);
	expect(other.c.agent.view().items.find((i) => i.id === kept.id)?.status).toBe(
		"dropped",
	);
});

test("the goal's report as a work-report note has the same shape as an assignee's", () => {
	const note = goalNote(
		{
			id: "t1",
			itemId: "i1",
			agentTicketId: "t1",
			revisionId: "goal:goal-1@1",
			question: goalText,
			at: 0,
			refs: ["m1"],
			inputs: [],
			goal: { goalId: "goal-1", revision: 1 },
		},
		view({
			report: {
				id: "r1",
				text: "確かめた。",
				checked: ["試験4件"],
				sources: ["memory-input:proof"],
			},
		}),
		9,
	);
	expect(note.markdown).toBe(
		[
			`# 作業報告: ${goalText.slice(0, 50)}`,
			"## 依頼",
			goalText,
			"## 結果",
			"確かめた。",
			"## 確かめたこと\n\n- 試験4件",
		].join("\n\n"),
	);
});

test("an answer to a question the goal no longer asks is refused; an item not issued yet still reaches its goal", async () => {
	const { c } = scope();
	const first = view({
		question: { ref: "q1", prompt: "背景色を確かめる方法を指定できますか？" },
	});
	const { item } = await held(c, first);
	let shown = first;
	const controls: string[] = [];
	const work: GoalWorkPort = {
		viewsInTransaction: () => [shown],
		heldUntilInTransaction: () => null,
		reportedInTransaction: () => {},
		control: async ({ action }) => {
			controls.push(action);
			return `${action}: ok`;
		},
	};
	const { host: h, deps } = host(c, work);
	await collectAgendaResults(h);
	// The goal moved on to another question before the user's answer came.
	shown = view({ question: { ref: "q2", prompt: "別の質問" } });
	const answer = (id: string) =>
		controlAssignment({
			deps,
			c,
			arguments: JSON.stringify({ id, action: "answer", text: "試験で" }),
			messageId: "m2",
			at: 6,
			save: async () => true,
		});
	expect((await answer(item.id)).content).toBe(
		"refused: goal_question_not_current",
	);
	expect(controls).toEqual([]);

	// After a restart, before the agent issues the item again, a cancel still withdraws the goal.
	const other = scope();
	expect(offerGoalItems(other.c, [view()], 1)).toBe(true);
	const pending = other.c.agent
		.view()
		.items.find((i) => i.delegatedTo === GOAL_ASSIGNEE)!;
	const { deps: otherDeps } = host(other.c, {
		...work,
		viewsInTransaction: () => [view()],
	});
	const out = await controlAssignment({
		deps: otherDeps,
		c: other.c,
		arguments: JSON.stringify({ id: pending.id, action: "cancel" }),
		messageId: "m3",
		at: 7,
		save: async () => true,
	});
	expect(out.content).toBe("cancel: ok");
	expect(controls).toEqual(["cancel"]);
});
