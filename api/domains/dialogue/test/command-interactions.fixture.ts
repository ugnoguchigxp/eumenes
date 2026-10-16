import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import type { ToolchainCard } from "../../capabilities";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { InferencePort, Receipt } from "../../inference";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	agentLinkMigration,
	commandInteractionsMigration,
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
	questionChoicesMigration,
	worldStateMigration,
	type BoundCommandPort,
	type BoundCommandSet,
	type ToolchainRoutingPort,
} from "..";
import { COMMAND_KIND } from "../service/context";
import { waitFor } from "../../../infrastructure/wait-for";
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
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};
export const operationCall = (args: Record<string, unknown>) => [
	{ id: "call", name: "fake_op", arguments: JSON.stringify(args) },
];
export const lastUser = (history: Call["history"]) =>
	[...history].reverse().find((m) => m.role === "user")?.content ?? "";
export const until = (check: () => boolean, ms = 4000) =>
	waitFor(check, { timeout: ms });
export const open: Array<() => Promise<void>> = [];
export type Command = Record<string, unknown>;
export type Call = {
	history: Array<{ role: string; content: string }>;
	tools: Array<{
		function: { name: string; parameters: Record<string, unknown> };
	}>;
	session?: unknown;
};
export function setup(
	options: {
		/** The conversation model's i-th call; undefined falls back to calling the function. */
		conversation?: (
			call: Call,
			index: number,
		) => { toolCalls?: unknown[] } | undefined;
		backend?: string;
		bound?: boolean;
		available?: boolean;
		/** The binding's allowed question schemas (default: QUESTIONS). */
		questions?: BoundCommandSet["questions"];
	} = {},
) {
	const set: BoundCommandSet = {
		...baseSet,
		questions: options.questions ?? QUESTIONS,
	};
	const dir = mkdtempSync(join(tmpdir(), "eumenes-interactions-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		avatarMotionMigration,
		answerDeliveryMigration,
		dialogueMigration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
		commandInteractionsMigration,
		questionChoicesMigration,
	]);
	const conversation = createConversationService(store);
	const state = {
		activeRevision: REVISION,
		offset: 0,
		queueFull: false,
		outcome: null as unknown,
		gate: null as Promise<void> | null,
		// Host-issued choices per question schema ref.
		choices: {} as Record<string, Array<{ ref: string; label: string }>>,
		// The command sub-agent's replies, consumed in order.
		commands: [] as Command[],
		// The saved sub-agent resource (settings.subagent.resourceId).
		subagentResourceId: null as string | null,
	};
	const conversationCalls: Call[] = [];
	const commandSchemas: string[] = [];
	const commandSessions: unknown[] = [];
	const releasedSessions: string[] = [];
	const commandCaptures: Array<Record<string, unknown>> = [];
	const commandPrompts: Array<Array<{ role: string; content: string }>> = [];
	const started: Array<Record<string, any>> = [];
	const routed: string[][] = [];
	const settled: Array<{ outcome: string; code?: string | null }> = [];
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		captureInTransaction: () => {},
		requestFor: () => "request",
		setContextPolicyInTransaction: () => {},
		validateReceiptInTransaction: () => true,
		acceptInTransaction: () => true,
		releaseTaskSession: async (taskId: string) => {
			releasedSessions.push(taskId);
		},
		snapshotInTransaction: () => ({
			subagent: { resourceId: state.subagentResourceId },
		}),
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
			if (prompt[0]?.content.includes("OUTPUT_SCHEMA="))
				return {
					requestId,
					attemptId: "route",
					value: JSON.stringify({
						decision: "answer",
						functionName: "",
						request: "",
						questionRef: "",
					}),
				} as Receipt;
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
		executeRequest: async () => {
			throw new Error("unexpected_request");
		},
		executeStream: async (
			requestId: string,
			history: Call["history"],
			_signal: AbortSignal,
			delta: (text: string) => void,
			_p: unknown,
			tools: Call["tools"] | undefined,
			session?: unknown,
		) => {
			const call = { history, tools: tools ?? [], session };
			const index = conversationCalls.push(call) - 1;
			// By default the conversation hands the utterance to the offered function.
			const result =
				options.conversation?.(call, index) ??
				(call.tools.length
					? { toolCalls: operationCall({ request: lastUser(call.history) }) }
					: undefined);
			if (result?.toolCalls)
				return {
					requestId,
					attemptId: String(index),
					value: "",
					toolCalls: result.toolCalls,
				} as unknown as Receipt;
			delta("了解しました");
			return {
				requestId,
				attemptId: String(index),
				value: "了解しました",
			} as Receipt;
		},
		answer: async () => "了解しました",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as InferencePort;
	const agents = {
		conversationContextInTransaction: () => ({
			codexEnabled: false,
			requirementCatalog: [],
		}),
		startInTransaction: (_db: unknown, input: Record<string, any>) => {
			started.push(input);
			return {
				taskId: `task-${started.length}`,
				jobId: input.parentJobId as string,
			};
		},
		actionOutcomeInTransaction: () => state.outcome,
		pendingEvents: () => [],
		byRootInTransaction: () => null,
		failAnswerInTransaction: () => {},
	} as unknown as AgentRuntime;
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
	const runtime = (backend?: string) => ({
		execution: "command" as const,
		...(options.bound === false
			? { requires: backend as never }
			: {
					binding: {
						bindingRevisionId: BINDING,
						adapterRef: ADAPTER,
						artifactRevisionId: set.artifactRevisionId,
						available: options.available ?? true,
					},
				}),
	});
	const toolchains: ToolchainRoutingPort = {
		embedQuery: async () => undefined,
		routeInTransaction: (_db, input) => {
			routed.push([...input.available]);
			return {
				cards: [{ ...card, revisionId: state.activeRevision }],
				past: [],
				retrieval: "none",
			};
		},
		catalogInTransaction: () => [
			{
				id: "fake.manage",
				revisionId: state.activeRevision,
				runtime: runtime(),
			},
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
		resolveInTransaction: (_db, revisionId) => {
			if (revisionId !== state.activeRevision)
				throw new Error("toolchain_unavailable");
			return {
				toolchain: { functionName: "fake_op" } as never,
				packageRevisionId: PACKAGE,
				runtime: runtime(options.backend),
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
		recordSelectionInTransaction: () => "selection",
		linkTaskInTransaction: () => {},
		settleSelectionInTransaction: (_db, _runId, result) => {
			settled.push(result);
		},
		requestOfRunInTransaction: () => "偽の操作を開始する",
	};
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
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents,
		toolchains,
		clock: () => new Date(Date.now() + state.offset).toISOString(),
	});
	rawQueue.start();
	open.push(async () => {
		await dialogue.close();
		await rawQueue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	const h = {
		store,
		conversation,
		queue: rawQueue,
		dialogue,
		interactions: dialogue.interactions,
		state,
		conversationCalls,
		commandPrompts,
		commandSchemas,
		commandSessions,
		releasedSessions,
		commandCaptures,
		started,
		routed,
		settled,
		run: (text: string) =>
			dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			}),
		/** Put a command job on a fresh run directly, without the conversation decision. */
		async commandRun(text = "偽の操作を開始して") {
			const run = await h.run(text);
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
			return run;
		},
		status: (runId: string) => dialogue.get(runId)?.status,
		interaction: () =>
			dialogue.interactions.list({ conversationId: "main" })[0],
		rows: (sql: string, ...params: Array<string | number>) =>
			store.read((db) => db.query(sql).all(...params) as any[]),
		async clarified(
			prompt = "何秒ですか",
			schema = "builtin:timerDurationAnswer",
		) {
			state.commands.push({
				action: "clarify",
				question: prompt,
				answerSchema: schema,
			});
			const run = await h.run("偽の操作を開始して");
			await until(() => h.status(run.id) === "completed");
			return run;
		},
	};
	return h;
}
export type Harness = ReturnType<typeof setup>;
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
