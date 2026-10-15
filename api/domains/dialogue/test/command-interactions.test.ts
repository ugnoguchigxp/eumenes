import { delegatedTaskRules } from "../../inference";
import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
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
	INTERACTION_POLICY,
	agentLinkMigration,
	commandInteractionsMigration,
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
	questionChoicesMigration,
	registerCommandInteractions,
	worldStateMigration,
	type BoundCommandPort,
	type BoundCommandSet,
	type ToolchainRoutingPort,
} from "..";
import { COMMAND_KIND } from "../service/context";
import { insertInteraction } from "../repository/interactions";

const REVISION = "toolchain:fake.manage@1";
const BINDING = "binding:fake.command@1";
const PACKAGE = "package:fake.manage@1";
const ADAPTER = "adapter:fake@1";
const baseSet: Omit<BoundCommandSet, "questions"> = {
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
const QUESTIONS: BoundCommandSet["questions"] = [
	{ inputSchemaRef: "builtin:timerDurationAnswer" },
	{ inputSchemaRef: "builtin:timerTargetAnswer", choiceField: "timerId" },
];
const card: ToolchainCard = {
	revisionId: REVISION,
	id: "fake.manage",
	functionName: "fake_op",
	title: "偽の操作",
	summary: "偽の操作を行う",
	useWhen: ["偽の操作"],
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};

const operationCall = (args: Record<string, unknown>) => [
	{ id: "call", name: "fake_op", arguments: JSON.stringify(args) },
];
const lastUser = (history: Call["history"]) =>
	[...history].reverse().find((m) => m.role === "user")?.content ?? "";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 4000) {
	for (let i = 0; i < ms / 10; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

test("an earlier mistaken answer does not enter the next toolchain choice", async () => {
	const h = setup({
		conversation: (call, index) => {
			if (!call.tools.length || index === 0) return {};
			return {
				toolCalls: operationCall({ request: lastUser(call.history) }),
			};
		},
	});
	const first = await h.run("操作を実行して");
	await until(() => h.status(first.id) === "completed");
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-history",
		digest: "digest-history",
	};
	await h.run("先ほどの操作を実行して");
	await until(() => h.started.length === 1);
	const selection = h.conversationCalls[2]!;
	expect(selection.tools).toHaveLength(1);
	const reference = selection.history.find((m) =>
		m.content.startsWith("referenceContext"),
	)!;
	expect(
		JSON.parse(reference.content.slice(reference.content.indexOf("=") + 1)),
	).toBe("操作を実行して");
	expect(selection.history.map((m) => m.content)).toContain(
		"先ほどの操作を実行して",
	);
	expect(selection.history.some((m) => m.role === "assistant")).toBe(false);
	expect(h.started).toHaveLength(1);
});

test("a direct answer after toolchain selection retains the full exchange", async () => {
	const h = setup({
		conversation: (call) => (call.tools.length ? {} : undefined),
	});
	const first = await h.run("前の話を覚えておいて");
	await until(() => h.status(first.id) === "completed");
	const second = await h.run("その話の続きは？");
	await until(() => h.status(second.id) === "completed");
	const selection = h.conversationCalls.at(-2)!;
	const answer = h.conversationCalls.at(-1)!;
	expect(selection.tools).toHaveLength(1);
	// The one-shot selection is auxiliary; only the answer generation is the main session.
	expect(selection.session).toEqual({ sessionRole: "auxiliary" });
	// The adopted exchange is the history a resumed session starts from; the system prompt is the one instruction.
	expect(answer.session).toEqual({
		sessionRole: "main",
		context: { instructionCount: 1, historyCount: 2 },
	});
	expect(selection.history.some((m) => m.role === "assistant")).toBe(false);
	expect(answer.tools).toHaveLength(0);
	expect(
		answer.history.some(
			(m) => m.role === "assistant" && m.content === "了解しました",
		),
	).toBe(true);
});

type Command = Record<string, unknown>;
type Call = {
	history: Array<{ role: string; content: string }>;
	tools: Array<{
		function: { name: string; parameters: Record<string, unknown> };
	}>;
	session?: unknown;
};

function setup(
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
			lunaEnabled: false,
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
type Harness = ReturnType<typeof setup>;
/** The answer that fits the question's registered schema. */
const answerFor = (question: { inputSchemaRef: string }) =>
	question.inputSchemaRef === "builtin:answerText"
		? { text: "はい" }
		: { durationSeconds: 60 };
const resumedJobs = (h: Harness) =>
	h.rows(
		"SELECT payload_json FROM queue_jobs WHERE kind=? ORDER BY created_seq",
		COMMAND_KIND,
	);

test("the offer comes from the catalog: bound chains by adapter availability, the rest by host capability", async () => {
	const offered = async (available: boolean) => {
		const h = setup({ available });
		await h.run("偽の操作を開始して");
		await until(() => h.routed.length > 0);
		return [...h.routed[0]!].sort();
	};
	// The research chain needs agents (present); the dots chain needs the delegation port (absent).
	expect(await offered(true)).toEqual(["fake.manage", "research.web"]);
	expect(await offered(false)).toEqual(["research.web"]);
});

test("a command chain without a binding or with an unknown backend is refused before any execution", async () => {
	for (const backend of ["timer", "something-new", undefined]) {
		const h = setup({ bound: false, backend });
		const run = await h.commandRun();
		await until(() => h.status(run.id) === "failed");
		expect(h.dialogue.get(run.id)?.error).toBe("adapter_unavailable");
		expect(h.started).toHaveLength(0);
		expect(h.commandPrompts).toHaveLength(0);
	}
});

test("a bound chain runs through the generic action route with the binding's adapter and operation", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 90 },
	});
	const run = await h.commandRun();
	await until(() => h.started.length === 1);
	const start = h.started[0]!;
	expect(start.input.kind).toBe("action");
	expect(start.input.command).toEqual({
		bindingRevisionId: BINDING,
		adapterRef: ADAPTER,
		packageRevisionId: PACKAGE,
		toolRevisionId: "tool:fake.start@1",
		operationName: "fake.start",
		input: { seconds: 90 },
	});
	expect(start.actionCapability).toEqual({ package: { revisionId: PACKAGE } });
	expect(start.rootRunId).toBe(run.id);
	// The sub-agent was offered the binding's tools and the adapter snapshot, nothing else.
	const prompt = JSON.stringify(h.commandPrompts[0]);
	expect(prompt).toContain("fake.start");
	expect(prompt).toContain("snapshot");
	// No interaction exists for an operation that needed no question.
	expect(h.interaction()).toBeUndefined();
});

test("arguments that the binding's schema rejects never reach the agent runtime", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: "三分" },
	});
	const run = await h.commandRun();
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe(
		"toolchain_command_invalid_arguments",
	);
	expect(h.started).toHaveLength(0);
});

test("a clarifying question is saved atomically and handed to the conversation, then answered once by the UI", async () => {
	const h = setup();
	const first = await h.clarified();
	const interaction = h.interaction()!;
	expect(interaction).toMatchObject({
		status: "waiting_input",
		questionCount: 1,
		revision: 0,
		chainRevisionId: REVISION,
		question: {
			prompt: "何秒ですか",
			inputSchemaRef: "builtin:timerDurationAnswer",
			revision: 0,
		},
	});
	// The question still reaches the user through the conversation's own words.
	expect(JSON.stringify(h.conversationCalls.at(-1)!.history)).toContain(
		"commandQuestion",
	);
	const body = {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: interaction.revision,
		input: { durationSeconds: 180 },
	};
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	const answered = await h.interactions.answer(interaction.id, body);
	expect(answered.replay).toBe(false);
	expect(answered.interaction).toMatchObject({
		status: "ready",
		revision: 1,
		question: null,
	});
	// Exactly one run, its user message and its command job were created together.
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before + 1);
	const text = h.conversation
		.get("main")
		.messages.find(
			(m) => m.runId === answered.runId && m.role === "user",
		)!.text;
	expect(text).toContain("180");
	expect(JSON.parse(resumedJobs(h).at(-1).payload_json)).toMatchObject({
		runId: answered.runId,
		toolchainRevisionId: REVISION,
		interactionId: interaction.id,
	});
	// The same event replays to the same run; another input under it conflicts.
	const replay = await h.interactions.answer(interaction.id, body);
	expect(replay).toMatchObject({ replay: true, runId: answered.runId });
	await expect(
		h.interactions.answer(interaction.id, {
			...body,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("request_conflict");
	// A second answer to the same question is closed.
	await expect(
		h.interactions.answer(interaction.id, {
			...body,
			eventId: crypto.randomUUID(),
		}),
	).rejects.toThrow("interaction_closed");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before + 1);
	expect(first.id).not.toBe(answered.runId);
});

test("the resumed command run gets the question and the answer as data and completes the interaction with the receipt", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-1",
		digest: "digest-1",
	};
	const { runId } = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 180 },
	});
	await until(() => h.interaction()?.status === "completed");
	expect(h.interaction()).toMatchObject({
		status: "completed",
		receiptRef: { owner: "fake", operationId: "op-1", digest: "digest-1" },
	});
	const prompt = JSON.stringify(h.commandPrompts.at(-1));
	expect(prompt).toContain("previousQuestions");
	expect(h.commandPrompts.at(-1)![0]!.content).toContain(delegatedTaskRules);
	expect(h.commandPrompts.at(-1)).toHaveLength(2);
	expect(prompt).toContain("何秒ですか");
	expect(prompt).toContain("durationSeconds");
	// The original request is the first utterance, not the answer's.
	expect(prompt).toContain("偽の操作を開始して");
	expect(h.started.at(-1)!.rootRunId).toBe(runId);
	expect(h.started.at(-1)!.input.command.input).toEqual({ seconds: 180 });
	// The frozen input and the time it was decided are kept.
	const row = h.rows(
		"SELECT input_json, issued_at, request_id FROM command_interactions",
	)[0];
	expect(JSON.parse(row.input_json)).toEqual({ seconds: 180 });
	expect(row.issued_at).toBeString();
	expect(row.request_id).toBeString();
	// The domain operation carries exactly those: the logical request id and decision time.
	expect(h.started.at(-1)!.input.command.stamp).toEqual({
		requestId: row.request_id,
		issuedAt: row.issued_at,
	});
});

test("an operation without an interaction carries no frozen stamp", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 5 },
	});
	await h.commandRun();
	await until(() => h.started.length === 1);
	expect(h.started[0]!.input.command).not.toHaveProperty("stamp");
});

test("a target question carries the host's choices and accepts only one of them", async () => {
	const h = setup();
	h.state.choices["builtin:timerTargetAnswer"] = [
		{ ref: "timer-1", label: "お茶（残り60秒・動作中）" },
		{ ref: "timer-2", label: "麺（残り120秒・一時停止）" },
	];
	await h.clarified("どのタイマーですか", "builtin:timerTargetAnswer");
	const interaction = h.interaction()!;
	expect(interaction.question).toMatchObject({
		inputSchemaRef: "builtin:timerTargetAnswer",
		choices: h.state.choices["builtin:timerTargetAnswer"],
	});
	const body = (timerId: string) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { timerId },
	});
	const runs = h.rows("SELECT id FROM dialogue_runs").length;
	// A well-formed id the host did not issue with this question is not an answer.
	await expect(
		h.interactions.answer(interaction.id, body(crypto.randomUUID())),
	).rejects.toThrow("invalid_answer");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(runs);
	const accepted = await h.interactions.answer(interaction.id, body("timer-2"));
	expect(accepted.replay).toBe(false);
});

test("a binding without questions allows only free text, and the model is offered no other schema", async () => {
	const h = setup({ questions: [] });
	h.state.commands.push({
		action: "clarify",
		question: "何秒ですか",
		answerSchema: "builtin:timerDurationAnswer",
	});
	const refused = await h.commandRun();
	await until(() => h.status(refused.id) === "failed");
	expect(h.dialogue.get(refused.id)?.error).toBe(
		"toolchain_command_invalid_contract",
	);
	expect(h.commandSchemas[0]).not.toContain("timerDurationAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:answerText");
	expect(h.rows("SELECT id FROM command_interactions")).toHaveLength(0);
	// Free text is always allowed.
	h.state.commands.push({
		action: "clarify",
		question: "何秒ですか",
		answerSchema: "builtin:answerText",
	});
	await h.commandRun();
	await until(() => h.interaction()?.status === "waiting_input");
	expect(h.interaction()!.question!.inputSchemaRef).toBe("builtin:answerText");
});

test("the command sub-agent runs as a sub-agent of its run, on LARM unless a sub-agent resource is saved", async () => {
	const h = setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	const first = await h.commandRun();
	await until(() => h.commandSessions.length === 1);
	expect(h.commandCaptures[0]!.route).toBe("larm-only");
	expect(h.commandSessions[0]).toEqual({
		sessionRole: "subagent",
		taskId: first.id,
	});
	// The command is one call: its session is released as the call ends.
	await until(() => h.releasedSessions.includes(first.id));
	const resourceId = crypto.randomUUID();
	h.state.subagentResourceId = resourceId;
	h.state.commands.push({ action: "clarify", question: "どれ" });
	const second = await h.commandRun("別の操作を開始して");
	await until(() => h.commandSessions.length === 2);
	expect(h.commandCaptures[1]!.route).toEqual({ resourceId });
	expect(h.commandSessions[1]).toEqual({
		sessionRole: "subagent",
		taskId: second.id,
	});
});

test("a binding with questions offers exactly those schemas to the model", async () => {
	const h = setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	await h.commandRun();
	await until(() => h.commandPrompts.length === 1);
	expect(h.commandSchemas[0]).toContain("builtin:timerDurationAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:timerTargetAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:answerText");
});

test("the choice field is the binding's: a schema with another field is validated the same way", async () => {
	const h = setup({
		questions: [
			{ inputSchemaRef: "schema:pick-item@1", choiceField: "itemId" },
		],
	});
	h.state.choices["schema:pick-item@1"] = [
		{ ref: "item-a", label: "A" },
		{ ref: "item-b", label: "B" },
	];
	await h.clarified("どの項目ですか", "schema:pick-item@1");
	const interaction = h.interaction()!;
	expect(interaction.question).toMatchObject({
		inputSchemaRef: "schema:pick-item@1",
		choices: h.state.choices["schema:pick-item@1"],
	});
	const body = (itemId: string) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { itemId },
	});
	await expect(
		h.interactions.answer(interaction.id, body("item-z")),
	).rejects.toThrow("invalid_answer");
	expect(
		(await h.interactions.answer(interaction.id, body("item-b"))).replay,
	).toBe(false);
});

test("a schema without a choice field carries no choices even if the host has some", async () => {
	const h = setup();
	h.state.choices["builtin:timerDurationAnswer"] = [{ ref: "x", label: "X" }];
	await h.clarified();
	expect(h.interaction()!.question).toMatchObject({
		inputSchemaRef: "builtin:timerDurationAnswer",
	});
	expect(h.interaction()!.question!.choices).toBeUndefined();
});

test("a target question without host choices is asked as free text", async () => {
	const h = setup();
	await h.clarified("どのタイマーですか", "builtin:timerTargetAnswer");
	const question = h.interaction()!.question!;
	expect(question.inputSchemaRef).toBe("builtin:answerText");
	expect(question.choices).toBeUndefined();
});

test("an answer whose request id already belongs to another run is a conflict, not a link", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const eventId = crypto.randomUUID();
	// A run with this very request id and the answer's own text already exists.
	await h.dialogue.submit({
		requestId: eventId,
		conversationId: "main",
		text: '回答: {"durationSeconds":60}',
	});
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId,
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("request_conflict");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
});

test("a failed operation ends the interaction without a receipt", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 5 },
	});
	h.state.outcome = { state: "failed", errorCode: "revision_conflict" };
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 5 },
	});
	await until(() => h.interaction()?.status === "cancelled");
	expect(h.interaction()!.receiptRef).toBeNull();
	expect(h.rows("SELECT end_code FROM command_interactions")[0].end_code).toBe(
		"revision_conflict",
	);
});

test("answers are refused for a stale question or revision, an invalid value, or a changed version", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const base = {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	};
	const runs = () => h.rows("SELECT id FROM dialogue_runs").length;
	const before = runs();
	await expect(
		h.interactions.answer(interaction.id, {
			...base,
			questionId: crypto.randomUUID(),
		}),
	).rejects.toThrow("question_stale");
	await expect(
		h.interactions.answer(interaction.id, { ...base, expectedRevision: 3 }),
	).rejects.toThrow("revision_conflict");
	await expect(
		h.interactions.answer(interaction.id, {
			...base,
			input: { durationSeconds: 0 },
		}),
	).rejects.toThrow("invalid_answer");
	await expect(
		h.interactions.answer(crypto.randomUUID(), base),
	).rejects.toThrow("interaction_not_found");
	expect(runs()).toBe(before);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
	// The chain was replaced: the frozen refs no longer stand and the operation stops.
	h.state.activeRevision = "toolchain:fake.manage@2";
	await expect(h.interactions.answer(interaction.id, base)).rejects.toThrow(
		"version_invalidated",
	);
	expect(runs()).toBe(before);
	expect(h.interaction()!.status).toBe("cancelled");
});

test("an answer past the question's time is expired, not resumed", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	// A read already shows it expired; no question is offered any more.
	expect(h.interaction()).toMatchObject({ status: "expired", question: null });
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("interaction_expired");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before);
	expect(h.rows("SELECT status FROM command_interactions")[0].status).toBe(
		"expired",
	);
});

test("maintenance expires open questions and ends interactions whose run is gone", async () => {
	const h = setup();
	await h.clarified();
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({ expired: 1 });
	expect(h.rows("SELECT status FROM command_interactions")[0].status).toBe(
		"expired",
	);
});

test("an answer and its new run commit together: a refused job leaves the question open", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const runs = h.rows("SELECT id FROM dialogue_runs").length;
	const messages = h.conversation.get("main").messages.length;
	h.state.queueFull = true;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("queue_full");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(runs);
	expect(h.conversation.get("main").messages).toHaveLength(messages);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
	expect(
		h.rows("SELECT * FROM command_interaction_events WHERE kind='answer'"),
	).toHaveLength(0);
	// Once the queue accepts again, the same answer goes through.
	h.state.queueFull = false;
	const again = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	expect(again.replay).toBe(false);
});

test("at most three questions are asked; the fourth stops the operation", async () => {
	const h = setup();
	await h.clarified("一つ目");
	for (const prompt of ["二つ目", "三つ目"]) {
		const current = h.interaction()!;
		h.state.commands.push({ action: "clarify", question: prompt });
		await h.interactions.answer(current.id, {
			eventId: crypto.randomUUID(),
			questionId: current.question!.questionId,
			expectedRevision: current.revision,
			input: answerFor(current.question!),
		});
		await until(
			() =>
				h.interaction()?.question?.prompt === prompt &&
				h.interaction()?.status === "waiting_input",
		);
	}
	expect(h.interaction()).toMatchObject({
		questionCount: 3,
		status: "waiting_input",
	});
	// The answer to the third question is the fourth clarification's trigger.
	const third = h.interaction()!;
	h.state.commands.push({ action: "clarify", question: "四つ目" });
	const { runId } = await h.interactions.answer(third.id, {
		eventId: crypto.randomUUID(),
		questionId: third.question!.questionId,
		expectedRevision: third.revision,
		input: answerFor(third.question!),
	});
	await until(() => h.status(runId) === "failed");
	expect(h.dialogue.get(runId)?.error).toBe("question_limit_reached");
	expect(h.interaction()).toMatchObject({
		status: "cancelled",
		questionCount: 3,
	});
});

test("cancelling closes the question, refuses a late answer and stops a resumed run still in flight", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const cancelled = await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 0,
	});
	expect(cancelled).toMatchObject({ status: "cancelled", question: null });
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("interaction_closed");
	// Epoch and generation advanced.
	const row = h.rows(
		"SELECT authority_epoch, execution_generation FROM command_interactions",
	)[0];
	expect(row.authority_epoch).toBeGreaterThan(0);
	expect(row.execution_generation).toBeGreaterThan(0);
	// Cancelling again is idempotent.
	expect(
		(
			await h.interactions.cancel(interaction.id, {
				eventId: crypto.randomUUID(),
				expectedRevision: 5,
			})
		).status,
	).toBe("cancelled");
});

test("a model result that arrives after the interaction was cancelled is not adopted", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	const { runId } = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(() => h.commandPrompts.length === 2);
	await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 1,
	});
	release();
	await until(() => h.status(runId) === "cancelled");
	await pause(50);
	expect(h.started).toHaveLength(0);
	expect(h.interaction()!.status).toBe("cancelled");
});

test("a reply in natural language answers an open question through its questionRef, and only that", async () => {
	let ref = "";
	const h = setup({
		conversation: (call) => {
			if (!call.tools.length) return undefined;
			const text = lastUser(call.history);
			if (text === "3分でお願い")
				return {
					toolCalls: operationCall({ request: text, questionRef: ref }),
				};
			if (text === "もう一度") return {};
			return undefined;
		},
	});
	h.state.commands.push({ action: "clarify", question: "何秒ですか" });
	const first = await h.run("偽の操作を開始して");
	await until(() => h.status(first.id) === "completed");
	// With no open question the function takes only `request`.
	expect(
		Object.keys(
			(h.conversationCalls[0]!.tools[0]!.function.parameters as any).properties,
		),
	).toEqual(["request"]);
	const interaction = h.interaction()!;
	ref = interaction.question!.questionId;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-nl",
		digest: "digest-nl",
	};
	const second = await h.run("3分でお願い");
	await until(() => h.interaction()?.status === "completed");
	// The conversation saw the open question as data and could name only its ref.
	const call = h.conversationCalls.find((c) =>
		c.history.some((m) => m.content.includes("openQuestions")),
	)!;
	expect(JSON.stringify(call.history)).toContain(ref);
	expect(
		(call.tools[0]!.function.parameters as any).properties.questionRef.enum,
	).toEqual([ref]);
	// The utterance's own run resumed the interaction; no extra run was made.
	expect(
		h.rows("SELECT current_run_id FROM command_interactions")[0].current_run_id,
	).toBe(second.id);
	expect(JSON.stringify(h.commandPrompts.at(-1))).toContain("3分でお願い");
	expect(h.started.at(-1)!.rootRunId).toBe(second.id);
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(2);
	// Answered once: the question is no longer offered.
	const third = await h.run("もう一度");
	await until(() => h.status(third.id) === "completed");
	expect(
		h.conversationCalls
			.at(-1)!
			.history.some((m) => m.content.includes("openQuestions")),
	).toBe(false);
});

test("a questionRef that is not an open question of the offered function is rejected", async () => {
	const h = setup({
		conversation: (call) =>
			call.tools.length
				? {
						toolCalls: operationCall({
							request: "3分でお願い",
							questionRef: crypto.randomUUID(),
						}),
					}
				: undefined,
	});
	const run = await h.run("3分でお願い");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("invalid_conversation_operation");
	expect(resumedJobs(h)).toHaveLength(0);
});

test("a natural-language answer to a question whose chain has since changed stops with version_invalidated", async () => {
	let ref = "";
	const h = setup({
		conversation: (call) =>
			call.tools.length && lastUser(call.history) === "3分"
				? { toolCalls: operationCall({ request: "3分", questionRef: ref }) }
				: undefined,
	});
	await h.clarified();
	ref = h.interaction()!.question!.questionId;
	// The offer now names a newer revision of the same function.
	h.state.activeRevision = "toolchain:fake.manage@2";
	const run = await h.run("3分");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("version_invalidated");
	expect(h.interaction()!.status).toBe("cancelled");
	expect(h.started).toHaveLength(0);
});

test("interactions are bounded: open and total capacity refuse a new one, and ending keeps the body for 30 days", async () => {
	const h = setup();
	const base = await h.clarified();
	const template = h.rows("SELECT * FROM command_interactions")[0];
	await h.store.write((db) => {
		for (let i = 1; i < INTERACTION_POLICY.maxOpen; i++)
			insertInteraction(db, {
				id: `filler-${i}`,
				conversationId: template.conversation_id,
				originMessageId: template.origin_message_id,
				originRunId: base.id,
				currentRunId: base.id,
				chainRevisionId: REVISION,
				functionName: "fake_op",
				packageRevisionId: PACKAGE,
				bindingRevisionId: BINDING,
				artifactRevisionId: null,
				revision: 0,
				authorityEpoch: 0,
				executionGeneration: 0,
				status: "waiting_input",
				questionId: null,
				questionPrompt: "q",
				questionSchemaRef: "builtin:answerText",
				questionChoicesJson: null,
				questionCount: 1,
				requestText: "r",
				inputJson: null,
				requestId: crypto.randomUUID(),
				issuedAt: null,
				receiptOwner: null,
				receiptOperationId: null,
				receiptDigest: null,
				endCode: null,
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				endedAt: null,
				bodyDeletedAt: null,
			});
	});
	h.state.commands.push({ action: "clarify", question: "もう一件" });
	const run = await h.run("偽の操作を開始して");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("interaction_capacity");
});

test("ended interactions lose their bodies after 30 days and their rows after 30 more", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 0,
	});
	expect(await h.interactions.maintenance()).toMatchObject({
		bodiesDeleted: 0,
		removed: 0,
	});
	h.state.offset = INTERACTION_POLICY.bodyRetentionMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({
		bodiesDeleted: 1,
	});
	const row = h.rows(
		"SELECT request_text, input_json, question_prompt, body_deleted_at FROM command_interactions",
	)[0];
	expect(row).toMatchObject({ request_text: null, question_prompt: null });
	expect(row.body_deleted_at).toBeString();
	expect(
		h
			.rows("SELECT payload_json FROM command_interaction_events")
			.every((e) => e.payload_json === null),
	).toBe(true);
	h.state.offset += INTERACTION_POLICY.tombstoneRetentionMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({ removed: 1 });
	expect(h.rows("SELECT id FROM command_interactions")).toHaveLength(0);
	expect(h.rows("SELECT id FROM command_interaction_events")).toHaveLength(0);
});

test("an interaction whose run ended without finishing it is closed", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	h.state.gate = new Promise<void>(() => {});
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(() => h.commandPrompts.length === 2);
	// The process went away while the sub-agent was thinking.
	await h.store.write((db) =>
		db
			.query(
				"UPDATE dialogue_runs SET status='interrupted' WHERE status='running'",
			)
			.run(),
	);
	expect(await h.interactions.maintenance()).toMatchObject({ orphaned: 1 });
	expect(h.interaction()!.status).toBe("cancelled");
});

test("the HTTP routes answer, list and cancel interactions with the documented statuses", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const app = new Hono();
	registerCommandInteractions(app, h.dialogue);
	const post = (path: string, body: unknown) =>
		app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const answer = (over: Record<string, unknown> = {}) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 90 },
		...over,
	});
	const base = `/api/toolchain-interactions/${interaction.id}`;

	expect((await app.request("/api/toolchain-interactions")).status).toBe(400);
	expect(
		(
			await app.request(
				"/api/toolchain-interactions?conversationId=main&status=nope",
			)
		).status,
	).toBe(400);
	const listed = await app.request(
		"/api/toolchain-interactions?conversationId=main&status=waiting_input",
	);
	expect(listed.status).toBe(200);
	expect(
		((await listed.json()) as Array<{ id: string }>).map((i) => i.id),
	).toEqual([interaction.id]);
	expect((await app.request(base)).status).toBe(200);
	expect(
		(await app.request(`/api/toolchain-interactions/${crypto.randomUUID()}`))
			.status,
	).toBe(404);

	expect((await post(`${base}/answers`, { nonsense: true })).status).toBe(400);
	expect(
		(await post(`${base}/answers`, answer({ input: { durationSeconds: 0 } })))
			.status,
	).toBe(422);
	expect(
		(await post(`${base}/answers`, answer({ expectedRevision: 9 }))).status,
	).toBe(409);
	expect(
		(
			await post(
				`/api/toolchain-interactions/${crypto.randomUUID()}/answers`,
				answer(),
			)
		).status,
	).toBe(404);
	const body = answer();
	const accepted = await post(`${base}/answers`, body);
	expect(accepted.status).toBe(202);
	const result = (await accepted.json()) as {
		runId: string;
		replay: boolean;
		interaction: { status: string };
	};
	expect(result).toMatchObject({
		replay: false,
		interaction: { status: "ready" },
	});
	const replay = await post(`${base}/answers`, body);
	expect(replay.status).toBe(200);
	expect(((await replay.json()) as { runId: string }).runId).toBe(result.runId);
	expect((await post(`${base}/answers`, answer())).status).toBe(409);

	expect((await post(`${base}/cancel`, { eventId: "x" })).status).toBe(400);
	const cancelled = await post(`${base}/cancel`, {
		eventId: crypto.randomUUID(),
		expectedRevision: 1,
	});
	expect(cancelled.status).toBe(200);
	expect(((await cancelled.json()) as { status: string }).status).toBe(
		"cancelled",
	);
});

test("the HTTP answer to an expired question is 410", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const app = new Hono();
	registerCommandInteractions(app, h.dialogue);
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	const response = await app.request(
		`/api/toolchain-interactions/${interaction.id}/answers`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				eventId: crypto.randomUUID(),
				questionId: interaction.question!.questionId,
				expectedRevision: 0,
				input: { durationSeconds: 60 },
			}),
		},
	);
	expect(response.status).toBe(410);
});
