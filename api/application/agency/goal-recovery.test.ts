import { expect, test } from "bun:test";
import { access, fixture, source } from "./goal-progress.fixture";

test("startup resumes legacy design failures once with the same configuration and current read permission", async () => {
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
			reconcileConfiguration: (_db, row) => row,
			surface: (_db, _row, permit) => ({
				capabilities: permit
					? [
							{
								ref: "read",
								owner: "worker",
								description: "参照先の現在値を読む",
								allowedScope: "registered",
								bindingRevisionId: "worker:1",
								effect: "read",
							},
						]
					: [],
				checks: [],
				watches: [],
			}),
			owners: {
				worker: {
					startInTransaction: () => ({ status: "absent" }),
					lookupInTransaction: () => ({ status: "absent" }),
					cancelInTransaction: () => true,
					wake() {},
				},
			},
		},
		8,
	);
	try {
		const live = await f.register(1, 50, source.id);
		const forgotten = await f.register(2, 50, "stale-source");
		const withdrawn = await f.register(3, 50, source.id);
		const noRead = await f.register(4, 50, source.id);
		f.progress.close();
		await f.store.write((db) => {
			for (const key of [live, forgotten, withdrawn, noRead]) {
				const row =
					key === noRead
						? f.goals.progressInTransaction(db, access, key)!
						: f.goals.authorizeWorkInTransaction(db, access, key, {
								operationKey: `policy:${key.goalId}`,
								toolchainRevisionId: "worker:1",
								workspace: "registered",
								impact: "read",
								scope: {
									version: 1,
									basis: { kind: "policy", revision: "worker:1" },
									workspaceRef: "registered",
									baselineCommit: "binding:1",
									readablePaths: ["/registered/result.txt"],
									writablePaths: [],
									checks: [],
									expiresAtMs: null,
								},
							}).progress;
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
		const untouched = [forgotten, withdrawn, noRead].map(f.state);
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
		await f.progress.recover();
		await f.queue.tick();
		expect(f.decisions()).toBe(1);
		expect([forgotten, withdrawn, noRead].map(f.state)).toEqual(untouched);
	} finally {
		await f.close();
	}
});
