import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalStepSchema } from "eumenes-agency/agenda";
import { createGoalStore, goalMigrations } from "eumenes-agency/agenda/runtime";
import {
	createCapabilities,
	migrations as capMigrations,
} from "../../domains/capabilities";
import {
	createClaudeCode,
	migrations as claudeMigrations,
	type Runner,
} from "../../domains/claude-code";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import { migrations as kanbanMigrations } from "../../domains/kanban";
import type { InferencePort } from "../../domains/inference";
import { setupMemory } from "../../domains/memory/test/memory.fixture";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { createAdapterRegistry } from "../../domains/tool-runtime";
import { waitFor } from "../../infrastructure/wait-for";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import {
	claudeWorkspace,
	createClaudeCodeTaskAdapter,
	ordinaryClaudeWorkspaceRef,
} from "../work/claude-code-task-adapter";
import { createGoalClaude } from "../work/goal-claude";
import { testRunPassed } from "./goal-checkout-tests";
import { createGoalPolicyConfiguration } from "./goal-policy-configuration";
import { createGoalProgress } from "./goal-progress";
import { createGoalWork } from "./goal-work";
import {
	createGoalWorkspaceVerification,
	recoverGoalWorkspaceChecks,
	testCandidates,
	workspaceCheckRef,
} from "./goal-workspace-verification";
import { createGoalWorkspaceRegistry } from "./goal-workspaces";

const access = { principal: "owner", scopeKeys: ["work"] };
const testFile = "api/feature/display.test.ts";
const sourceFile = "api/feature/colour.ts";
const criterion = "設定から複数の背景色を保存できる";

for (const needsEdit of [false, true]) {
	test(`a registered goal ${needsEdit ? "makes the needed change" : "checks existing code"} through the ordinary workspace and reports once`, async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "goal-claude-execution-")),
		);
		const h = await setupMemory({
			extraMigrations: [
				...goalsMigrations,
				...goalMigrations,
				...capMigrations,
				...queueMigrations,
				...claudeMigrations,
				...kanbanMigrations,
			],
		});
		const { store, conversation } = h;
		const queue = createQueue(store, { pollMs: 5 });
		const goals = createGoalStore(store, createGoalsService());
		let claude: ReturnType<typeof createClaudeCode>;
		const adapter = createClaudeCodeTaskAdapter(() => claude);
		const capabilities = createCapabilities(store, new Set(["claude-code"]), {
			bundleHost: () => bundleHostOf(createAdapterRegistry([adapter])),
		});
		const workspace = claudeWorkspace(ordinaryClaudeWorkspaceRef)!;
		const permissionId = crypto.randomUUID();
		const finish = (id: string) => ({
			executionId: id,
			state: "finished" as const,
			seq: 2,
			managedExecutionStopped: true,
			evidence: [{ ref: "feature", text: testFile }],
		});
		const availableFiles = () =>
			writeFileSync(
				join(root, sourceFile),
				"export const setColour = (value: string) => value;\n",
			);
		const starts: { id: string; readOnly: boolean }[] = [];
		const runner: Runner = {
			ready: () => true,
			async start(spec) {
				starts.push({ id: spec.id, readOnly: spec.readOnly });
				expect(spec.supervised).toBeUndefined();
				expect(spec.readOnly).toBe(!needsEdit);
				if (needsEdit) {
					availableFiles();
					return finish(spec.id);
				}
				return {
					executionId: spec.id,
					state: "waiting",
					seq: 1,
					managedExecutionStopped: false,
					question: {
						id: permissionId,
						kind: "permission",
						tool: "Read",
						prompt: "作業先外のファイルを読み取りますか？",
						expiresAt: Date.now() + 10_000,
						inputSchema: {},
					},
				};
			},
			async inspect() {
				return null;
			},
			async stop() {
				return null;
			},
			async reply(id, _operationId, questionId, answer) {
				expect(questionId).toBe(permissionId);
				expect(answer).toBe("deny");
				return finish(id);
			},
		};
		const inference = {
			captureUserControlInTransaction: () => "request",
			executeControl: async (_id, messages) => {
				const input = JSON.parse(messages.at(-1)!.content);
				return {
					requestId: "request",
					attemptId: "attempt",
					value: JSON.stringify({
						decision: input.observation
							? {
									action: "finish",
									status: "completed",
									summary: "設定の保存を確認した",
									memo: "",
									fulfilled: [testFile],
									missing: [],
									refs: ["feature"],
								}
							: {
									action: "invoke",
									summary: "実装を確認する",
									memo: "",
									instruction: "現在の設定と試験を確認する",
								},
					}),
				};
			},
			acceptInTransaction: () => true,
		} satisfies Pick<
			InferencePort,
			| "captureUserControlInTransaction"
			| "executeControl"
			| "acceptInTransaction"
		>;
		claude = createClaudeCode({
			store,
			queue,
			capabilities,
			inference: inference as unknown as InferencePort,
			runner,
			root,
		});
		claude.configure({
			workspace,
			validSourceInTransaction: () => false,
			validReferenceInTransaction: () => false,
			controlSourceInTransaction: () => null,
			deliverInTransaction() {
				throw new Error("ordinary_conversation_was_used");
			},
			revokeInTransaction() {},
		});
		const sourcesCurrent = () => true;
		let progress: ReturnType<typeof createGoalProgress>;
		const ordinary = createGoalClaude({
			claude,
			goals,
			capabilities,
			enabled: () => true,
			sourceIsUser(db, ref) {
				const source = conversation.sourceInTransaction(db, ref);
				return source.state === "available" && source.message.role === "user";
			},
			sourcesCurrent,
			notify(db, row, observation) {
				progress.notifyWorkInTransaction(db, row, observation);
			},
		});
		const config = createGoalPolicyConfiguration({
			goals,
			workspaces: createGoalWorkspaceRegistry(undefined),
			binding: () => null,
			available: () => false,
			ordinary,
		});
		const permit = (
			db: Parameters<typeof config>[0],
			row: Parameters<typeof config>[1],
		) =>
			goals
				.goalPermitsInTransaction(db, access, row)
				.find((item) => ordinary.usesWorkspace(db, row, item));
		const llm = () =>
			({
				async complete(input: { system: string }) {
					return {
						value: input.system.includes("testFiles")
							? { testFiles: [testFile], domains: [] }
							: {
									passed: true,
									observation: "二色の保存値が期待結果に一致した",
								},
					};
				},
			}) as unknown as ReturnType<
				Parameters<typeof createGoalProgress>[0]["llm"]
			>;
		const verifier = createGoalWorkspaceVerification({
			store,
			goals,
			permit,
			sourcesCurrent,
			llm,
		});
		progress = createGoalProgress({
			store,
			goals,
			queue,
			llm,
			enabled: () => true,
			sourcesCurrent,
			reconcileConfiguration: config,
			owners: ordinary.owners,
			surface: (db, row, scope) =>
				scope
					? ordinary.surface(db, row, scope)
					: { capabilities: [], watches: [], checks: [] },
			checks: verifier.checks,
			verify: verifier.verify,
			verificationCurrent: (db, row, checks) =>
				checks.every(({ evidence }) =>
					verifier.evidenceCurrent(db, row, evidence),
				),
			async deliberate({ snapshot }) {
				const { context } = snapshot;
				const check = context.checks.find(
					({ ref }) => ref === workspaceCheckRef,
				);
				const planned = check
					? {
							kind: "verify",
							checks: [
								{ criterionId: "root", checkRef: check.ref, evidenceRefs: [] },
							],
						}
					: {
							kind: "act",
							capabilityRef: snapshot.capabilities.find(
								({ effect }) => effect === (needsEdit ? "write" : "read"),
							)!.ref,
							request: "設定画面の背景色の実装と検査を確認する",
							expectedObservation: "保存値の独立検査ができる",
							evidenceRefs: [],
						};
				return {
					kind: "step",
					step: goalStepSchema.parse({
						contextId: context.contextId,
						progressVersion: context.progressVersion,
						criterionIds: ["root"],
						reason: "通常の作業先が利用できる",
						review: null,
						resolvedQuestionRefs: context.openQuestions
							.filter(({ canResolve }) => canResolve)
							.map(({ ref }) => ref),
						...planned,
					}),
					planned: null,
				};
			},
		});
		const work = createGoalWork({
			store,
			goals,
			conversation,
			blocked: () => false,
			reply: () => {
				throw new Error("fixture_goal_reply_unused");
			},
		});
		const view = () => store.read((db) => work.viewsInTransaction(db))[0];
		try {
			mkdirSync(join(root, "api/feature"), { recursive: true });
			writeFileSync(
				join(root, testFile),
				[
					'import { expect, test } from "bun:test";',
					'import { setColour } from "./colour";',
					'test("the setting saves two colours", () => {',
					'  expect(setColour("#123456")).toBe("#123456");',
					'  expect(setColour("#abcabc")).toBe("#abcabc");',
					"});",
				].join("\n"),
			);
			if (!needsEdit) availableFiles();
			expect(
				Bun.spawnSync(["/usr/bin/git", "init", "-q", "--initial-branch=main"], {
					cwd: root,
				}).exitCode,
			).toBe(0);
			await capabilities.seed();
			const messageId = await h.say("user", criterion);
			const key = await store.write((db) => {
				const goal = goals.registerInTransaction(
					db,
					access,
					1,
					{
						scopeKey: "work",
						desiredState: criterion,
						priority: 50,
						source: {
							namespace: "conversation",
							kind: "message",
							id: messageId,
						},
						sourceMessageIds: [messageId],
						operationKey: "original",
					},
					{
						mode: "goal",
						startedAt: Date.now(),
						sourceRef: messageId,
						deliveryConversationId: "c1",
					},
				);
				const key = {
					principal: access.principal,
					goalId: goal.id,
					goalRevision: goal.revision,
				};
				const row = goals.progressInTransaction(db, access, key)!;
				const question = goals.applyDecisionInTransaction(
					db,
					access,
					key,
					{
						contextId: "before",
						progressVersion: row.progressVersion,
						kind: "ask",
						missing: "表示ファイルの読取許可",
						question: "作業先の資料への許可を追加できますか？",
						reason: "旧作業先の範囲",
						criterionIds: ["root"],
						review: null,
					},
					{ contextId: "before", current: () => true, nowMs: Date.now() },
				);
				expect(question.status).toBe("applied");
				expect(workspace.hold(db, "goal-check:prior-process")).toBe(true);
				recoverGoalWorkspaceChecks(db);
				expect(workspace.hold(db, "manual-terminal")).toBe(true);
				return key;
			});
			const state = () =>
				store.read((db) => goals.progressInTransaction(db, access, key)!);
			await progress.recover();
			progress.listen();
			queue.start();
			claude.start();
			await waitFor(() => state().phase === "observing");
			expect(starts).toHaveLength(0);
			expect(view()?.question).toBeNull();
			await store.write((db) => workspace.release(db, "manual-terminal", true));
			claude.flush();
			await waitFor(() => state().phase === "completed", { timeout: 14_000 });
			const done = state();
			expect(done.goalRevision).toBe(key.goalRevision);
			expect(done.state.criteria[0]).toMatchObject({
				id: "root",
				status: "passed",
			});
			expect(done.state.questions).toHaveLength(1);
			expect(done.state.questions[0]?.resolution).toBeDefined();
			const evidence = done.state.evidence.find(({ ref }) =>
				ref.startsWith("goal-workspace-proof:"),
			);
			expect(evidence && JSON.parse(evidence.summary)).toMatchObject({
				passed: true,
				checks: [{ tests: [testFile], exitCode: 0, passed: true }],
			});
			// The report is the agent's to tell as its assignment's: nothing is written to the conversation for it.
			const met = view()!;
			expect(met.report?.text).toBeTruthy();
			await store.write((db) => work.reportedInTransaction(db, met));
			const delivered = store.read((db) =>
				goals.goalReportsInTransaction(db, access),
			);
			expect(delivered).toHaveLength(1);
			expect(delivered[0]?.state).toBe("delivered");
			expect(view()).toBeUndefined();
			expect(conversation.get("c1").messages.map(({ role }) => role)).toEqual([
				"user",
			]);
			expect(starts).toHaveLength(1);
		} finally {
			progress.close();
			await claude.close();
			await queue.close(1_000);
			await h.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
}

test("a passing process cannot certify a requested file without a passing test in that file", () => {
	const different = "api/another spec/example.spec.ts";
	const result = {
		exitCode: 0,
		stdout: "",
		stderr: `${testFile}:
(skip) conditional test

${different}:
(pass) unrelated test

1 pass
`,
	};
	expect(testRunPassed([testFile], result)).toBe(false);
	expect(testRunPassed([testFile, different], result)).toBe(false);
	expect(testRunPassed([different], result)).toBe(true);
});

test("a design-system run labels its lines with the project, and the file still counts as passed", () => {
	const file = "packages/design-system/src/components/Avatar/Avatar.test.tsx";
	const result = {
		exitCode: 0,
		stdout:
			" ✓  unit  src/components/Avatar/Avatar.test.tsx > Avatar > renders 10ms\n",
		stderr: "",
	};
	expect(testRunPassed([file], result)).toBe(true);
});

test("an identifier the findings name reaches the test whose path joins the same words", () => {
	const tests = [
		...Array.from({ length: 300 }, (_, n) => `api/other/feature-${n}.test.ts`),
		"web/src/components/domains/conversation/HiyoriAvatarBackground.test.tsx",
	];
	const ranked = testCandidates(
		tests,
		"設定画面から general.avatarBackgroundColor を経て会話画面で描画する経路を確認した。",
	);
	expect(ranked[0]).toBe(
		"web/src/components/domains/conversation/HiyoriAvatarBackground.test.tsx",
	);
});
