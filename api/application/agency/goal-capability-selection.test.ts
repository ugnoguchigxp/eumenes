import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalAttempt } from "eumenes-agency/agenda/runtime";
import { createGoalDesignDocuments } from "./goal-design-documents";
import { createGoalPolicyConfiguration } from "./goal-policy-configuration";
import { access, fixture, original } from "./goal-progress.fixture";
import { createGoalSemanticVerification } from "./goal-semantic-verification";
import { createGoalVerification } from "./goal-verification";
import { composeGoalVerifiers } from "./goal-verifiers";
import { createGoalWorkspaceRegistry } from "./goal-workspaces";

function checkout(ready: boolean) {
	const root = mkdtempSync("/tmp/goal-existing-feature-");
	const git = (...argv: string[]) => execFileSync("git", ["-C", root, ...argv]);
	writeFileSync(join(root, "feature.json"), JSON.stringify({ ready }));
	git("init", "-q");
	git("add", "feature.json");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"existing feature",
	);
	return root;
}

const registration = (
	ref: string,
	root: string,
	policyCheckRefs = ["existing-result"],
) => ({
	ref,
	root,
	readablePaths: ["feature.json"],
	writablePaths: [],
	policyCheckRefs,
	checks: [
		{
			ref: "existing-result",
			description: "既存成果の現在値を固定の期待値と照合",
			acceptance: true,
			command: "/bin/cat",
			args: ["feature.json"],
			cwd: ".",
			expectedJson: { ready: true },
		},
	],
});

const webPolicy = () => ({
	toolchainRevisionId: "web@1",
	bindingRevisionId: "bind:web",
	workspace: "web",
	impact: "read",
	scope: {
		version: 1 as const,
		workspaceRef: "web",
		baselineCommit: "bind:web",
		readablePaths: [],
		writablePaths: [],
		checks: [],
		expiresAtMs: null,
		basis: { kind: "policy" as const, revision: "web@1" },
	},
});

test("only explicitly registered acceptance checks enter a read policy", () => {
	const root = checkout(true);
	try {
		const current = registration("local", root, []);
		expect(
			createGoalWorkspaceRegistry(JSON.stringify([current])).readPolicies(
				"read@1",
			)[0]?.scope.checks,
		).toEqual([]);
		for (const refs of [["missing"], ["existing-result", "existing-result"]]) {
			expect(() =>
				createGoalWorkspaceRegistry(
					JSON.stringify([registration("local", root, refs)]),
				),
			).toThrow("goal_workspace_policy_check_invalid");
		}
		expect(() =>
			createGoalWorkspaceRegistry(
				JSON.stringify([
					{
						...registration("local", root),
						checks: current.checks.map((check) => ({
							...check,
							acceptance: false,
						})),
					},
				]),
			),
		).toThrow("goal_workspace_policy_check_invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function observed(attempt: GoalAttempt) {
	return {
		status: "known" as const,
		observation: {
			producer: attempt.owner,
			ref: attempt.dispatchId,
			version: "1",
			digest: attempt.id,
			evidence: [
				{
					ref: "observed-file",
					version: "1",
					digest: attempt.id,
					summary: "登録された実物を読取",
					sources: ["words"],
				},
			],
			attempt: {
				id: attempt.id,
				dispatchId: attempt.dispatchId,
				ownerWorkId: attempt.dispatchId,
				ownerRevision: 1,
				outcome: "succeeded" as const,
				observed: "対象ファイルの現在値を読み取った",
				resultRef: "observed-file",
			},
		},
	};
}

for (const ready of [true, false])
	test(`an existing question resumes once after a local registration and adopts the actual ${ready ? "matching" : "mismatched"} check`, async () => {
		const root = checkout(ready);
		const other = checkout(true);
		const registered = createGoalWorkspaceRegistry(
			JSON.stringify([
				registration("existing", root),
				registration("unrelated", other, []),
			]),
		);
		let workspaces = createGoalWorkspaceRegistry(undefined);
		let verifier: ReturnType<typeof createGoalVerification>;
		let designs: ReturnType<typeof createGoalDesignDocuments>;
		let designCalls = 0;
		const delegated: { ref: string; id: string; mode: string }[] = [];
		const f = fixture(
			(snapshot) => {
				const local = snapshot.capabilities.find(
					({ allowedScope }) => allowedScope === "existing",
				);
				if (!snapshot.attempts.length && local) {
					expect(
						snapshot.capabilities
							.map(({ allowedScope }) => allowedScope)
							.sort(),
					).toEqual(["existing", "unrelated", "web"]);
					expect(
						new Set(snapshot.capabilities.map(({ ref }) => ref)).size,
					).toBe(3);
					const pending = snapshot.openQuestions.find(
						({ canResolve }) => canResolve,
					)!;
					expect(pending.configurationRef).toBe(snapshot.configuration?.ref);
					return {
						kind: "act",
						capabilityRef: local.ref,
						request: "現在の実物を読む",
						expectedObservation: "実物の現在値",
						evidenceRefs: [],
						resolvedQuestionRefs: [pending.ref],
					};
				}
				if (snapshot.verificationRequired) {
					expect(snapshot.checks).toHaveLength(1);
					return {
						kind: "verify",
						checks: [
							{
								criterionId: "root",
								checkRef: snapshot.checks[0]!.ref,
								evidenceRefs: ["observed-file"],
							},
						],
					};
				}
				return snapshot.attempts.length
					? {
							kind: "ask",
							missing: "期待値との差",
							question: "現在値が期待値と異なります。入力を確認できますか？",
						}
					: {
							kind: "ask",
							missing: "実物の参照先",
							question: "現物を確認できる作業先を指定できますか？",
						};
			},
			{
				sourceText: () => original,
				prepareDesign: (db, row) => designs.prepareDesign(db, row),
				deliveryConversationOf: (_db, ref) =>
					ref === "words" ? "original-conversation" : null,
				reconcileConfiguration(db, row) {
					return createGoalPolicyConfiguration({
						goals: f.goals,
						workspaces,
						binding: () => ({
							toolchainRevisionId: "read@1",
							bindingRevisionId: "bind:local",
						}),
						available: () => true,
						webPolicy,
					})(db, row);
				},
				surface: (_db, _row, permit) => ({
					checks: [],
					watches: [],
					verifyAfter:
						permit?.scope.workspaceRef === "existing" ? ["read"] : [],
					capabilities: permit
						? [
								{
									ref: "read",
									description: "現在の資料を読む",
									allowedScope: permit.scope.workspaceRef,
									owner: "worker",
									bindingRevisionId: "read@1",
									effect: "read",
								},
							]
						: [],
				}),
				owners: {
					worker: {
						startInTransaction(_db, _row, attempt, permit) {
							delegated.push({
								ref: permit.scope.workspaceRef,
								id: permit.id,
								mode: permit.impact,
							});
							expect(attempt.operationRef).toBe("read");
							return observed(attempt);
						},
						lookupInTransaction: () => ({ status: "absent" }),
						cancelInTransaction: () => true,
						wake() {},
					},
				},
				checks: (db, row) => verifier.checks(db, row),
				verify: (db, row) => verifier.verify(db, row),
				verificationCurrent: (db, row, checks) =>
					verifier.verificationCurrent(db, row, checks),
				staleVerificationEvidence: (db, row) =>
					verifier.staleVerificationEvidence(db, row),
			},
		);
		designs = createGoalDesignDocuments({
			goals: f.goals,
			generated: {
				configureOwner() {},
				startInTransaction() {
					throw new Error("readonly_goal_has_no_design");
				},
				originalInTransaction: () => null,
			},
			llm: () => {
				designCalls++;
				throw new Error("readonly_goal_drafts_no_design");
			},
			sourceText: () => original,
		});
		verifier = createGoalVerification({
			goals: f.goals,
			workspaces: registered,
			sourcesCurrent: () => true,
		});
		try {
			const key = await f.register(1, 50, "words");
			await f.progress.recover();
			await f.until(() => f.state(key).phase === "needs_user");
			const before = f.state(key);
			await f.progress.recover();
			await f.queue.tick();
			expect(f.state(key).progressVersion).toBe(before.progressVersion);
			expect(f.decisions()).toBe(1);
			workspaces = registered;
			await f.progress.recover();
			await f.until(() =>
				ready
					? f.state(key).phase === "completed"
					: f.state(key).state.questions.length === 2,
			);
			const final = f.state(key);
			expect(designCalls).toBe(0);
			expect(final.state.design).toBeNull();
			expect(final.deliveryConversationId).toBe("original-conversation");
			expect(final.goalRevision).toBe(key.goalRevision);
			expect(final.state.criteria[0]?.text).toBe(original);
			expect(final.state.criteria[0]?.status).toBe(ready ? "passed" : "open");
			expect(final.state.questions[0]).toMatchObject({
				ref: before.state.questions[0]?.ref,
				resolution: { observationRef: final.state.configuration?.ref },
			});
			expect(final.state.questions[0]?.answeredBy).toBeUndefined();
			expect(
				final.state.evidence.some(({ summary }) =>
					summary.includes(`"passed":${ready}`),
				),
			).toBe(true);
			expect(delegated).toEqual([
				{ ref: "existing", id: expect.any(String), mode: "read" },
			]);
			expect(
				f.store.read((db) =>
					f.goals.goalAttemptsInTransaction(db, access, key),
				)[0]?.permitId,
			).toBe(delegated[0]?.id);
			const decisions = f.decisions();
			await f.progress.recover();
			await f.queue.tick();
			expect(f.state(key).progressVersion).toBe(final.progressVersion);
			expect(f.decisions()).toBe(decisions);
			if (ready)
				expect(
					f.store.read((db) => f.goals.pendingGoalReportsInTransaction(db)),
				).toMatchObject([{ deliveryConversationId: "original-conversation" }]);
		} finally {
			await f.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

test("an unrelated local check is withheld from a goal with only Web document evidence", async () => {
	const root = checkout(true);
	const workspaces = createGoalWorkspaceRegistry(
		JSON.stringify([registration("unrelated", root)]),
	);
	const f = fixture(() => ({}));
	const machine = createGoalVerification({
		goals: f.goals,
		workspaces,
		sourcesCurrent: () => true,
	});
	const semantic = createGoalSemanticVerification({
		llm: () => ({
			async complete(request) {
				return {
					value: request.schema.parse({
						assessment: [
							{
								criterionId: "root",
								passed: true,
								reason: "調査の実物と一致",
								quotes: [{ ref: "web-document", quote: "特定の実測結果" }],
							},
						],
					}),
					model: "fixture",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					latencyMs: 0,
				};
			},
		}),
		read: (_db, _row, ref) =>
			ref === "web-document"
				? {
						id: ref,
						title: "調査",
						markdown: "ソースの特定の実測結果。",
						sources: ["words"],
					}
				: null,
		sourcesCurrent: () => true,
	});
	const verifier = composeGoalVerifiers(machine, semantic);
	try {
		const key = await f.register();
		const row = await f.store.write((db) => {
			const initial = createGoalPolicyConfiguration({
				goals: f.goals,
				workspaces,
				binding: () => ({
					toolchainRevisionId: "read@1",
					bindingRevisionId: "local@1",
				}),
				available: () => true,
				webPolicy,
			})(db, f.state(key));
			return f.goals.transitionProgressInTransaction(
				db,
				access,
				key,
				initial.progressVersion,
				(current) => ({
					phase: "ready",
					state: {
						...current.state,
						evidence: [
							{
								ref: "web-document",
								version: "1",
								digest: "proof",
								summary: "研究者の文書",
								sources: ["words"],
							},
						],
					},
				}),
			)!;
		});
		const checks = f.store.read((db) => verifier.checks(db, row));
		expect(checks.map(({ ref }) => ref)).toEqual(["goal-document-condition"]);
		const selected = {
			...row,
			state: {
				...row.state,
				next: {
					kind: "verify" as const,
					contextId: "web-verify",
					progressVersion: row.progressVersion,
					reason: "文書の実物で確認",
					review: null,
					criterionIds: ["root"],
					checks: [
						{
							criterionId: "root",
							checkRef: checks[0]!.ref,
							evidenceRefs: ["web-document"],
						},
					],
				},
			},
		};
		const run = f.store.read((db) => verifier.verify(db, selected));
		const results = await run!(new AbortController().signal);
		expect(results).toMatchObject([
			{ passed: true, checkRef: "goal-document-condition" },
		]);
		expect(
			f.store.read((db) => verifier.verificationCurrent(db, row, results)),
		).toBe(true);
	} finally {
		await f.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a runner availability change wakes a waiting goal once without changing its policy grant", async () => {
	const root = checkout(true);
	const workspaces = createGoalWorkspaceRegistry(
		JSON.stringify([registration("local", root, [])]),
	);
	let ready = false;
	let changed: () => void = () => {};
	let starts = 0;
	const f = fixture(
		(snapshot) => {
			const action = snapshot.capabilities[0];
			if (!action)
				return {
					kind: "ask",
					question: "現物を読めますか？",
					missing: "参照先",
				};
			return {
				kind: "act",
				capabilityRef: action.ref,
				request: "許可された資料を読む",
				expectedObservation: "現在値",
				evidenceRefs: [],
				resolvedQuestionRefs: snapshot.openQuestions
					.filter(({ canResolve }) => canResolve)
					.map(({ ref }) => ref),
			};
		},
		{
			onConfigurationChange(listener) {
				changed = listener;
				return () => {
					changed = () => {};
				};
			},
			reconcileConfiguration(db, row) {
				return createGoalPolicyConfiguration({
					goals: f.goals,
					workspaces,
					binding: () => ({
						toolchainRevisionId: "read@1",
						bindingRevisionId: "local@1",
					}),
					available: () => ready,
				})(db, row);
			},
			surface: (_db, _row, permit) => ({
				checks: [],
				watches: [],
				capabilities:
					permit && ready
						? [
								{
									ref: "read",
									effect: "read",
									description: "資料を読む",
									allowedScope: "読取",
									owner: "worker",
									bindingRevisionId: "local@1",
								},
							]
						: [],
			}),
			owners: {
				worker: {
					startInTransaction(_db, _row, attempt) {
						starts++;
						const { observation } = observed(attempt);
						return {
							status: "known",
							observation: {
								...observation,
								attempt: { ...observation.attempt, outcome: "running" },
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
	try {
		const key = await f.register();
		await f.progress.recover();
		await f.until(() => f.state(key).phase === "needs_user");
		const before = f.store.read((db) =>
			f.goals.goalPermitsInTransaction(db, access, key),
		);
		ready = true;
		changed();
		await f.until(() => starts === 1 && f.state(key).phase === "observing");
		const progressVersion = f.state(key).progressVersion;
		changed();
		await f.store.write(() => {});
		await f.queue.tick();
		expect(f.state(key).progressVersion).toBe(progressVersion);
		expect(f.decisions()).toBe(2);
		expect(
			f.store.read((db) => f.goals.goalPermitsInTransaction(db, access, key)),
		).toEqual(before);
	} finally {
		await f.close();
		rmSync(root, { recursive: true, force: true });
	}
});
