import { expect, test } from "bun:test";
import { createGoalStore, goalMigrations } from "eumenes-agency/agenda/runtime";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { setupMemory } from "../../domains/memory/test/memory.fixture";
import { createGoalReplyWork } from "./goal-permission";
import { goalQuestionMessageId } from "./goal-question-delivery";
import { createGoalWork } from "./goal-work";
import { createGoalWorkspaceRegistry } from "./goal-workspaces";

const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
const title = "現物を確認する";
const questionText = "照合に使う対象を教えてください。";

async function fixture() {
	const h = await setupMemory({
		extraMigrations: [...goalsMigrations, ...goalMigrations],
	});
	const goals = createGoalStore(
		h.store,
		createGoalsService(() => h.time.now),
	);
	let now = Date.parse(h.time.now);
	const blocked = h.memory.isBlockedInTransaction;
	const replyOf = (conversationId: string) =>
		createGoalReplyWork({
			store: h.store,
			goals,
			conversation: h.conversation,
			workspaces: createGoalWorkspaceRegistry(undefined),
			blocked,
			scopeKey: PROFILE_SCOPE,
			access,
			binding: () => null,
			progress: { submitInTransaction() {}, wake() {} },
		})(conversationId);
	const work = createGoalWork({
		store: h.store,
		goals,
		conversation: h.conversation,
		blocked,
		reply: replyOf,
		now: () => now,
	});
	const source = await h.say("user", title, "origin");
	const ask = (
		slot: number,
		sourceRef = source,
		deliveryConversationId: string | null = null,
	) =>
		h.store.write((db) => {
			const goal = goals.registerInTransaction(
				db,
				access,
				slot,
				{
					scopeKey: PROFILE_SCOPE,
					desiredState: title,
					priority: 50,
					source: { namespace: "conversation", kind: "message", id: sourceRef },
					operationKey: `register-${slot}`,
					sourceMessageIds: [sourceRef],
				},
				{ mode: "goal", sourceRef, deliveryConversationId, startedAt: now },
			);
			const key = {
				principal: PRINCIPAL,
				goalId: goal.id,
				goalRevision: goal.revision,
			};
			const result = goals.applyDecisionInTransaction(
				db,
				access,
				key,
				{
					kind: "ask",
					contextId: `decision-${slot}`,
					progressVersion: 1,
					criterionIds: ["root"],
					question: questionText,
					missing: "比較対象",
					reason: "照合前に必要",
					review: null,
				},
				{ nowMs: now, contextId: `decision-${slot}`, current: () => true },
			);
			if (result.status !== "applied")
				throw new Error("fixture_goal_question_not_saved");
			return {
				row: result.progress,
				ref: result.resultRef,
				id: goalQuestionMessageId(result.progress, result.resultRef),
			};
		});
	return {
		...h,
		goals,
		work,
		ask,
		source,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("a goal question is the agency's to ask in its own conversation, once the goals' quiet ends, and is answered through it", async () => {
	const f = await fixture();
	try {
		const { row, ref, id } = await f.ask(1);
		const views = () => f.store.read((db) => f.work.viewsInTransaction(db));
		await f.store.write((db) =>
			f.goals.setGoalScopeControlInTransaction(db, access, PROFILE_SCOPE, {
				speechUntilMs: f.now() + 1_000,
				allUntilMs: null,
			}),
		);
		expect(views()).toMatchObject([{ question: null }]);
		// The agency is woken when the goals' quiet ends.
		expect(f.store.read((db) => f.work.heldUntilInTransaction(db))).toBe(
			f.now() + 1_000,
		);
		f.advance(1_000);
		expect(f.store.read((db) => f.work.heldUntilInTransaction(db))).toBeNull();
		expect(views()).toMatchObject([
			{
				goalId: row.goalId,
				conversationId: "origin",
				question: { ref, prompt: questionText },
			},
		]);
		const answer = await f.say(
			"user",
			"指定した対象を使ってください。",
			"origin",
		);
		expect(
			await f.work.control({
				conversationId: "origin",
				view: views()[0]!,
				action: "answer",
				text: "指定した対象を使ってください。",
				messageId: answer,
				signal: new AbortController().signal,
			}),
		).toBe("answered: 登録目標に回答を渡した");
		expect(
			f.store.read((db) =>
				f.goals.activeProgressInTransaction(db, access, row),
			),
		).toMatchObject({
			state: { questions: [{ ref, answeredBy: answer }] },
		});
		expect(views()).toMatchObject([{ question: null }]);
		// Nothing was written to the conversation for the question.
		expect(f.conversation.message(id)).toBeNull();
	} finally {
		await f.close();
	}
});

test("a revised, withdrawn or forgotten goal is not shown", async () => {
	const f = await fixture();
	try {
		const revised = await f.ask(1, f.source, "explicit");
		const withdrawn = await f.ask(2);
		const forgetSource = await f.say("user", title, "forget");
		await f.ask(3, forgetSource);
		await f.store.write((db) => {
			const target = (slot: number, key: typeof revised.row) => ({
				slot,
				goalId: key.goalId,
				revision: key.goalRevision,
			});
			const source = {
				namespace: "conversation",
				kind: "message",
				id: f.source,
			};
			f.goals.reviseInTransaction(db, access, target(1, revised.row), {
				desiredState: "改訂条件",
				source,
			});
			f.goals.withdrawInTransaction(db, access, target(2, withdrawn.row), {
				source,
			});
			f.conversation.retractInTransaction(db, { messageId: forgetSource });
		});
		const shown = f.store.read((db) => f.work.viewsInTransaction(db));
		expect(
			shown.filter(
				({ goalId, revision }) =>
					(goalId === revised.row.goalId &&
						revision === revised.row.goalRevision) ||
					goalId === withdrawn.row.goalId,
			),
		).toEqual([]);
		expect(
			shown.some(({ sourceMessageId }) => sourceMessageId === forgetSource),
		).toBe(false);
	} finally {
		await f.close();
	}
});
