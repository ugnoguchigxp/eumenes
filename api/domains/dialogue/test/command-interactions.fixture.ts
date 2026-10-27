import { rmSync } from "node:fs";
import { toolFields } from "./tool-text.fixture";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ToolchainCard, ToolchainRuntimeMeta } from "../../capabilities";
import { createContinuityService } from "../../continuity";
import { createConversationService } from "../../conversation";
import type { InferencePort, Receipt } from "../../inference";
import { createQueue } from "../../queue";
import { createDialogueService } from "..";
import type {
	BoundCommandPort,
	BoundCommandSet,
	ToolchainRoutingPort,
} from "../contracts/toolchains";
import { COMMAND_KIND, type ChatMessage } from "../service/context";
import { openDialogueStore } from "./store.fixture";
import { testConversationAgent } from "./conversation-agent.fixture";

export const REVISION = "toolchain:fake.manage@1";
export const BINDING = "binding:fake.command@1";
export const PACKAGE = "package:fake.manage@1";
export const ADAPTER = "adapter:fake@1";
export const baseSet: Omit<BoundCommandSet, "questions"> = {
	bindingRevisionId: BINDING,
	adapterRef: ADAPTER,
	artifactRevisionId: "artifact:fake.workspace@1",
	packageRevisionId: PACKAGE,
	tools: [
		{
			id: "fake.start",
			toolRevisionId: "tool:fake.start@1",
			operationName: "fake.start",
			inputSchemaRef: "builtin:fakeStart",
			summary: "開始する",
			schema: {
				type: "object",
				properties: { seconds: { type: "integer" } },
				required: ["seconds"],
				additionalProperties: false,
			},
		},
	],
};
/** The question schemas this fake binding allows besides the generic text. */
export const QUESTIONS: BoundCommandSet["questions"] = [
	{ inputSchemaRef: "builtin:timerDurationAnswer" },
	{ inputSchemaRef: "builtin:timerTargetAnswer", choiceField: "timerId" },
];
export const card: ToolchainCard = {
	revisionId: REVISION,
	id: "fake.manage",
	functionName: "fake_op",
	title: "偽の操作",
	summary: "偽の操作を行う",
	useWhen: ["偽の操作"],
	execution: "command",
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};

/** True when the newest message is the result of a tool call that handed the work over. */
function afterHandover(messages: ChatMessage[]): boolean {
	const last = messages.at(-1);
	if (last?.role !== "tool") return false;
	const call = messages
		.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : []))
		.find((c) => c.id === last.tool_call_id);
	if (!call) return false;
	const result = toolFields(last.content);
	if (call.function.name === "delegate") return result.delegated === true;
	return (
		call.function.name === "work" &&
		(JSON.parse(call.function.arguments) as { operation?: string })
			.operation === "answer" &&
		result.ok === true
	);
}
export const until = (check: () => boolean, ms = 4000) =>
	waitFor(check, { timeout: ms });
export type Command = Record<string, unknown>;
type Step = {
	text?: string;
	calls?: Array<{ name: string; args: Record<string, unknown> }>;
};

/**
 * A real store, queue, continuity and dialogue with a scripted conversation model, a scripted command sub-agent
 * and a fake bound command toolchain (one tool, its question schemas and an adapter outcome).
 *
 * The conversation model's calls come from `state.steps` (FIFO, as in the generation fixture); the command
 * sub-agent's replies come from `state.commands` (FIFO). A command run is reached through a delegate call of the
 * scripted conversation model (`asked`) or put on a run directly (`commandRun`).
 */
export async function setup(
	options: {
		/** The binding's allowed question schemas (default: QUESTIONS). */
		questions?: BoundCommandSet["questions"];
		/** The chain has no binding; its runtime backend is this (or none). */
		bound?: false;
		backend?: string;
		/** The binding's adapter is available (default true). */
		available?: boolean;
		/** Start the queue at once (default true); `commandRun` needs it off and starts it itself. */
		autoStart?: boolean;
	} = {},
) {
	const set: BoundCommandSet = {
		...baseSet,
		questions: options.questions ?? QUESTIONS,
	};
	const { dir, store } = openDialogueStore("eumenes-interactions-");
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const state = {
		activeRevision: REVISION,
		/** Added to the dialogue's clock (ms). */
		offset: 0,
		queueFull: false,
		/** What the agent runtime reports for the saved operation. */
		outcome: null as unknown,
		/** Holds each command sub-agent call until released. */
		gate: null as Promise<void> | null,
		/** Holds the conversation model's call after it is recorded (to change what the call showed meanwhile). */
		modelGate: null as Promise<void> | null,
		/** The conversation model's scripted calls. */
		steps: [] as Step[],
		/** The command sub-agent's replies, consumed in order. */
		commands: [] as Command[],
		/** Host-issued choices per question schema ref. */
		choices: {} as Record<string, Array<{ ref: string; label: string }>>,
	};
	const calls: Array<{ messages: ChatMessage[]; tools: string[] }> = [];
	/** Indexes of the model calls made after a delegation or a command answer already handed the work over. */
	const afterHandoverCalls: number[] = [];
	const commandPrompts: Array<Array<{ role: string; content: string }>> = [];
	const commandSchemas: string[] = [];
	const commandSessions: unknown[] = [];
	const releasedSessions: string[] = [];
	const commandCaptures: Array<Record<string, unknown>> = [];
	const started: Array<Record<string, any>> = [];
	const roots: Array<{ runId: string; eventId: string; reserved: boolean }> =
		[];
	const routed: string[][] = [];
	const selections: Array<Record<string, any>> = [];
	const settled: Array<{ outcome: string; code?: string | null }> = [];
	const clock = () => new Date(Date.now() + state.offset).toISOString();
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		requestFor: (_db: unknown, runId: string) => `req:${runId}`,
		llmContextWindowInTransaction: () => undefined,
		setContextPolicyInTransaction: () => {},
		validateReceiptInTransaction: () => true,
		acceptInTransaction: () => true,
		releaseTaskSession: async (taskId: string) => {
			releasedSessions.push(taskId);
		},
		captureControlInTransaction: (_db: unknown, input: { subject: string }) => {
			if (input.subject.endsWith(":command"))
				commandCaptures.push(input as Record<string, unknown>);
			return "control";
		},
		executeControl: async (
			requestId: string,
			prompt: Array<{ role: string; content: string }>,
			_signal?: AbortSignal,
			control?: { outputSchema?: unknown },
			session?: unknown,
		) => {
			commandPrompts.push(prompt);
			commandSessions.push(session);
			commandSchemas.push(JSON.stringify(control?.outputSchema ?? null));
			await state.gate;
			const next = state.commands.shift();
			if (!next) throw new Error("fixture_command_missing");
			return {
				requestId,
				attemptId: "command",
				value: JSON.stringify(next),
			} as Receipt;
		},
		answer: async () => {
			throw new Error("unexpected_answer");
		},
		executeStream: async (
			requestId: string,
			messages: ChatMessage[],
			signal: AbortSignal,
			delta: (text: string) => void,
			_preparation: unknown,
			tools: Array<{ function: { name: string } }> | undefined,
		) => {
			calls.push({
				messages: messages.map((m) => ({ ...m })),
				tools: (tools ?? []).map((t) => t.function.name),
			});
			// A call right after a handover is not part of the script: the generation should have ended there.
			const step = afterHandover(messages)
				? (afterHandoverCalls.push(calls.length - 1), {} as Step)
				: state.steps.shift();
			if (!step) throw new Error("fixture_step_missing");
			// Held after the call is recorded and its step taken: the state the call showed is fixed meanwhile.
			if (state.modelGate) await state.modelGate;
			signal.throwIfAborted();
			if (step.text) delta(step.text);
			return {
				requestId,
				attemptId: crypto.randomUUID(),
				value: step.text ?? "",
				toolCalls: (step.calls ?? []).map((call): NativeToolCall => ({
					id: crypto.randomUUID(),
					name: call.name,
					arguments: JSON.stringify(call.args),
				})),
			} as Receipt;
		},
	} as unknown as InferencePort;
	const agents = {
		startInTransaction: (_db: unknown, input: Record<string, any>) => {
			started.push(input);
			// The saved operation is known at once: its answer is ready for the run that started it.
			roots.push({
				runId: input.rootRunId as string,
				eventId: `event-${started.length}`,
				reserved: false,
			});
			return {
				taskId: `task-${started.length}`,
				jobId: input.parentJobId as string,
			};
		},
		actionOutcomeInTransaction: () => state.outcome,
		// The saved operation's projection, as the answer of the run that started it.
		prepareAnswerInTransaction: (_db: unknown, runId: string) => ({
			taskId: `task-${started.length}`,
			eventId: `event:${runId}`,
			revision: 0,
			dataEpoch: 0,
			reportTaskId: null,
			reportEpoch: null,
			reportDigest: null,
			projection: null,
			failureCode: null,
			actionPayload: JSON.stringify(state.outcome ?? { state: "saved" }),
			actionFailure:
				(state.outcome as { state?: string } | null)?.state === "failed",
		}),
		completeAnswerInTransaction: () => {},
		cancelTreeInTransaction: () => {},
		pendingEvents: () =>
			roots
				.filter((root) => !root.reserved)
				.map((root) => ({ id: root.eventId, root_run_id: root.runId })),
		byRootInTransaction: () => ({
			state: "ready_for_answer",
			deadline: Date.now() + 3_600_000,
			error_code: null,
		}),
		reserveAnswerInTransaction: (_db: unknown, eventId: string) => {
			const root = roots.find((r) => r.eventId === eventId);
			if (root) root.reserved = true;
		},
		failAnswerInTransaction: () => {},
	} as never;
	const bound: BoundCommandPort = {
		snapshotInTransaction: () => ({ items: [] }),
		parseInvocation(boundSet, toolId, args) {
			const tool = boundSet.tools.find((t) => t.id === toolId);
			if (!tool) return { ok: false, code: "toolchain_command_tool_unknown" };
			const seconds = (args as { seconds?: unknown }).seconds;
			if (!Number.isInteger(seconds))
				return { ok: false, code: "toolchain_command_invalid_arguments" };
			return {
				ok: true,
				toolRevisionId: tool.toolRevisionId,
				operationName: tool.operationName,
				input: { seconds: seconds as number },
			};
		},
		questionChoicesInTransaction: (_db, _binding, ref) =>
			state.choices[ref] ?? [],
		parseAnswer(ref, input) {
			const value = input as Record<string, unknown> | null;
			if (ref === "builtin:timerTargetAnswer")
				return typeof value?.timerId === "string"
					? { ok: true, value: { timerId: value.timerId } }
					: { ok: false, code: "invalid_answer" };
			if (ref === "schema:pick-item@1")
				return typeof value?.itemId === "string"
					? { ok: true, value: { itemId: value.itemId } }
					: { ok: false, code: "invalid_answer" };
			if (ref === "builtin:answerText") {
				const text = typeof value?.text === "string" ? value.text.trim() : "";
				return text.length >= 1 && text.length <= 500
					? { ok: true, value: { text } }
					: { ok: false, code: "invalid_answer" };
			}
			const seconds = value?.durationSeconds;
			return ref === "builtin:timerDurationAnswer" &&
				Number.isInteger(seconds) &&
				(seconds as number) >= 1 &&
				(seconds as number) <= 86400
				? { ok: true, value: { durationSeconds: seconds } }
				: { ok: false, code: "invalid_answer" };
		},
		prepareInTransaction: () => ({ package: { revisionId: PACKAGE } }),
	};
	const runtime = (): ToolchainRuntimeMeta =>
		({
			execution: "command",
			...(options.bound === false
				? options.backend
					? { requires: options.backend }
					: {}
				: {
						binding: {
							bindingRevisionId: BINDING,
							adapterRef: ADAPTER,
							artifactRevisionId: set.artifactRevisionId,
							available: options.available ?? true,
						},
					}),
		}) as ToolchainRuntimeMeta;
	const current = () => ({ ...card, revisionId: state.activeRevision });
	const toolchains = {
		embedQuery: async () => undefined,
		routeInTransaction: (
			_db: unknown,
			input: { available: ReadonlySet<string> },
		) => {
			routed.push([...input.available]);
			return { cards: [current()], past: [], retrieval: "fts" };
		},
		cardInTransaction: (_db: unknown, revisionId: string) =>
			revisionId === state.activeRevision ? current() : undefined,
		catalogInTransaction: () => [
			{ id: card.id, revisionId: state.activeRevision, runtime: runtime() },
			{
				id: "needs.unknown",
				revisionId: "toolchain:needs.unknown@1",
				runtime: { execution: "command", requires: "dots" },
			},
			{
				id: "research.web",
				revisionId: "toolchain:research.web@1",
				runtime: { execution: "research", route: "web" },
			},
		],
		resolveInTransaction: (_db: unknown, revisionId: string) => {
			if (revisionId !== state.activeRevision)
				throw new Error("toolchain_unavailable");
			return {
				toolchain: { functionName: card.functionName },
				packageRevisionId: PACKAGE,
				runtime: runtime(),
			};
		},
		commandSetInTransaction: () => ({
			backend: options.backend,
			profile: "操作担当",
			skills: ["手順"],
			tools: [],
			...(options.bound === false ? {} : { binding: set }),
		}),
		...(options.bound === false ? {} : { bound }),
		recordSelectionInTransaction: (
			_db: unknown,
			input: Record<string, unknown>,
		) => {
			selections.push(input);
			return "selection";
		},
		settleSelectionInTransaction: (
			_db: unknown,
			_runId: string,
			result: { outcome: string; code?: string | null },
		) => {
			settled.push(result);
		},
		linkTaskInTransaction: () => {},
		requestOfRunInTransaction: (_db: unknown, runId: string) =>
			selections.find((s) => s.runId === runId)?.request ??
			"偽の操作を開始する",
	} as unknown as ToolchainRoutingPort;
	const rawQueue = createQueue(store);
	const queue = new Proxy(rawQueue, {
		get(target, property) {
			if (property === "enqueueInTransaction")
				return (tx: never, input: { kind: string }) => {
					if (state.queueFull && input.kind === COMMAND_KIND)
						throw new Error("queue_full");
					return target.enqueueInTransaction(tx, input as never);
				};
			const value = (target as never as Record<string | symbol, unknown>)[
				property
			];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	/** The conversations the conversation agent was told a TODO changed in (its opportunity to report it). */
	const workChanged: string[] = [];
	const dialogue = createDialogueService({
		conversationAgent: testConversationAgent,
		agency: {
			workChangedInTransaction: (_db, conversationId) => {
				workChanged.push(conversationId);
			},
		},
		store,
		conversation,
		larm,
		queue,
		agents,
		toolchains,
		continuity,
		clock,
	});
	let running = false;
	const start = () => {
		if (running) return;
		running = true;
		rawQueue.start();
	};
	if (options.autoStart !== false) start();
	const h = {
		dir,
		store,
		conversation,
		continuity,
		dialogue,
		interactions: dialogue.interactions,
		state,
		calls,
		workChanged,
		afterHandoverCalls,
		commandPrompts,
		commandSchemas,
		commandSessions,
		releasedSessions,
		commandCaptures,
		started,
		routed,
		selections,
		settled,
		start,
		status: (runId: string) => dialogue.get(runId)?.status,
		interaction: () =>
			dialogue.interactions.list({ conversationId: "main" })[0],
		rows: (sql: string, ...params: Array<string | number>) =>
			store.read((db) => db.query(sql).all(...params) as any[]),
		/** A direct write to the store, for a change that happens outside the conversation (e.g. the owner's report). */
		write: (sql: string, ...params: Array<string | number>) =>
			store.write((db) => db.query(sql).run(...params)),
		todos: () => store.read((db) => dialogue.todosInTransaction(db, "main")),
		/** Script the conversation model's next call: speech. */
		speak(text: string) {
			state.steps.push({ text });
		},
		/** Script the conversation model to find the command toolchain and delegate the request to it. */
		delegate(request: string, announcement = "担当に引き継ぎます。") {
			state.steps.push(
				{ calls: [{ name: "find_toolchain", args: { query: request } }] },
				{
					calls: [
						{
							name: "delegate",
							args: {
								mode: "execute",
								toolchain: card.id,
								request,
								impact: "create",
								announcement,
							},
						},
					],
				},
			);
		},
		/** Submits an utterance and waits for its run to reach `status`. */
		async say(text: string, status = "completed") {
			const accepted = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			await waitFor(() => dialogue.get(accepted.id)?.status === status).catch(
				() => {
					throw new Error(
						`run_not_${status}: ${JSON.stringify(dialogue.get(accepted.id))}`,
					);
				},
			);
			return dialogue.get(accepted.id)!;
		},
		/**
		 * The command sub-agent asks one question for a delegated request. The waiting TODO carries it and the
		 * conversation agent is told (no generation speaks it). Resolves with the delegating run once it completed.
		 */
		async asked(
			prompt = "何秒ですか",
			schema = "builtin:timerDurationAnswer",
			request = "偽の操作を開始して",
		) {
			state.commands.push({
				action: "clarify",
				question: prompt,
				answerSchema: schema,
			});
			h.delegate(request);
			return h.say(request);
		},
		/** Put a command job on a fresh run directly, without the conversation's delegation (the queue starts here). */
		async commandRun(text = "偽の操作を開始して") {
			if (running) throw new Error("commandRun_needs_autoStart_false");
			const run = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			await store.write((tx) => {
				const { job } = rawQueue.enqueueInTransaction(tx, {
					scope: "dialogue",
					kind: COMMAND_KIND,
					dedupeKey: `test:${run.id}`,
					payload: { runId: run.id, toolchainRevisionId: REVISION },
					subjectRef: run.id,
					lane: "interactive",
					resourceKey: "inference.llm",
					maxAttempts: 1,
					concurrencyKey: "conversation:main",
					deadlineAtMs: Date.parse(run.deadlineAt!),
				});
				dialogue.linkOperationJobInTransaction(tx, run.id, job.id);
			});
			start();
			return run;
		},
		async close() {
			await dialogue.close();
			await rawQueue.close(100).catch(() => {});
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return h;
}
export type Harness = Awaited<ReturnType<typeof setup>>;
/** The answer that fits the question's registered schema. */
export const answerFor = (question: { inputSchemaRef: string }) =>
	question.inputSchemaRef === "builtin:answerText"
		? { text: "はい" }
		: { durationSeconds: 60 };
export const resumedJobs = (h: Harness) =>
	h.rows(
		"SELECT payload_json FROM queue_jobs WHERE kind=? ORDER BY created_seq",
		COMMAND_KIND,
	);
