import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import type { DialogueService } from "../../domains/dialogue";
import type { Run } from "../../domains/dialogue/contracts";
import type { ChildExecution } from "../../domains/tool-runtime";
import { createDotsDialogue } from "../work/dots-dialogue";
import { dotsFixture } from "../work/dots-fixture";
import { taskLegacyPorts } from "./task-legacy-execution";
import { harness } from "./toolchain.fixture";
import { objectRecognitionFixture } from "../media/object-recognition.fixture";
import { analysisArgs } from "../../domains/dialogue/test/analysis.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("legacy delegation waits beyond acceptance, relays an owned question and adopts only the external completion", async () => {
	const f = await dotsFixture();
	try {
		const source = {
			conversationId: "main",
			messageId: crypto.randomUUID(),
			runId: crypto.randomUUID(),
			request: "Perform the delegated work",
			digest: "digest",
		};
		await f.conversation.append({
			id: source.messageId,
			conversationId: source.conversationId,
			role: "user",
			text: source.request,
			runId: source.runId,
			createdAt: new Date().toISOString(),
		});
		const run = {
			id: source.runId,
			inputMessageId: source.messageId,
			conversationId: source.conversationId,
			sourceKind: "manual",
			revision: 0,
		} as Run;
		const owner = createDotsDialogue(f);
		const snapshot = f.store.read(
			(db) => owner.prepareInTransaction(db, run).catalog,
		);
		const dialogue = {
			executionCommands: {
				legacyAvailableInTransaction: () => true,
				invokeLegacyInTransaction: (
					db: any,
					child: ChildExecution,
					_prepared: unknown,
					command: any,
				) =>
					owner.invokeInTransaction(db, run, command, snapshot, {
						callId: child.dispatchId ?? child.id,
						deadline: child.deadline,
					}),
				legacyTaskInTransaction: owner.executionTaskInTransaction,
				cancelLegacyTaskInTransaction: owner.cancelExecutionTaskInTransaction,
			},
		} as unknown as DialogueService;
		const port = taskLegacyPorts(dialogue);
		const child: ChildExecution = {
			id: crypto.randomUUID(),
			dispatchId: crypto.randomUUID(),
			executionId: crypto.randomUUID(),
			revision: 0,
			step: 1,
			chainRevisionId: "toolchain:dots.delegate@1",
			request: source.request,
			source,
			deadline: Date.now() + 180000,
			modelCalls: 10,
			refs: [],
		};
		const prepared = { backend: "dots" } as Parameters<
			typeof port.invokeInTransaction
		>[2];
		const command = {
			operation: "start",
			projectRef: "project",
			title: "work",
			request: source.request,
			completionConditions: ["Tests pass"],
			operations: ["read", "create_session", "edit", "check"],
			maxSessions: 1,
		};
		const start = () =>
			f.store.write((db) =>
				port.invokeInTransaction(db, child, prepared, command),
			);
		const initial = await start();
		expect(initial.state).toBe("running");
		const taskId = (initial.ref as { taskId: string }).taskId;
		expect(taskId).toBeString();
		expect((await start()).ref).toEqual(initial.ref);
		expect(
			f.tasks.list({ conversationId: "main", limit: 50 }).items,
		).toHaveLength(1);
		const current = () =>
			f.store.read((db) => port.currentInTransaction(db, child, initial.ref));
		const external = f.command(taskId);
		await f.dots.claim("dots", {
			commandId: external.commandId,
			leaseId: crypto.randomUUID(),
		});
		await f.dots.report(
			"dots",
			f.report(external, 1, "session_started", { sessions: [f.session] }),
		);
		await f.dots.report(
			"dots",
			f.report(external, 2, "blocked", {
				question: {
					questionId: "target",
					prompt: "Choose a target",
					answerType: "choice",
					choices: ["A", "B"],
				},
			}),
		);
		const question = current();
		expect(question).toMatchObject({
			state: "waiting_input",
			question: "Choose a target",
			questionSchema: { type: "string", enum: ["A", "B"] },
		});
		expect(
			f.store.read((db) =>
				port.validateAnswerInTransaction(db, child, question.ref, "C"),
			),
		).toBe(false);
		expect(
			f.store.read((db) =>
				port.validateAnswerInTransaction(db, child, question.ref, "B"),
			),
		).toBe(true);
		expect(
			f.store.read((db) =>
				port.validateAnswerInTransaction(
					db,
					{ ...child, source: { ...source, conversationId: "other" } },
					question.ref,
					"B",
				),
			),
		).toBe(false);
		await f.store.write((db) =>
			owner.invokeInTransaction(
				db,
				run,
				{
					operation: "answer",
					taskRef: taskId,
					questionId: "target",
					answer: "B",
				},
				owner.prepareInTransaction(db, run).catalog,
				{ callId: crypto.randomUUID(), deadline: child.deadline },
			),
		);
		expect(current().state).toBe("running");
		expect(
			f.store.read((db) =>
				port.validateAnswerInTransaction(db, child, question.ref, "B"),
			),
		).toBe(false);
		const answer = f.command(taskId, "answer");
		await f.dots.claim("dots", {
			commandId: answer.commandId,
			leaseId: crypto.randomUUID(),
		});
		await f.dots.report("dots", f.report(answer, 3, "accepted"));
		await f.dots.report(
			"dots",
			f.report(answer, 4, "completed", {
				evidenceRefs: ["test-run"],
				completionChecks: [{ status: "satisfied", evidenceRefs: ["test-run"] }],
			}),
		);
		expect(current().state).toBe("completed");
	} finally {
		await f.close();
	}
});

test("a public parent hands camera interaction to the existing screen without taking a capture or declaring the request complete", async () => {
	const f = objectRecognitionFixture();
	let steps = 0;
	const h = await harness({
		everyday: true,
		recognitionFetcher: f.fetcher,
		routeTool: "object_recognition",
		firstRound: () => ({
			name: "execute_task",
			args: {
				...analysisArgs({ kind: "action", impact: "create" }),
				request:
					"Open the object observation workspace, then use an observation",
				contextRefs: [],
				announcement: "観測の画面を準備します。",
			},
		}),
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "object-recognition.manage",
				arguments: {
					action: "open",
					id: "",
					frameIndex: -1,
					source: "camera",
					question: "",
				},
			}),
		taskStep: (_tools, messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			if (packet.plan.required)
				return taskPlan("Open the observation workspace");
			return ++steps === 1
				? {
						name: "find_toolchain",
						arguments: { query: "object observation screen" },
					}
				: {
						name: "object_recognition",
						arguments: {
							stepRef: taskItem(packet),
							contextRefs: [],
						},
					};
		},
	});
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "観測の画面を準備し、結果を使ってください",
		});
		await waitFor(
			() => h.toolchain.agents.executions.list("main")[0]?.status === "partial",
			{ timeout: 5000 },
		);
		expect(h.toolchain.agents.executions.list("main")[0]?.result?.code).toBe(
			"interactive_handoff",
		);
		const calls = h.store.read((db) =>
			db
				.query(
					"SELECT call_id,run_id,result_json FROM object_recognition_execution_commands",
				)
				.all(),
		) as Array<{ call_id: string; run_id: string; result_json: string }>;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.run_id).toBe(source.id);
		expect(calls[0]!.call_id).not.toBe(source.id);
		expect(JSON.parse(calls[0]!.result_json)).toMatchObject({
			action: "open",
			state: "ready_for_input",
		});
		expect(f.calls).toEqual([]);
	} finally {
		await h.close();
	}
}, 10000);
