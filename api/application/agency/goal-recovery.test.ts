import { expect, test } from "bun:test";
import { access, fixture, source } from "./goal-progress.fixture";

test("startup rechecks a configuration wait while respecting whole-scope stop and stale goals", async () => {
	let stale = false;
	const f = fixture(
		() => ({
			kind: "ask",
			missing: "情報",
			question: "確認に必要な情報を教えてください。",
		}),
		{
			sourcesCurrent: (_db, _row, refs) =>
				!stale || !refs.includes("stale-source"),
		},
		8,
	);
	try {
		const live = await f.register(1, 50, source.id);
		const forgotten = await f.register(2, 50, "stale-source");
		const withdrawn = await f.register(3, 50, source.id);
		f.progress.close();
		await f.store.write((db) => {
			for (const key of [live, forgotten, withdrawn]) {
				const row = f.goals.progressInTransaction(db, access, key)!;
				const waiting = f.goals.transitionProgressInTransaction(
					db,
					access,
					row,
					row.progressVersion,
					(current) => ({
						phase: "waiting",
						state: {
							...current.state,
							problem: "goal_criterion_source_invalid",
							watch: {
								ref: "configuration-or-input",
								condition: "推論経路が更新される",
								producer: "goal-configuration",
								dueAtMs: null,
							},
						},
					}),
				)!;
				f.progress.submitInTransaction(db, waiting);
			}
			f.goals.withdrawInTransaction(
				db,
				access,
				{
					slot: 3,
					goalId: withdrawn.goalId,
					revision: withdrawn.goalRevision,
				},
				{ source },
			);
			f.goals.setGoalScopeControlInTransaction(db, access, "work", {
				allUntilMs: 50_000,
				speechUntilMs: null,
			});
		});
		stale = true;
		const untouched = [f.state(forgotten), f.state(withdrawn)];
		await f.progress.recover();
		const resumed = f.state(live);
		expect(resumed.phase).toBe("ready");
		expect(f.queue.get(resumed.jobId!)?.availableAtMs).toBe(50_000);
		await f.progress.recover();
		expect(f.state(live).jobId).toBe(resumed.jobId);
		await f.queue.tick();
		expect(f.decisions()).toBe(0);
		f.advance(50_000);
		await f.until(() => f.state(live).phase === "needs_user");
		expect(f.decisions()).toBe(1);
		expect([f.state(forgotten), f.state(withdrawn)]).toEqual(untouched);
	} finally {
		await f.close();
	}
});
