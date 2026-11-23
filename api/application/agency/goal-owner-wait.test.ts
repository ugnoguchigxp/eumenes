import { expect, test } from "bun:test";
import type { GoalAttempt } from "eumenes-agency/agenda/runtime";
import type { GoalOwnerPort } from "./goal-progress";
import { access, fixture, original } from "./goal-progress.fixture";

const capability = {
	ref: "read",
	description: "登録済みの参照先",
	allowedScope: "読取",
	owner: "runner",
	bindingRevisionId: "runner:1",
	effect: "read" as const,
};
const act = (id: string) => ({
	kind: "act" as const,
	criterionIds: [id],
	capabilityRef: "read",
	request: "資料を読む",
	expectedObservation: "実物の情報",
	evidenceRefs: [],
});
const receipt = (attempt: GoalAttempt, revision: number, question = false) => ({
	status: "known" as const,
	observation: {
		producer: attempt.owner,
		ref: attempt.dispatchId,
		version: String(revision),
		digest: `${attempt.id}:${revision}`,
		attempt: {
			id: attempt.id,
			dispatchId: attempt.dispatchId,
			ownerWorkId: `owner:${attempt.id}`,
			ownerRevision: revision,
			outcome: revision < 3 ? ("running" as const) : ("succeeded" as const),
			observed: revision < 3 ? null : "読取の実測",
			resultRef: revision < 3 ? null : `result:${attempt.id}`,
			...(question && {
				question: {
					ref: "source-question",
					prompt: "比較対象を教えてください。",
					expiresAtMs: 60_000,
					released: true,
				},
			}),
		},
	},
});

function waitingFixture() {
	const starts: GoalAttempt[] = [];
	const answers: { work: string; ref: string; text: string }[] = [];
	const cancellations: string[] = [];
	let questionPending = false;
	const owner: GoalOwnerPort = {
		startInTransaction(_db, _row, attempt) {
			starts.push(attempt);
			return receipt(attempt, 1);
		},
		lookupInTransaction(_db, _row, attempt) {
			if (!starts.some(({ id }) => id === attempt.id))
				return { status: "absent" };
			return attempt.id === starts[0]?.id && questionPending && !answers.length
				? receipt(attempt, 2, true)
				: receipt(attempt, 1);
		},
		cancelInTransaction(_db, _row, attempt) {
			cancellations.push(attempt.id);
			return true;
		},
		answerInTransaction(db, row, attempt, permit, answer) {
			expect(
				f.goals.activeProgressInTransaction(db, access, row)?.currentWorkId,
			).toBe(attempt.id);
			expect(f.goals.goalWorkSlotOpenInTransaction(db, access.principal)).toBe(
				false,
			);
			expect(attempt.permitId).toBe(permit.id);
			answers.push({
				work: attempt.ownerWorkId!,
				ref: answer.ref,
				text: answer.answer,
			});
		},
		wake() {},
	};
	const f = fixture(
		(snapshot) => {
			if (!snapshot.attempts.length) return act("root.1");
			expect(snapshot.criteria.some(({ id }) => id === "root.1")).toBe(false);
			expect(snapshot.openQuestions).toMatchObject([
				{ ref: "source-question", criterionIds: ["root.1"] },
			]);
			return act("root.2");
		},
		{
			owners: { runner: owner },
			sourceText: (_db, ref) => (ref === "words" ? original : "正式な参照先"),
			surface: () => ({ capabilities: [capability], watches: [], checks: [] }),
		},
	);
	const setup = async () => {
		const key = await f.register(1, 50, "words");
		const grant = await f.store.write((db) => {
			const row = f.state(key);
			const design = f.goals.adoptGoalCriteriaInTransaction(db, access, key, {
				expectedVersion: row.progressVersion,
				source: original,
				design: { id: "design", digest: "observed" },
				criteria: [
					{ text: "指定された入力を確認する", sourceQuote: "指定された" },
					{ text: "結果を確認する", sourceQuote: "結果" },
				],
			});
			expect(design.status).toBe("applied");
			const authorized = f.goals.authorizeWorkInTransaction(db, access, key, {
				operationKey: "read-policy",
				toolchainRevisionId: "runner:1",
				workspace: "work",
				impact: "read",
				scope: {
					version: 1,
					workspaceRef: "work",
					baselineCommit: "head",
					readablePaths: ["doc"],
					writablePaths: [],
					checks: [],
					expiresAtMs: null,
					basis: { kind: "policy", revision: "runner:1" },
				},
			});
			f.progress.submitInTransaction(db, authorized.progress);
			return authorized.permit;
		});
		await f.until(
			() => starts.length === 1 && f.state(key).phase === "observing",
		);
		questionPending = true;
		await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, key)!;
			expect(
				f.progress.notifyWorkInTransaction(
					db,
					row,
					receipt(starts[0]!, 2, true).observation,
				),
			).toBe("applied");
		});
		return { key, grant };
	};
	return { ...f, setup, starts, answers, cancellations };
}

test("a released owner question allows an independent action of the same goal and resumes the original receipt once", async () => {
	const f = waitingFixture();
	try {
		const { key, grant } = await f.setup();
		const parked = f.state(key);
		expect(parked.phase).toBe("ready");
		const first = f.starts[0]!;
		expect(parked.currentWorkId).toBeNull();
		await f.store.write((db) => {
			expect(
				f.progress.notifyWorkInTransaction(
					db,
					parked,
					receipt(first, 2, true).observation,
				),
			).toBe("replayed");
			const selected = {
				...act("root.1"),
				contextId: "overlap",
				progressVersion: parked.progressVersion,
				reason: "同じ条件",
				review: null,
			};
			expect(
				f.goals.applyDecisionInTransaction(db, access, key, selected, {
					contextId: selected.contextId,
					current: () => true,
					nowMs: 20,
					act: {
						owner: "runner",
						permitId: grant.id,
						permitRevision: grant.revision,
						bindingRevisionId: "runner:1",
					},
				}),
			).toEqual({ status: "forbidden" });
		});
		await f.progress.recover();
		await f.until(
			() => f.starts.length === 2 && f.state(key).phase === "observing",
		);
		const independent = f.starts[1]!;
		expect(independent.step.criterionIds).toEqual(["root.2"]);
		expect(f.decisions()).toBe(2);
		const answer = () =>
			f.store.write((db) => {
				const applied = f.goals.answerGoalQuestionInTransaction(
					db,
					access,
					key,
					"source-question",
					"answer",
					20,
				);
				if (applied.status === "applied")
					f.progress.submitInTransaction(db, applied.progress);
				return applied.status;
			});
		expect(await answer()).toBe("applied");
		expect(await answer()).toBe("replayed");
		expect(f.state(key).currentWorkId).toBe(independent.id);
		expect(f.answers).toHaveLength(0);
		await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, key)!;
			expect(
				f.progress.notifyWorkInTransaction(
					db,
					row,
					receipt(independent, 3).observation,
				),
			).toBe("applied");
		});
		await f.until(() => f.answers.length === 1);
		expect(f.answers).toEqual([
			{
				work: `owner:${first.id}`,
				ref: "source-question",
				text: "正式な参照先",
			},
		]);
		expect(f.state(key).currentWorkId).toBe(first.id);
		await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, key)!;
			expect(
				f.progress.notifyWorkInTransaction(
					db,
					row,
					receipt(first, 3).observation,
				),
			).toBe("applied");
		});
		expect(
			f.store.read((db) => f.goals.goalAttemptsInTransaction(db, access, key)),
		).toMatchObject([
			{ id: first.id, ownerWorkId: `owner:${first.id}`, outcome: "succeeded" },
			{
				id: independent.id,
				ownerWorkId: `owner:${independent.id}`,
				outcome: "succeeded",
			},
		]);
		expect(f.answers).toHaveLength(1);
		expect(f.cancellations).toEqual([]);
	} finally {
		await f.close();
	}
});

test("withdrawal retires a released owner and rejects a late callback or answer", async () => {
	const f = waitingFixture();
	try {
		const { key } = await f.setup();
		const parked = f.state(key);
		const owner = f.starts[0]!;
		await f.store.write((db) => {
			f.goals.withdrawInTransaction(
				db,
				access,
				{ slot: 1, goalId: key.goalId, revision: key.goalRevision },
				{
					source: {
						namespace: "conversation",
						kind: "message",
						id: "withdraw",
					},
				},
			);
			expect(
				f.progress.notifyWorkInTransaction(
					db,
					parked,
					receipt(owner, 3).observation,
				),
			).toBe("stale");
			expect(
				f.goals.answerGoalQuestionInTransaction(
					db,
					access,
					key,
					"source-question",
					"answer",
					20,
				).status,
			).toBe("stale");
		});
		await f.until(() => f.cancellations.length === 1);
		expect(f.cancellations).toEqual([owner.id]);
		expect(f.starts).toHaveLength(1);
		expect(
			f.store.read((db) =>
				f.goals.parkedGoalAttemptsInTransaction(db, access, key),
			),
		).toEqual([]);
	} finally {
		await f.close();
	}
});
