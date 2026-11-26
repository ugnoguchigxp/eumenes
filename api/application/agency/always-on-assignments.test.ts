import { expect, test } from "bun:test";
import { createAgendaAgent } from "eumenes-agency/agenda";
import { controlAssignment } from "./always-on-assignments";
import { noteFromResult } from "./always-on-memory";
import type { AgendaScope } from "./always-on-scope";
import {
	agendaSources,
	carryAssignments,
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
		save: async () => {
			calls.push("save");
			return true;
		},
	});
	expect(out.content).toBe("cancelled: Claude Codeへの依頼をやめた");
	// The checkpoint is saved right after the cancel, before the step goes on.
	expect(calls).toEqual(["cancel agency:s:t1", "save", "kick"]);
	expect(c.tickets).toEqual([]);
	expect(c.assignments.size).toBe(0);
	expect(c.agent.view().items.find((i) => i.id === id)?.status).toBe("dropped");
});

test("the scope lets go of the work before the cancel is awaited: a result that comes meanwhile finds no ticket to adopt", async () => {
	const { c, deps, id } = scopeWith(true);
	let during: { tickets: number; assignments: number } | undefined;
	deps.store.write = (async (fn: (db: never) => unknown) => {
		// The cancel is on its way: what a result collected now would look up is already gone.
		during = { tickets: c.tickets.length, assignments: c.assignments.size };
		await Promise.resolve();
		return fn({} as never);
	}) as typeof deps.store.write;
	await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({ id, action: "cancel" }),
		messageId: "m2",
		at: 1,
		save: async () => true,
	});
	expect(during).toEqual({ tickets: 0, assignments: 0 });
});

test("a cancel the owner refused leaves the work as it was", async () => {
	const { c, deps, id } = scopeWith(true);
	deps.store.write = async () => {
		throw new Error("cancel_failed");
	};
	const out = await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({ id, action: "cancel" }),
		messageId: "m2",
		at: 1,
		save: async () => true,
	});
	expect(out.content).toBe("refused: cancel_failed");
	expect(c.tickets).toHaveLength(1);
	expect(c.assignments.has(id)).toBe(true);
	expect(c.agent.view().items.find((i) => i.id === id)?.status).not.toBe(
		"dropped",
	);
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
				save: async () => true,
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
				save: async () => true,
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
				save: async () => true,
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
				save: async () => true,
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
		save: async () => true,
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

/** A checkpoint holding a running assignment (item, ticket, request) and an unrelated research of the agency's. */
function checkpoint(itemRefs: string[]) {
	const source = {
		conversationId: "ao",
		messageId: "m1",
		runId: "r1",
		request: "Claude Codeで作って",
		digest: "d",
	};
	const item = (
		id: string,
		delegatedTo: string | undefined,
		refs: string[],
	) => ({
		id,
		kind: "research",
		text: id,
		refs,
		value: 5,
		reason: "r",
		requested: true,
		promised: true,
		noteId: null,
		createdAt: 0,
		declines: 0,
		...(delegatedTo ? { delegatedTo } : {}),
	});
	return {
		kind: "agenda",
		version: 1,
		revision: 0,
		agent: {
			version: 1,
			at: 0,
			n: 2,
			quiet: { speechUntil: null, allUntil: null },
			items: [
				item("i1", "Claude Code", itemRefs),
				item("i2", undefined, ["m9"]),
			],
		},
		tickets: [
			{ ...ticket, inputs: ["m1"] },
			{
				...ticket,
				id: "t2",
				itemId: "i2",
				assignment: undefined,
				refs: ["m9"],
				inputs: ["m9"],
			},
		],
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
}

test("forgetting the words an assignment was asked in drops its item and its ticket too, whatever the item cites", () => {
	// The item cites other words than the ones the request was made in: the request's source still takes it with it.
	const next = forgetAgenda(checkpoint(["m5"]), new Set(["m1"]));
	expect(next.assignments).toEqual([]);
	expect(next.tickets.map((t) => t.id)).toEqual(["t2"]);
	expect(next.agent.items.map((i) => i.id)).toEqual(["i2"]);
});

test("a change of the agency's settings carries the user's requests (item, request, running ticket) and nothing else", () => {
	const carried = carryAssignments(checkpoint(["m1"]))!;
	expect(carried.agent.items.map((i) => i.id)).toEqual(["i1"]);
	expect(carried.tickets.map((t) => t.id)).toEqual(["t1"]);
	expect(carried.assignments?.map((a) => a.itemId)).toEqual(["i1"]);
	expect(carried.notes).toEqual([]);
	// No request of the user's held: nothing to carry (the checkpoint is revoked as before).
	const own = checkpoint(["m1"]);
	own.agent.items = own.agent.items.filter((i) => i.id === "i2");
	expect(carryAssignments(own)).toBeNull();
});

test("a running ticket whose request is no longer saved is not carried; its item stays so the start ends it as failed", () => {
	const lost = checkpoint(["m1"]);
	lost.assignments = [];
	const carried = carryAssignments(lost)!;
	expect(carried.tickets).toEqual([]);
	expect(carried.agent.items.map((i) => i.id)).toEqual(["i1"]);
});

test("a media assignment's record is told by its title and description, not as JSON", () => {
	const note = noteFromResult({
		id: "n2",
		ticket: { ...ticket, question: "夕焼けの海の絵を1枚生成してください。" },
		summary: JSON.stringify({
			status: "completed",
			summary: JSON.stringify({
				id: "b62",
				title: "夕焼けの海",
				description: "夕焼けで染まる空と海の風景絵を1枚生成します。",
				artifactId: "image_6a",
				width: 512,
			}),
			fulfilled: ["夕焼けの海の絵を1枚生成した"],
			links: ["eumenes://image/image_6a"],
		}),
		at: 5,
	});
	expect(note!.summary).toBe(
		"「夕焼けの海」：夕焼けで染まる空と海の風景絵を1枚生成します。",
	);
	expect(note!.markdown).not.toContain("artifactId");
	expect(note!.markdown).toContain("- eumenes://image/image_6a");
});
