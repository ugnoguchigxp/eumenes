import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations as capabilityMigrations,
} from "../../domains/capabilities";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import type { InferencePort } from "../../domains/inference";
import {
	createClaudeCode,
	migrations,
	type Runner,
} from "../../domains/claude-code";
import type {
	Decision,
	Observation,
} from "../../domains/claude-code/contracts";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import { createAdapterRegistry } from "../../domains/tool-runtime";
import { createClaudeCodeTaskAdapter } from "./claude-code-task-adapter";

async function harness(options: {
	runner: Runner;
	decide: (input: Record<string, unknown>, call: number) => Decision | "fail";
	now?: () => number;
}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-claude-improve-"));
	const store = openStore(join(dir, "db"), [
		...capabilityMigrations,
		...queueMigrations,
		...migrations,
	]);
	let service!: ReturnType<typeof createClaudeCode>;
	const adapter = createClaudeCodeTaskAdapter(() => service);
	const capabilities = createCapabilities(store, new Set(["claude-code"]), {
		bundleHost: () => bundleHostOf(createAdapterRegistry([adapter])),
	});
	await capabilities.seed();
	const queue = createQueue(store, { pollMs: 5 });
	const notices: string[] = [];
	const decisionInputs: Record<string, unknown>[] = [];
	let calls = 0;
	const inference = {
		captureUserControlInTransaction: () => `req-${++calls}`,
		executeControl: async (
			_id: string,
			messages: Array<{ content: string }>,
		) => {
			const payload = JSON.parse(messages.at(-1)!.content) as Record<
				string,
				unknown
			>;
			decisionInputs.push(payload);
			const chosen = options.decide(payload, calls);
			if (chosen === "fail") throw new Error("transient_llm_error");
			return {
				requestId: `req-${calls}`,
				attemptId: `att-${calls}`,
				value: JSON.stringify({ decision: chosen }),
			};
		},
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	service = createClaudeCode({
		store,
		queue,
		capabilities,
		inference,
		runner: options.runner,
		now: options.now,
	});
	let held = "";
	service.configure({
		validSourceInTransaction: () => true,
		validReferenceInTransaction: () => true,
		controlSourceInTransaction: (_db, _conv, messageId) => ({
			messageId,
			request: "許可する",
			digest: "verified",
		}),
		deliverInTransaction: (_db, view) => {
			notices.push(view.status);
			return true;
		},
		revokeInTransaction() {},
		workspace: {
			hold(_db, workId) {
				held ||= workId;
				return held === workId;
			},
			release(_db, workId, confirmed) {
				if (held === workId && confirmed) held = "";
			},
		},
	});
	queue.start();
	const work = await store.write((db) =>
		adapter.task!.startInTransaction(db, {
			source: {
				runId: "run",
				messageId: "message",
				conversationId: "conversation",
				request: "Fix login test and use port 3000",
				digest: "digest",
			},
			request: "Fix login test and use port 3000",
			references: [],
			toolchainRevisionId: "toolchain:claude-code.request@7",
			bindingRevisionId: "binding:claude-code.managed@1",
		}),
	);
	const view = () =>
		store.readSnapshot((db) => service.task.viewInTransaction(db, work.id)!);
	const waitFor = async (matches: () => boolean) => {
		for (let i = 0; i < 120; i++) {
			await service.recover();
			if (matches()) return;
			await Bun.sleep(5);
		}
		throw new Error(`Timed out in status=${view().status}`);
	};
	return {
		work,
		view,
		waitFor,
		notices,
		decisionInputs,
		control: (action: string, extra = {}) =>
			store.write((db) =>
				service.task.controlInTransaction(
					db,
					"conversation",
					{
						workRef: work.id,
						expectedRevision: service.task.viewInTransaction(db, work.id)!
							.revision,
						action,
						...extra,
					},
					"user-msg",
				),
			),
		async close() {
			await service.close();
			await queue.close(200);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("supervisor auto-replies to known-fact questions, escalates permissions directly to user, reads events, and preserves prior evidence across retries", async () => {
	const qAutoId = crypto.randomUUID();
	const qPermId = crypto.randomUUID();
	const replies: Array<{ questionId: string; answer: string }> = [];
	const eventReads: Array<{ id: string; after: number }> = [];
	let currentExecId = "";
	let firstExecId = "";
	let runCount = 0;
	let observed: Observation | null = null;

	const runner: Runner = {
		ready: () => true,
		async start({ id, deadline }) {
			runCount++;
			currentExecId = id;
			if (runCount === 1) {
				firstExecId = id;
				observed = {
					executionId: id,
					seq: 1,
					state: "waiting",
					managedExecutionStopped: false,
					question: {
						id: qAutoId,
						kind: "question",
						prompt: "Which port should be configured?",
						expiresAt: deadline,
						inputSchema: { type: "string" },
					},
				};
				return observed;
			}
			// Second execution finishes after continuing from error_max_turns
			observed = {
				executionId: id,
				seq: 1,
				state: "finished",
				managedExecutionStopped: true,
				summary: "Tests pass now",
				turns: 2,
				evidence: [{ ref: `${id}:1`, text: "bun test passed" }],
			};
			return observed;
		},
		async inspect() {
			return observed;
		},
		async events(id, after) {
			eventReads.push({ id, after });
			return {
				events: [
					{ seq: 1, text: "Edit login.ts succeeded" },
					{ seq: 2, text: "Test failed at line 42: expected 3000" },
				],
				next: 2,
			};
		},
		async reply(_id, _op, questionId, answer) {
			replies.push({ questionId, answer });
			if (questionId === qAutoId) {
				// After auto-reply, runner reports live tool progress then asks for a tool permission
				observed = {
					executionId: currentExecId,
					seq: 2,
					state: "waiting",
					managedExecutionStopped: false,
					lastTool: "Bash",
					eventCount: 1,
					question: {
						id: qPermId,
						kind: "permission",
						tool: "Bash",
						prompt: "Allow git commit?",
						expiresAt: Date.now() + 60_000,
						inputSchema: { type: "string" },
						options: ["許可する", "拒否する"],
					},
				};
				return observed;
			}
			// After user approves permission, execution hits max_turns with evidence
			observed = {
				executionId: currentExecId,
				seq: 3,
				state: "failed",
				resultSubtype: "error_max_turns",
				errorDetail: "Turn limit reached",
				managedExecutionStopped: true,
				canResume: true,
				turns: 30,
				evidence: [{ ref: `${currentExecId}:1`, text: "Edit login.ts" }],
			};
			return observed;
		},
		async stop() {
			return observed;
		},
	};

	let transientFailed = false;
	const h = await harness({
		runner,
		decide: (payload) => {
			if (payload.pendingQuestion) {
				return {
					action: "reply",
					summary: "元依頼に基づきポート 3000 と回答しました。",
					memo: "answered port",
					answer: "3000",
				};
			}
			const obs = payload.observation as {
				resultSubtype?: string;
				state?: string;
				executionId?: string;
			} | null;
			if (!obs) {
				if (!transientFailed) {
					transientFailed = true;
					return "fail";
				}
				return {
					action: "invoke",
					summary: "初回修正を依頼しました。",
					memo: "start",
					instruction: "Fix login test using port 3000",
				};
			}
			if (obs.resultSubtype === "error_max_turns") {
				if (!payload.eventExcerpts) {
					return {
						action: "read_events",
						summary: "詳細イベントを確認します。",
						memo: "inspect events",
						after: 0,
					};
				}
				return {
					action: "invoke",
					summary: "残りのテスト修正を継続します。",
					memo: "continue",
					instruction: "Finish fixing line 42",
				};
			}
			// Cite both the first execution's evidence ref and the second execution's ref
			return {
				action: "finish",
				status: "completed",
				summary: "修正と検証が完了しました。",
				memo: "done",
				fulfilled: ["login.ts updated", "tests passing"],
				missing: [],
				refs: [`${firstExecId}:1`, `${obs.executionId}:1`],
			};
		},
	});

	try {
		// Wait until permission question reaches user directly (auto-reply already succeeded without notifying user)
		await h.waitFor(() => h.view().status === "waiting_user");
		expect(replies).toEqual([{ questionId: qAutoId, answer: "3000" }]);
		expect(h.view().question?.id).toBe(qPermId);
		expect(h.view().progress?.summary).toContain("利用者の許可を待っています");

		// User approves the permission
		await h.control("answer", { questionRef: qPermId, input: "許可する" });

		// Supervisor reads detailed events, retries execution, cites cross-execution evidence, and completes
		await h.waitFor(() => h.view().status === "completed");
		expect(eventReads).toEqual([{ id: firstExecId, after: 0 }]);
		expect(runCount).toBe(2);
		expect(h.view().result?.status).toBe("completed");
		expect(h.view().result?.refs).toEqual([
			`${firstExecId}:1`,
			`${currentExecId}:1`,
		]);
	} finally {
		await h.close();
	}
});

test("question expiration in ordinary mode does not kill the whole task and non-LLM progress updates immediately", async () => {
	let clock = Date.now();
	let observed: Observation | null = null;
	const qId = crypto.randomUUID();
	const runner: Runner = {
		ready: () => true,
		async start({ id }) {
			observed = {
				executionId: id,
				seq: 1,
				state: "running",
				managedExecutionStopped: false,
				lastTool: "Edit",
				eventCount: 3,
			};
			return observed;
		},
		async inspect() {
			return observed;
		},
		async reply() {
			return observed!;
		},
		async stop() {
			return observed;
		},
	};
	const h = await harness({
		runner,
		now: () => clock,
		decide: (payload) => {
			if (!payload.observation)
				return {
					action: "invoke",
					summary: "開始します。",
					memo: "",
					instruction: "Run work",
				};
			return {
				action: "finish",
				status: "completed",
				summary: "完了しました。",
				memo: "",
				fulfilled: ["done"],
				missing: [],
				refs: [
					`${(payload.observation as { executionId: string }).executionId}:1`,
				],
			};
		},
	});
	try {
		await h.waitFor(() => h.view().status === "waiting_child");
		expect(h.view().progress?.summary).toContain("直近操作: Edit");
		expect(h.view().progress?.summary).toContain("イベント 3 件");

		// Runner asks a permission question that expires after 15 minutes
		observed = {
			...observed!,
			seq: 2,
			state: "waiting",
			question: {
				id: qId,
				kind: "permission",
				prompt: "Allow command?",
				expiresAt: clock + 15 * 60_000,
				inputSchema: { type: "string" },
			},
		};
		await h.waitFor(() => h.view().status === "waiting_user");

		// Advance past question deadline (15 min) while work deadline (30 min) is still active
		clock += 16 * 60_000;
		observed = {
			...observed!,
			seq: 3,
			state: "finished",
			question: undefined,
			managedExecutionStopped: true,
			evidence: [{ ref: `${observed!.executionId}:1`, text: "finished" }],
		};
		await h.waitFor(() => h.view().status === "completed");
		expect(h.view().result?.status).toBe("completed");
	} finally {
		await h.close();
	}
});

test("supervisor escalates ambiguous runner question via ask_user while preserving questionId for runner reply", async () => {
	const qId = crypto.randomUUID();
	const receivedReplies: Array<{ questionId: string; answer: string }> = [];
	let observed: Observation | null = null;
	const runner: Runner = {
		ready: () => true,
		async start({ id, deadline }) {
			observed = {
				executionId: id,
				seq: 1,
				state: "waiting",
				managedExecutionStopped: false,
				question: {
					id: qId,
					kind: "question",
					prompt: "Should we use REST or GraphQL?",
					expiresAt: deadline,
					inputSchema: { type: "string" },
					options: ["REST", "GraphQL"],
				},
			};
			return observed;
		},
		async inspect() {
			return observed;
		},
		async reply(_id, _op, questionId, answer) {
			receivedReplies.push({ questionId, answer });
			observed = {
				...observed!,
				seq: 2,
				state: "finished",
				question: undefined,
				managedExecutionStopped: true,
				evidence: [
					{ ref: `${observed!.executionId}:1`, text: "implemented REST" },
				],
			};
			return observed;
		},
		async stop() {
			return observed;
		},
	};
	const h = await harness({
		runner,
		decide: (payload) => {
			if (payload.pendingQuestion) {
				return {
					action: "ask_user",
					summary: "API 形式の選択を確認します。",
					memo: "need api choice",
					question: "API 形式は REST と GraphQL のどちらにしますか？",
				};
			}
			const obs = payload.observation as {
				executionId?: string;
				state?: string;
			} | null;
			if (!obs)
				return {
					action: "invoke",
					summary: "実装を開始します。",
					memo: "",
					instruction: "Implement endpoint",
				};
			return {
				action: "finish",
				status: "completed",
				summary: "REST で実装しました。",
				memo: "",
				fulfilled: ["REST endpoint"],
				missing: [],
				refs: [`${obs.executionId}:1`],
			};
		},
	});
	try {
		await h.waitFor(() => h.view().status === "waiting_user");
		expect(h.view().question?.id).toBe(qId);
		expect(h.view().question?.prompt).toContain("REST と GraphQL");
		await h.control("answer", { questionRef: qId, input: "REST" });
		await h.waitFor(() => h.view().status === "completed");
		expect(receivedReplies).toEqual([{ questionId: qId, answer: "REST" }]);
	} finally {
		await h.close();
	}
});
