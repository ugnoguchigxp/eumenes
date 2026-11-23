import { expect, test } from "bun:test";
import {
	createGoalStore,
	goalMigrations,
	withGoalReplyTools,
	type GoalHost,
} from "eumenes-agency/agenda/runtime";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { setupMemory } from "../../domains/memory/test/memory.fixture";
import { createGoalReplyWork } from "./goal-permission";
import { goalQuestionMessageId } from "./goal-question-delivery";
import { createGoalReportDelivery } from "./goal-report-delivery";
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
	const delivery = () =>
		createGoalReportDelivery({
			store: h.store,
			goals,
			conversation: h.conversation,
			referenceInputs: h.memory.referenceInputs,
			blocked,
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
		delivery,
		ask,
		source,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("a legacy goal question reaches only its originating conversation once and the same question can be answered", async () => {
	const f = await fixture();
	const delivery = f.delivery();
	try {
		const { row, ref, id } = await f.ask(1);
		const sourceWithoutUser = await f.say("assistant", "参照先なし", "other");
		const noDestination = await f.ask(2, sourceWithoutUser);
		const pause = (speechUntilMs: number | null, allUntilMs: number | null) =>
			f.store.write((db) =>
				f.goals.setGoalScopeControlInTransaction(db, access, PROFILE_SCOPE, {
					speechUntilMs,
					allUntilMs,
				}),
			);
		await pause(f.now() + 1_000, f.now() + 2_000);
		await delivery.recover();
		expect(f.conversation.message(id)).toBeNull();
		f.advance(1_000);
		await delivery.recover();
		expect(f.conversation.message(id)).toBeNull();
		f.advance(1_000);
		await Promise.all([delivery.recover(), delivery.recover()]);
		await f.delivery().recover();
		expect(f.conversation.get("origin").messages).toEqual([
			expect.objectContaining({ id: f.source, role: "user" }),
			expect.objectContaining({
				id,
				role: "assistant",
				text: expect.stringContaining(questionText),
			}),
		]);
		expect(f.conversation.message(noDestination.id)).toBeNull();
		const answer = { text: "指定した対象を使ってください。", id: "" };
		answer.id = await f.say("user", answer.text, "origin");
		const legacy = {
			list: () => f.goals.list(access),
			infoChanged() {},
		} as GoalHost;
		const work = createGoalReplyWork({
			store: f.store,
			goals: f.goals,
			conversation: f.conversation,
			workspaces: createGoalWorkspaceRegistry(undefined),
			blocked: f.memory.isBlockedInTransaction,
			scopeKey: PROFILE_SCOPE,
			access,
			binding: () => null,
			progress: { submitInTransaction() {}, wake() {} },
		})("origin", legacy);
		const tools = withGoalReplyTools(
			{ tools: [], call: async () => ({ content: "" }) },
			legacy,
			() => answer,
			PROFILE_SCOPE,
			work,
		);
		const call = async (name: string, args: object) =>
			JSON.parse(
				(
					await tools.call(
						{ id: name, name, arguments: JSON.stringify(args) },
						new AbortController().signal,
					)
				).content,
			);
		const listed = await call("list_goals", {});
		expect(listed.slots[0].progress.questions).toMatchObject([
			{ ref, question: questionText },
		]);
		const update = {
			action: "answer_question",
			slot: 1,
			goalId: row.goalId,
			revision: row.goalRevision,
			design: null,
			desiredState: null,
			priority: null,
			quote: answer.text,
			questionRef: ref,
		};
		expect(await call("update_goal", update)).toMatchObject({
			status: "updated",
		});
		expect(await call("update_goal", update)).toMatchObject({
			status: "updated",
		});
		const saved = f.store.read((db) =>
			f.goals.activeProgressInTransaction(db, access, row),
		);
		expect(saved).toMatchObject({
			phase: "ready",
			state: { questions: [{ ref, answeredBy: answer.id }] },
		});
		await delivery.recover();
		expect(
			f.conversation
				.get("origin")
				.messages.filter((message) => message.id === id),
		).toHaveLength(1);
	} finally {
		await delivery.close();
		await f.close();
	}
});

test("an old or forgotten pending question does not appear in the conversation", async () => {
	const f = await fixture();
	const delivery = f.delivery();
	try {
		const revised = await f.ask(1, f.source, "explicit");
		const withdrawn = await f.ask(2);
		const forgetSource = await f.say("user", title, "forget");
		const forgotten = await f.ask(3, forgetSource);
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
		await delivery.recover();
		for (const { id } of [revised, withdrawn, forgotten])
			expect(f.conversation.message(id)).toBeNull();
	} finally {
		await delivery.close();
		await f.close();
	}
});

test("a reconsidered question waits for the configuration decision and is delivered only if still needed", async () => {
	const f = await fixture();
	const delivery = f.delivery();
	try {
		for (const [index, resolved] of [true, false].entries()) {
			const { row, ref, id } = await f.ask(index + 1);
			const configured = await f.store.write((db) =>
				f.goals.reconcileReadPoliciesInTransaction(db, access, row, {
					digest: "changed-registration",
					summary: "新しい参照先を照合済み",
					policies: [],
				}),
			);
			if (configured.status !== "applied")
				throw new Error("fixture_goal_configuration");
			await delivery.recover();
			expect(f.conversation.message(id)).toBeNull();
			await f.store.write((db) => {
				const selected = f.goals.applyDecisionInTransaction(
					db,
					access,
					row,
					{
						kind: "wait",
						contextId: "after-configuration",
						progressVersion: configured.progress.progressVersion,
						criterionIds: ["root"],
						reason: "まだ必要な資料を待つ",
						review: null,
						watchRef: "document",
						resolvedQuestionRefs: resolved ? [ref] : [],
					},
					{
						contextId: "after-configuration",
						configurationRef: configured.progress.state.configuration!.ref,
						nowMs: f.now(),
						current: () => true,
						watch: {
							ref: "document",
							condition: "資料到着",
							dueAtMs: null,
							producer: "markdown",
						},
					},
				);
				expect(selected.status).toBe("applied");
			});
			await delivery.recover();
			await delivery.recover();
			expect(
				f.conversation
					.get("origin")
					.messages.filter((message) => message.id === id),
			).toHaveLength(resolved ? 0 : 1);
		}
	} finally {
		await delivery.close();
		await f.close();
	}
});
