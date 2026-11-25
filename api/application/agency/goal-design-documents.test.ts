import { expect, test } from "bun:test";
import type { LlmPort } from "eumenes-agency";
import type { GoalStepContext } from "eumenes-agency/agenda";
import {
	createGoalDesignDocuments,
	goalDesignObservation,
} from "./goal-design-documents";
import { access, fixture, original, source } from "./goal-progress.fixture";

const sourceText = "現在の手順で件数と合計が得られるようにしてください。";
const criterion = "現在の手順で件数と合計が得られる";
const criterionText = "現行手順を実行して件数と合計を確認できる";
const document = {
	ref: "document",
	condition: "次の資料が保存される",
	producer: "markdown",
	dueAtMs: null,
};

function designFixture(quotes: readonly string[], repeatQuestion = false) {
	let documents: ReturnType<typeof createGoalDesignDocuments>;
	const snapshots: GoalStepContext[] = [];
	const progress = fixture(
		(snapshot) => {
			snapshots.push(snapshot);
			if (snapshot.attempts.length)
				return { kind: "wait", watchRef: document.ref };
			if (snapshot.openQuestions.length && !repeatQuestion)
				return {
					kind: "act",
					capabilityRef: "read",
					request: "登録済みの資料を読む",
					expectedObservation: "登録済み資料の現在値",
					evidenceRefs: [],
				};
			return {
				kind: "ask",
				missing: "情報",
				question: "残りの条件を教えてください。",
			};
		},
		{
			prepareDesign: (db, row) => documents.prepareDesign(db, row),
			surface: () => ({
				watches: [document],
				checks: [],
				capabilities: (["read", "write"] as const).map((effect) => ({
					ref: effect,
					description: effect,
					allowedScope: "work",
					owner: "worker",
					bindingRevisionId: "work:1",
					effect,
				})),
			}),
			owners: {
				worker: {
					startInTransaction(_db, _row, attempt) {
						expect(attempt.operationRef).toBe("read");
						return {
							status: "known",
							observation: {
								producer: attempt.owner,
								ref: attempt.dispatchId,
								version: "1",
								digest: attempt.id,
								attempt: {
									id: attempt.id,
									dispatchId: attempt.dispatchId,
									ownerWorkId: "accepted-read",
									ownerRevision: 1,
									outcome: "succeeded",
									observed: "登録済み資料の現在値を読みました。",
									resultRef: null,
								},
							},
						};
					},
					lookupInTransaction: () => ({ status: "absent" }),
					cancelInTransaction: () => true,
					wake() {},
				},
			},
		},
	);
	const calls: { prompt: string; system: string; signal: AbortSignal }[] = [];
	const llm: LlmPort = {
		async complete(request, signal) {
			const sourceQuote = quotes[calls.length];
			calls.push({ prompt: request.prompt, system: request.system, signal });
			return {
				value: request.schema.parse({
					status: "ready",
					title: "手順の設計",
					summary: "現在の手順を実行する",
					markdown: "## 検証\n現在の手順を実行する。",
					sources: [],
					missing: null,
					criteria: [{ sourceQuote, text: criterionText }],
				}),
				model: "fixture",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			};
		},
	};
	documents = createGoalDesignDocuments({
		goals: progress.goals,
		generated: {
			configureOwner() {},
			startInTransaction() {
				throw new Error("fixture_uses_the_goal_ledger");
			},
			originalInTransaction: () => null,
		},
		llm: () => llm,
		sourceText: (_db, ref) => (ref === source.id ? sourceText : null),
	});
	return {
		...progress,
		calls,
		snapshots,
		async registerDesignGoal() {
			const key = await progress.register(1, 50, source.id);
			await progress.store.write((db) => {
				const grant = progress.goals.authorizeWorkInTransaction(
					db,
					access,
					key,
					{
						operationKey: "file-edit",
						toolchainRevisionId: "work:1",
						workspace: "work",
						impact: "edit",
						scope: {
							version: 1,
							basis: { kind: "message", sourceRefs: [source.id] },
							workspaceRef: "work",
							baselineCommit: "binding:1",
							readablePaths: ["/work/current.txt"],
							writablePaths: ["/work/current.txt"],
							checks: [],
							expiresAtMs: null,
						},
					},
				);
				progress.progress.submitInTransaction(db, grant.progress);
			});
			return key;
		},
	};
}

test("a quote from the paraphrased purpose is corrected by the model using the original text", async () => {
	const f = designFixture([original, criterion]);
	try {
		const key = await f.registerDesignGoal();
		await f.until(() => f.state(key).state.design !== null);
		expect(f.calls).toHaveLength(2);
		const [first, correction] = f.calls;
		const firstInput = JSON.parse(first!.prompt);
		expect(firstInput).toMatchObject({ purpose: original, sourceText });
		expect(JSON.parse(correction!.prompt)).toEqual({
			...firstInput,
			validationFailure: {
				code: "goal_criterion_source_invalid",
				fields: ["criteria[0].sourceQuote"],
				previousCriteria: [{ sourceQuote: original, text: criterionText }],
			},
		});
		expect(correction!.system).toContain("sourceText");
		expect(correction!.system).not.toContain(sourceText);
		expect(correction!.signal).toBe(first!.signal);
		expect(f.state(key).state.criteria).toMatchObject([
			{ id: "root", text: original, sourceQuote: null, status: "open" },
			{ text: criterionText, sourceQuote: criterion, status: "open" },
		]);
		expect(f.goals.goal(access, key.goalId)?.desiredState).toBe(original);
	} finally {
		await f.close();
	}
});

test("a deadline recheck keeps the issued reference when the same question is still needed", async () => {
	const f = designFixture([original, original], true);
	try {
		const key = await f.registerDesignGoal();
		await f.until(() => f.state(key).state.watch?.ref === "initial-analysis");
		const first = f.state(key).state.questions;
		expect(first).toHaveLength(1);
		f.advance(300_001);
		await f.until(
			() => f.decisions() === 2 && f.state(key).phase === "needs_user",
		);
		expect(f.state(key).state.questions).toEqual(first);
		expect(f.calls).toHaveLength(2);
	} finally {
		await f.close();
	}
});

test("an invalid correction reaches the next decision without repeating the same design", async () => {
	const f = designFixture([original, original]);
	try {
		const key = await f.registerDesignGoal();
		await f.until(() => f.state(key).state.watch?.ref === "initial-analysis");
		expect(f.calls).toHaveLength(2);
		expect(f.decisions()).toBe(1);
		expect(f.snapshots[0]?.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ref: goalDesignObservation,
					summary: expect.stringContaining("goal_criterion_source_invalid"),
				}),
			]),
		);
		f.advance(300_001);
		await f.until(() => f.state(key).state.watch?.ref === document.ref);
		expect(f.decisions()).toBe(3);
		expect(f.calls).toHaveLength(2);
		expect(
			f.snapshots.every(
				({ capabilities }) =>
					capabilities.length === 1 && capabilities[0]?.ref === "read",
			),
		).toBe(true);
		expect(
			f.store.read((db) => f.goals.goalAttemptsInTransaction(db, access, key)),
		).toMatchObject([{ ownerWorkId: "accepted-read", outcome: "succeeded" }]);
		expect(f.state(key).state.questions).toHaveLength(1);
		expect(f.state(key)).toMatchObject({
			phase: "waiting",
			state: {
				design: null,
				criteria: [
					{ id: "root", text: original, sourceQuote: null, status: "open" },
				],
				watch: document,
			},
		});
	} finally {
		await f.close();
	}
});
