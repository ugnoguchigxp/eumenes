import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmPort } from "eumenes-agency";
import { goalStepSchema, type GoalStepContext } from "eumenes-agency/agenda";
import { createGoalStore, goalMigrations } from "eumenes-agency/agenda/runtime";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";
import { waitFor } from "../../infrastructure/wait-for";
import { createGoalProgress, type GoalProgressPorts } from "./goal-progress";

export const access = { principal: "owner", scopeKeys: ["work"] };
export const original = "指定された結果を得る";
export const source = {
	namespace: "conversation",
	kind: "message",
	id: "words",
};
export const watch = {
	ref: "document",
	condition: "根拠資料が保存される",
	dueAtMs: 30_000,
	producer: "markdown",
};

export function fixture(
	decide: (snapshot: GoalStepContext) => object,
	options: Partial<GoalProgressPorts> = {},
	queueSize = 1,
) {
	const dir = mkdtempSync(join(tmpdir(), "goal-progress-"));
	let now = 20;
	let decisions = 0;
	const store = openStore(join(dir, "progress.sqlite"), [
		...goalsMigrations,
		...goalMigrations,
		...queueMigrations,
	]);
	const goals = createGoalStore(
		store,
		createGoalsService(() => new Date(now).toISOString()),
	);
	const queue = createQueue(store, {
		now: () => now,
		limits: { total: queueSize, background: queueSize, scope: queueSize },
	});
	// The progress machinery's tests choose each step themselves: `decide` sees the turn's snapshot and its
	// answer is the turn's step, checked against the step contract as a model's would be.
	const deliberate: NonNullable<GoalProgressPorts["deliberate"]> = async ({
		snapshot,
	}) => {
		decisions++;
		const context = snapshot.context;
		const parsed = goalStepSchema.safeParse({
			contextId: context.contextId,
			progressVersion: context.progressVersion,
			criterionIds: ["root"],
			reason: "観測に基づく提案",
			review: null,
			...decide(context),
		});
		if (!parsed.success) throw new Error("invalid_shape");
		return { kind: "step", step: parsed.data, planned: null };
	};
	const llm: LlmPort = {
		async complete() {
			throw new Error("fixture_llm_unused");
		},
	};
	const progress = createGoalProgress({
		store,
		goals,
		queue,
		llm: () => llm,
		deliberate,
		nowMs: () => now,
		enabled: () => true,
		sourcesCurrent: () => true,
		owners: {},
		surface: () => ({ capabilities: [], watches: [watch], checks: [] }),
		...options,
	});
	progress.listen();
	const register = (slot = 1, priority = 50, sourceRef: string | null = null) =>
		store.write((db) => {
			const goal = goals.registerInTransaction(
				db,
				access,
				slot,
				{
					scopeKey: "work",
					desiredState: original,
					priority,
					source,
					operationKey: "words:" + slot,
				},
				{
					mode: "goal",
					sourceRef,
					startedAt: now,
					deliveryConversationId: null,
				},
			);
			const key = {
				principal: access.principal,
				goalId: goal.id,
				goalRevision: goal.revision,
			};
			progress.submitInTransaction(
				db,
				goals.progressInTransaction(db, access, key)!,
			);
			return key;
		});
	const state = (key: Awaited<ReturnType<typeof register>>) =>
		store.read((db) => goals.progressInTransaction(db, access, key)!);
	const until = async (predicate: () => boolean) => {
		await waitFor(async () => {
			await queue.tick();
			return predicate();
		});
	};
	return {
		store,
		goals,
		queue,
		progress,
		register,
		state,
		until,
		decisions: () => decisions,
		advance: (ms: number) => {
			now += ms;
		},
		close: async () => {
			progress.close();
			await queue.close(1_000);
			await store.close();
			rmSync(dir, { force: true, recursive: true });
		},
	};
}
