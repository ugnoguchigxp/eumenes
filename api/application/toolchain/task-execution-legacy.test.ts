import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import type { DialogueService } from "../../domains/dialogue";
import type { ChildExecution } from "../../domains/tool-runtime";
import { createDotsDialogue } from "../work/dots-dialogue";
import { dotsFixture } from "../work/dots-fixture";
import { taskLegacyPorts } from "./task-legacy-execution";
import { harness } from "./toolchain.fixture";
import { objectRecognitionFixture } from "../media/object-recognition.fixture";
import { handOverTask } from "./task-delegation.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("already saved legacy work remains inspectable across migration; new legacy starts are unavailable", async () => {
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
		const owner = createDotsDialogue(f);
		const dialogue = {
			executionCommands: {
				legacyAvailableInTransaction: () => false,
				invokeLegacyInTransaction: () => {
					throw new Error("adapter_unavailable");
				},
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
		const saved = await f.tasks.create(f.input(), {
			origin: {
				source: "conversation",
				conversationId: source.conversationId,
				messageId: source.messageId,
				runId: source.runId,
				operationKey: "historical",
			},
		});
		const taskId = saved.taskId,
			initial = { ref: { kind: "legacy", type: "dots", taskId } };
		expect(
			f.store.read((db) =>
				port.availableInTransaction(
					db,
					"dots",
					child.chainRevisionId,
					source.runId,
				),
			),
		).toBe(false);
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
		await f.tasks.answer(taskId, {
			requestId: crypto.randomUUID(),
			expectedRevision: f.tasks.get(taskId).task.revision,
			questionId: "target",
			answer: "B",
		});

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
		discoveryTarget: (query) =>
			query === "object observation screen"
				? "object_recognition"
				: "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(
				"Open the object observation workspace, then use an observation",
				"観測の画面を準備します。",
			)(messages),
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
