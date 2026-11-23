import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GOAL_ANALYSIS_MS,
	type GoalAttempt,
	type GoalProgress,
} from "eumenes-agency/agenda/runtime";
import { z } from "zod";
import { GOAL_ADVANCE_KIND } from "./goal-progress";
import {
	access,
	fixture,
	original,
	source,
	watch,
} from "./goal-progress.fixture";
import { createGoalVerification } from "./goal-verification";
import { createGoalWorkspaceRegistry } from "./goal-workspaces";

test("an unattended goal recovers a full queue and the same document revision advances it once", async () => {
	const f = fixture((snapshot) =>
		snapshot.evidence.length
			? { kind: "ask", missing: "基準値", question: "期待値はどれですか？" }
			: { kind: "wait", watchRef: watch.ref },
	);
	try {
		f.queue.registerHandler({
			kind: "fixture",
			payloadVersions: [1],
			schema: z.strictObject({}),
			recovery: "replay_safe",
			prepareInTransaction: () => ({ status: "ready", input: null }),
			execute: async () => null,
			settleInTransaction: () => "applied",
			cancelInTransaction: () => {},
		});
		await f.queue.enqueue({
			scope: "fixture",
			kind: "fixture",
			dedupeKey: "occupier",
			payload: {},
			lane: "background",
		});
		const key = await f.register();
		expect(f.state(key)).toMatchObject({
			progressVersion: 1,
			jobId: null,
			needsEnqueue: true,
			deliveryConversationId: null,
		});
		expect(f.decisions()).toBe(0);
		await f.until(
			() => f.state(key).phase === "waiting" && f.state(key).jobId !== null,
		);
		expect(f.decisions()).toBe(1);
		const prior = f.state(key);
		expect(f.queue.get(prior.jobId!)?.availableAtMs).toBe(watch.dueAtMs!);

		const notify = (version: string, digest: string, current = true) =>
			f.store.write((db) =>
				f.progress.notifyDocumentInTransaction(
					db,
					key,
					access,
					{
						producer: "markdown",
						ref: "reference-document",
						version,
						digest,
						evidence: [{ ref: "doc", version, digest, summary: "検証用資料" }],
					},
					() => current,
				),
			);
		expect(await notify("2", "same")).toBe("applied");
		expect(await notify("2", "same")).toBe("replayed");
		expect(await notify("2", "different")).toBe("conflict");
		expect(await notify("1", "old", false)).toBe("forbidden");
		expect(f.queue.get(prior.jobId!)?.state).toBe("cancelled");
		await f.until(() => f.state(key).phase === "needs_user");
		expect(f.state(key).state.evidence).toMatchObject([
			{ ref: "doc", version: "2" },
		]);
		expect(f.decisions()).toBe(2);
		expect(f.queue.list({ kind: GOAL_ADVANCE_KIND }).items).toHaveLength(3);
	} finally {
		await f.close();
	}
});

test("an unchanged running receipt schedules another poll without submitting another job to the owner", async () => {
	let starts = 0;
	let lookups = 0;
	let final = false;
	const receipt = (attempt: GoalAttempt) => ({
		status: "known" as const,
		observation: {
			producer: attempt.owner,
			ref: attempt.dispatchId,
			version: final ? "2" : "1",
			digest: final ? "finished" : "running",
			attempt: {
				id: attempt.id,
				dispatchId: attempt.dispatchId,
				ownerWorkId: "external-id",
				ownerRevision: final ? 2 : 1,
				outcome: final ? ("failed" as const) : ("running" as const),
				observed: final ? "終了2" : null,
				resultRef: final ? "result-of-physical-check" : null,
			},
		},
	});
	const f = fixture(
		(snapshot) => {
			const previous = snapshot.attempts[0];
			if (!previous)
				return {
					kind: "act",
					capabilityRef: "run",
					request: "現行の手段を試す",
					expectedObservation: "終了コードを確認する",
					evidenceRefs: [],
				};
			expect(previous.observed).toBe("終了2");
			expect(previous.savedReceipt).toEqual({
				ownerWorkId: "external-id",
				ownerRevision: 2,
				resultRef: "result-of-physical-check",
			});
			return {
				kind: "ask",
				missing: "別の資料",
				question: "別の資料はありますか？",
			};
		},
		{
			owners: {
				runner: {
					startInTransaction: (_db, _progress, attempt) => {
						starts++;
						return receipt(attempt);
					},
					lookupInTransaction: (_db, _progress, attempt) => {
						lookups++;
						return starts ? receipt(attempt) : { status: "absent" };
					},
					cancelInTransaction: () => true,
					wake: () => {},
				},
			},
			surface: () => ({
				checks: [],
				watches: [],
				capabilities: [
					{
						ref: "run",
						description: "許可済みの検査",
						allowedScope: "閲覧",
						owner: "runner",
						bindingRevisionId: "runner:1",
						effect: "read",
					},
				],
			}),
		},
	);
	try {
		const key = await f.register();
		await f.store.write((db) => {
			const grant = f.goals.authorizeWorkInTransaction(db, access, key, {
				operationKey: "read-policy",
				toolchainRevisionId: "read:1",
				workspace: "local",
				impact: "read",
				scope: {
					version: 1,
					basis: { kind: "policy", revision: "test" },
					workspaceRef: "local",
					baselineCommit: "head",
					readablePaths: ["local"],
					writablePaths: [],
					checks: [],
					expiresAtMs: null,
				},
			});
			f.progress.submitInTransaction(db, grant.progress);
		});
		await f.until(
			() => f.state(key).phase === "observing" && f.state(key).jobId !== null,
		);
		const polling: GoalProgress = f.state(key);
		f.advance(5_000);
		await f.until(
			() =>
				f.state(key).progressVersion > polling.progressVersion &&
				f.state(key).jobId !== null,
		);
		expect(f.state(key).phase).toBe("observing");
		expect(f.state(key).dueAtMs).toBe(polling.dueAtMs! + 5_000);
		expect(lookups).toBe(2);
		expect(starts).toBe(1);
		f.advance(5_000);
		final = true;
		await f.until(() => f.state(key).phase === "needs_user");
		expect(starts).toBe(1);
		expect(
			f.store.read((db) => f.goals.goalAttemptsInTransaction(db, access, key)),
		).toEqual([
			expect.objectContaining({
				outcome: "failed",
				ownerWorkId: "external-id",
				observed: "終了2",
			}),
		]);
	} finally {
		await f.close();
	}
});

const asking = {
	kind: "ask",
	missing: "変更手段",
	question: "編集能力を利用できますか？",
};
const choice = (capabilityRef: string) => ({
	kind: "act",
	capabilityRef,
	request: "許可内作業を進める",
	expectedObservation: "実作業の観測",
	evidenceRefs: [],
});
const workScope = (editable = false) => ({
	version: 1 as const,
	basis: { kind: "message" as const, sourceRefs: ["words"] },
	workspaceRef: "local",
	baselineCommit: "head",
	readablePaths: ["manual"],
	writablePaths: editable ? ["manual"] : [],
	checks: [],
	expiresAtMs: null,
});
const capability = (effect: "read" | "write") => ({
	ref: effect,
	description: "許可内で事実を確認する",
	allowedScope: "manual",
	owner: "runner",
	bindingRevisionId: "runner:1",
	effect,
});

test("the same failed observation calls for review across work IDs and request wording", async () => {
	let starts = 0;
	const f = fixture(
		(snapshot) => {
			if (snapshot.attempts.length === 2) {
				expect(snapshot.reviewRequired).toBe(true);
				return {
					kind: "wait",
					watchRef: watch.ref,
					review: "同じ観測が続いたため、条件の変化まで待ちます。",
				};
			}
			expect(snapshot.reviewRequired).toBe(false);
			return {
				...choice("read"),
				request: `別の表現で同一操作を行う ${snapshot.attempts.length}`,
			};
		},
		{
			surface: () => ({
				capabilities: [capability("read")],
				watches: [watch],
				checks: [],
			}),
			owners: {
				runner: {
					lookupInTransaction: () => ({ status: "absent" }),
					startInTransaction(_db, _row, attempt) {
						starts++;
						return {
							status: "known",
							observation: {
								producer: attempt.owner,
								ref: attempt.dispatchId,
								version: "1",
								digest: `receipt:${starts}`,
								evidence: [
									{
										ref: `check:${starts}`,
										version: "1",
										digest: `check:${starts}`,
										summary: "終了コード 2。実行入力を認識できません。",
									},
								],
								attempt: {
									id: attempt.id,
									dispatchId: attempt.dispatchId,
									ownerWorkId: `owner:${starts}`,
									ownerRevision: 1,
									outcome: "failed",
									observed: attempt.step.request + " · 終了2",
									resultRef: `owner:${starts}`,
								},
							},
						};
					},
					cancelInTransaction: () => true,
					wake: () => {},
				},
			},
		},
	);
	try {
		const key = await f.register();
		await f.store.write((db) => {
			const grant = f.goals.authorizeWorkInTransaction(db, access, key, {
				operationKey: "observations",
				toolchainRevisionId: "test:1",
				workspace: "local",
				impact: "read",
				scope: workScope(),
			});
			f.progress.submitInTransaction(db, grant.progress);
		});
		await f.until(() => f.state(key).state.reviewedAttemptCount === 2);
		expect(starts).toBe(2);
		expect(f.state(key).phase).toBe("waiting");
	} finally {
		await f.close();
	}
});

test("an unanswered question preserves the absolute deadline of an already authorized edit", async () => {
	let attempts = 0;
	const f = fixture(
		(snapshot) => {
			if (snapshot.attempts.length) return asking;
			if (!snapshot.capabilities.some(({ ref }) => ref === "write")) {
				expect(snapshot.editAvailability).toMatchObject({
					permittedPaths: ["manual"],
					nowMs: 20,
					notBeforeMs: 20 + GOAL_ANALYSIS_MS,
				});
				expect(
					snapshot.watches.some(({ ref }) => ref === "initial-analysis"),
				).toBe(true);
				return asking;
			}
			expect(snapshot.openQuestions).toHaveLength(1);
			return choice("write");
		},
		{
			owners: {
				runner: {
					startInTransaction() {
						attempts++;
						return { status: "refused", reason: "observed" };
					},
					lookupInTransaction: () => ({ status: "absent" }),
					cancelInTransaction: () => true,
					wake() {},
				},
			},
			surface: () => ({
				capabilities: [capability("write")],
				watches: [],
				checks: [],
			}),
		},
	);
	try {
		const key = await f.register();
		await f.store.write((db) => {
			const saved = f.goals.authorizeWorkInTransaction(db, access, key, {
				operationKey: "grant",
				workspace: "local",
				toolchainRevisionId: "runner:1",
				impact: "edit",
				scope: workScope(true),
			});
			const design = f.goals.adoptGoalCriteriaInTransaction(db, access, key, {
				expectedVersion: saved.progress.progressVersion,
				source: original,
				criteria: [],
				design: { id: "design", digest: "frozen" },
			});
			if (design.status !== "applied") throw new Error("design_fixture_failed");
			f.progress.submitInTransaction(db, design.progress);
		});
		await f.until(() => f.state(key).state.watch?.ref === "initial-analysis");
		expect(f.state(key).state.questions).toHaveLength(1);
		f.advance(GOAL_ANALYSIS_MS - 1);
		await f.queue.tick();
		expect(attempts).toBe(0);
		expect(f.decisions()).toBe(1);
		f.advance(1);
		await f.until(() => attempts === 1);
		expect(
			f.state(key).state.questions.every(({ answeredBy }) => !answeredBy),
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("ending a whole-scope stop before its deadline releases the future reservation", async () => {
	const f = fixture(() => asking);
	try {
		await f.store.write((db) =>
			f.goals.setGoalScopeControlInTransaction(db, access, "work", {
				allUntilMs: 50_000,
				speechUntilMs: null,
			}),
		);
		const key = await f.register();
		expect(f.queue.get(f.state(key).jobId!)?.availableAtMs).toBe(50_000);
		await f.queue.tick();
		expect(f.decisions()).toBe(0);
		await f.store.write((db) => {
			f.goals.setGoalScopeControlInTransaction(db, access, "work", {
				allUntilMs: null,
				speechUntilMs: null,
			});
			f.progress.rescheduleScopeInTransaction(db, access, "work");
		});
		await f.until(() => f.state(key).phase === "needs_user");
		expect(f.decisions()).toBe(1);
	} finally {
		await f.close();
	}
});

test("an invalid decision is tried three times and resumes only after a changed configuration", async () => {
	let invalid = true;
	const f = fixture(() => (invalid ? { ...asking, contextId: "old" } : asking));
	try {
		const key = await f.register();
		for (let number = 1; number <= 3; number++) {
			f.advance(15_000);
			await f.until(() => f.decisions() === number);
		}
		await f.until(
			() => f.state(key).state.watch?.producer === "goal-configuration",
		);
		f.advance(15_000);
		await f.queue.tick();
		expect(f.decisions()).toBe(3);
		invalid = false;
		await f.store.write(f.progress.configurationChangedInTransaction);
		await f.until(() => f.state(key).phase === "needs_user");
		expect(f.decisions()).toBe(4);
	} finally {
		await f.close();
	}
});

test("a confirmed waiting owner returns the slot and takes it back for the same question once", async () => {
	const receipts = new Map<string, ReturnType<typeof held>>();
	const accepted: { attempt: string; question: string; answer: string }[] = [];
	const held = (attempt: GoalAttempt, question = false, completed = false) => {
		const version = completed ? 2 : 1;
		return {
			status: "known" as const,
			observation: {
				producer: attempt.owner,
				ref: attempt.dispatchId,
				version: String(version),
				digest: attempt.id + ":" + version,
				attempt: {
					id: attempt.id,
					dispatchId: attempt.dispatchId,
					ownerWorkId: attempt.dispatchId,
					ownerRevision: version,
					outcome: completed ? ("succeeded" as const) : ("running" as const),
					observed: null,
					resultRef: null,
					...(question
						? {
								question: {
									ref: "owner-question",
									prompt: "対象を教えてください。",
									expiresAtMs: 100_000,
									released: true,
								},
							}
						: {}),
				},
			},
		};
	};
	let first = "";
	let second = "";
	const f = fixture(
		(snapshot) => (snapshot.attempts.length ? asking : choice("read")),
		{
			sourceText: (_db, id) => (id === "answer" ? "Scope A" : id),
			owners: {
				runner: {
					startInTransaction(_db, row, attempt) {
						const entry = held(attempt, row.goalId === first);
						receipts.set(row.goalId, entry);
						return entry;
					},
					lookupInTransaction: (_db, row) =>
						receipts.get(row.goalId) ?? { status: "absent" },
					cancelInTransaction: () => true,
					answerInTransaction(_db, _row, attempt, _permit, answer) {
						accepted.push({
							attempt: attempt.id,
							question: answer.ref,
							answer: answer.answer,
						});
					},
					wake() {},
				},
			},
			surface: () => ({
				capabilities: [capability("read")],
				watches: [],
				checks: [],
			}),
		},
	);
	try {
		async function grant(key: Awaited<ReturnType<typeof f.register>>) {
			await f.store.write((db) => {
				const work = f.goals.authorizeWorkInTransaction(db, access, key, {
					operationKey: key.goalId,
					workspace: "local",
					toolchainRevisionId: "runner:1",
					impact: "read",
					scope: workScope(),
				});
				f.progress.submitInTransaction(db, work.progress);
			});
		}
		const parent = await f.register();
		first = parent.goalId;
		await grant(parent);
		await f.until(() => f.state(parent).phase === "needs_user");
		expect(f.state(parent).state.questions[0]).toMatchObject({
			ref: "owner-question",
			owner: { released: true },
		});
		expect(f.state(parent).currentWorkId).toBeNull();
		const attemptId = f.state(parent).state.questions[0]!.owner!.attemptId;
		const unrelated = await f.register(2, 70);
		second = unrelated.goalId;
		await grant(unrelated);
		await f.until(() => f.state(unrelated).phase === "observing");
		const answer = () =>
			f.store.write((db) => {
				const result = f.goals.answerGoalQuestionInTransaction(
					db,
					access,
					parent,
					"owner-question",
					"answer",
					20,
				);
				if (result.status === "applied")
					f.progress.submitInTransaction(db, result.progress);
				return result.status;
			});
		expect(await answer()).toBe("applied");
		expect(await answer()).toBe("replayed");
		expect(accepted).toHaveLength(0);
		await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, unrelated)!;
			const attempt = f.goals.goalAttemptInTransaction(
				db,
				access,
				unrelated,
				row.currentWorkId!,
			)!;
			const finished = held(attempt, false, true);
			receipts.set(second, finished);
			f.progress.notifyWorkInTransaction(db, row, finished.observation);
		});
		f.advance(10_000);
		await f.until(() => accepted.length === 1);
		expect(accepted).toEqual([
			{ attempt: attemptId, question: "owner-question", answer: "Scope A" },
		]);
		expect(f.state(parent).state.questions[0]).toMatchObject({
			answeredBy: "answer",
			delivered: true,
		});
		expect(f.state(parent).currentWorkId).toBe(attemptId);
	} finally {
		await f.close();
	}
});

test("an old unfinished owner hands an unmet goal to real read after its final receipt", async () => {
	let started = 0;
	const f = fixture(() => choice("read"), {
		legacyAccess: access,
		sourceText: (_db, id) => (id === "words" ? original : null),
		legacyReadPolicy(db, row) {
			return f.goals.authorizeWorkInTransaction(db, access, row, {
				operationKey: "legacy-read",
				workspace: "local",
				toolchainRevisionId: "runner:1",
				impact: "read",
				scope: {
					...workScope(),
					basis: { kind: "policy", revision: "read-1" },
				},
			}).progress;
		},
		owners: {
			runner: {
				startInTransaction() {
					started++;
					return { status: "refused", reason: "observed" };
				},
				lookupInTransaction: () => ({ status: "absent" }),
				cancelInTransaction: () => true,
				wake() {},
			},
		},
		surface: () => ({
			capabilities: [capability("read")],
			watches: [],
			checks: [],
		}),
	});
	try {
		const id = await f.store.write((db) => {
			const goal = f.goals.registerInTransaction(db, access, 1, {
				scopeKey: "work",
				desiredState: original,
				priority: 50,
				source,
				sourceMessageIds: ["words"],
				operationKey: "old",
			});
			db.query(
				"INSERT INTO goal_work (id,principal,goal_id,goal_revision,payload,state) VALUES (?,?,?,?,?,'accepted')",
			).run("old-work", access.principal, goal.id, 1, "{}");
			return { principal: access.principal, goalId: goal.id, goalRevision: 1 };
		});
		await f.progress.recover();
		expect(f.state(id).mode).toBe("mock");
		expect(started).toBe(0);
		await f.store.write((db) =>
			db.query("UPDATE goal_work SET state='failed' WHERE id='old-work'").run(),
		);
		await f.until(() => started > 0);
		expect(f.state(id)).toMatchObject({
			mode: "goal",
			deliveryConversationId: null,
			state: { sourceRef: "words" },
		});
	} finally {
		await f.close();
	}
});

test.skipIf(process.platform !== "darwin")(
	"accepted edits require a new independent check and a mismatch returns to editing",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "goal-fresh-proof-")));
		const a = join(root, "a.json");
		const b = join(root, "b.json");
		writeFileSync(a, '{"value":1}');
		writeFileSync(b, '{"value":0}');
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
		git("init", "-q");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"baseline",
		);
		const registry = createGoalWorkspaceRegistry(
			JSON.stringify([
				{
					ref: "registered",
					root,
					readablePaths: ["a.json", "b.json"],
					writablePaths: ["b.json"],
					checks: ["a", "b"].map((ref) => ({
						ref,
						description: "Check the saved value",
						command: "/bin/cat",
						args: [ref + ".json"],
						cwd: root,
						acceptance: true,
						expectedJson: { value: 1 },
					})),
				},
			]),
		);
		let verification: ReturnType<typeof createGoalVerification>;
		let edits = 0;
		const verified: string[][] = [];
		const f = fixture(
			(snapshot) => {
				if (
					snapshot.criteria.length === 2 &&
					snapshot.criteria[0]?.status === "passed" &&
					edits < 2 &&
					!snapshot.verificationRequired
				)
					return { ...choice("write"), criterionIds: ["root.1"] };
				if (edits) {
					expect(snapshot.verificationRequired).toEqual({
						attemptRef: snapshot.attempts.at(-1)!.ref,
						criterionIds: ["root", "root.1"],
					});
					expect(snapshot.capabilities).toHaveLength(0);
				}
				const criterionIds = snapshot.criteria
					.filter(({ status }) => status === "open")
					.map(({ id }) => id);
				verified.push(criterionIds);
				return {
					kind: "verify",
					criterionIds,
					checks: criterionIds.map((criterionId) => ({
						criterionId,
						checkRef: criterionId === "root" ? "a" : "b",
						evidenceRefs: [],
					})),
				};
			},
			{
				surface: (_db, row) => ({
					watches: [],
					capabilities: [capability("write")],
					verifyAfter: ["write"],
					checks: [
						{
							ref: "a",
							description: "A",
							criterionIds: [row.state.criteria[0]!.id],
						},
						{
							ref: "b",
							description: "B",
							criterionIds: [row.state.criteria[1]?.id ?? "root"],
						},
					],
				}),
				verify: (db, row) => verification.verify(db, row),
				verificationCurrent: (db, row, checks) =>
					verification.verificationCurrent(db, row, checks),
				staleVerificationEvidence: (db, row) =>
					verification.staleVerificationEvidence(db, row),
				owners: {
					runner: {
						startInTransaction(_db, _row, attempt) {
							edits++;
							writeFileSync(b, JSON.stringify({ value: edits === 1 ? 2 : 1 }));
							return {
								status: "known",
								observation: {
									producer: attempt.owner,
									ref: attempt.dispatchId,
									version: "1",
									digest: "edited",
									attempt: {
										id: attempt.id,
										dispatchId: attempt.dispatchId,
										ownerWorkId: attempt.dispatchId,
										ownerRevision: 1,
										outcome: "succeeded",
										observed: "File changed",
										resultRef: attempt.dispatchId,
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
		verification = createGoalVerification({
			goals: f.goals,
			workspaces: registry,
			sourcesCurrent: () => true,
		});
		try {
			const key = await f.register();
			await f.store.write((db) => {
				const permit = registry.resolve(
					{
						workspaceRef: "registered",
						mode: "edit",
						quote: "Quote",
						readablePaths: ["a.json", "b.json"],
						writablePaths: ["b.json"],
						checkRefs: ["a", "b"],
					},
					"words",
				)!;
				const grant = f.goals.authorizeWorkInTransaction(db, access, key, {
					...permit,
					toolchainRevisionId: "runner:1",
					operationKey: "grant",
				});
				const adopted = f.goals.adoptGoalCriteriaInTransaction(
					db,
					access,
					key,
					{
						expectedVersion: grant.progress.progressVersion,
						source: original,
						criteria: [{ text: "Condition B", sourceQuote: original }],
						design: { id: "design", digest: "content" },
					},
				);
				if (adopted.status !== "applied")
					throw new Error("goal_design_fixture");
				f.progress.submitInTransaction(db, adopted.progress);
			});
			f.advance(GOAL_ANALYSIS_MS);
			await f.until(() => f.state(key).phase === "completed");
			expect(edits).toBe(2);
			expect(verified).toEqual([
				["root", "root.1"],
				["root", "root.1"],
				["root", "root.1"],
			]);
			expect(f.state(key).state.criteria.map(({ status }) => status)).toEqual([
				"passed",
				"passed",
			]);
			const reports = f.store.read((db) =>
				f.goals.goalReportsInTransaction(db, access),
			);
			expect(reports).toHaveLength(1);
			expect(reports[0]?.report.criteria).toHaveLength(2);
		} finally {
			await f.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	10_000,
);

test("the physical slot is handed to the higher-priority eligible waiter", async () => {
	const starts: string[] = [];
	const known = (attempt: GoalAttempt, complete = false) => ({
		status: "known" as const,
		observation: {
			producer: attempt.owner,
			ref: attempt.dispatchId,
			version: complete ? "2" : "1",
			digest: complete ? "ended" : "working",
			attempt: {
				id: attempt.id,
				dispatchId: attempt.dispatchId,
				ownerWorkId: attempt.dispatchId,
				ownerRevision: complete ? 2 : 1,
				outcome: complete ? ("succeeded" as const) : ("running" as const),
				observed: null,
				resultRef: null,
			},
		},
	});
	const f = fixture(
		(snapshot) => (snapshot.attempts.length ? asking : choice("read")),
		{
			owners: {
				runner: {
					startInTransaction(_db, row, attempt) {
						starts.push(row.goalId);
						return known(attempt);
					},
					lookupInTransaction: (_db, row, attempt) =>
						starts.includes(row.goalId) ? known(attempt) : { status: "absent" },
					cancelInTransaction: () => true,
					wake() {},
				},
			},
			surface: () => ({
				capabilities: [capability("read")],
				watches: [],
				checks: [],
			}),
		},
		8,
	);
	try {
		async function grant(key: Awaited<ReturnType<typeof f.register>>) {
			await f.store.write((db) => {
				const work = f.goals.authorizeWorkInTransaction(db, access, key, {
					operationKey: key.goalId,
					workspace: "local",
					toolchainRevisionId: "runner:1",
					impact: "read",
					scope: workScope(),
				});
				f.progress.submitInTransaction(db, work.progress);
			});
		}
		const running = await f.register(1, 50);
		await grant(running);
		await f.until(() => f.state(running).phase === "observing");
		const low = await f.register(2, 10);
		const high = await f.register(3, 90);
		await grant(low);
		await grant(high);
		await f.until(() =>
			[low, high].every(
				(key) => f.state(key).state.problem === "goal_work_slot_busy",
			),
		);
		await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, running)!;
			const attempt = f.goals.goalAttemptInTransaction(
				db,
				access,
				running,
				row.currentWorkId!,
			)!;
			f.progress.notifyWorkInTransaction(
				db,
				row,
				known(attempt, true).observation,
			);
		});
		await f.until(() => starts.length === 2);
		expect(starts).toEqual([running.goalId, high.goalId]);
		expect(f.state(low).currentWorkId).toBeNull();
	} finally {
		await f.close();
	}
});
