import {
	executionCallSession,
	type ChildExecution,
} from "../../domains/tool-runtime";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { systemContext } from "../../infrastructure/system-context";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type {
	TaskApi,
	TaskStepInput,
	TaskStepOutcome,
	TaskStepRunner,
} from "../../domains/browser";
import {
	validators,
	zSchema,
	type Capabilities,
	type FixedDefinition,
	type SchemaKey,
} from "../../domains/capabilities";
import {
	parseTaskState,
	recordOutput,
	recordToolResult,
	resolveTaskPolicy,
	startTask,
	taskControl,
	taskMessages,
	type AgentTool,
	type InferencePort,
	type TaskState,
} from "../../domains/inference";
import { expireObservations } from "./browser-fold";
import { addSeen, clip, originOf, placeOf } from "./browser-text";
import {
	FATAL_CODES,
	PAGE_TOOLS,
	approvedView,
	argumentHints,
	TOOLCHAIN_ID,
	observationView,
	refusal,
	settleCapture,
	workSchema,
	type ToolEnv,
	type ToolOutcome,
	type Work,
} from "./browser-task-tools";

const log = getLogger("browser");

/** Calls of one task when its binding says nothing (spec §5.4). */
const DEFAULT_MODEL_CALLS = 12;
const OUTPUT_TOKENS = 2048;
/** One model call may take this long; a task past its own deadline is stopped by the domain. */
const CALL_MS = 90_000;
const MIN_CALL_MS = 5_000;

const RULES = systemContext("browser.contexts.page-operator.rules", {});
const REFERENCE_INTRO = systemContext(
	"browser.contexts.page-operator.reference",
	{},
);
const CORRECTION = systemContext(
	"browser.contexts.page-operator.correction",
	{},
);

/** What the adapter stores at start, beside the user's own words (the task's `request`). */
const frozenSchema = z.strictObject({
	/** Host-owned originating-message reference and remaining parent budget. */
	execution: z.unknown().optional(),
	/** The request as the conversation's command step wrote it; shown beside the original, never in its place. */
	brief: z.string().max(4000).optional(),
	packageRevisionId: z.string().optional(),
	caller: z.unknown().optional(),
	modelStepMs: z.number().int().min(5000).max(90000).optional(),
	maxModelCalls: z.number().int().min(1).max(12).optional(),
});

/** The persisted job state: the single-shot core's state and what the host keeps for the tools. */
const persistedSchema = z.strictObject({
	v: z.literal(1),
	core: z.unknown(),
	work: workSchema,
});
type Persisted = { v: 1; core: TaskState; work: Work };

export type TaskRunnerPorts = {
	taskExecutionSourceInTransaction?: (
		db: Database,
		frozen: unknown,
	) => string | null;
	store: SqliteStore;
	/** The model calls of a task: user-authorized single-shot control requests, one per job. */
	inference: Pick<
		InferencePort,
		| "captureUserControlInTransaction"
		| "executeControl"
		| "acceptInTransaction"
		| "cancelRequestsInTransaction"
		| "countControlTokens"
		| "savedLlmContextWindow"
		| "releaseTaskSession"
	>;
	/** The capability registry; assembled after the browser, so it is read when a task starts. */
	capabilities: () => Pick<
		Capabilities,
		| "toolchainsInTransaction"
		| "toolchainSetInTransaction"
		| "prepareActiveByIdInTransaction"
	> | null;
};

type Operator = {
	profile: string;
	skills: string[];
	tools: AgentTool[];
	toolIds: string[];
	/** The schema key each offered tool was registered with. */
	schemaKeys: ReadonlyMap<string, string>;
	turn: Parameters<typeof resolveTaskPolicy>[0];
};

/**
 * What stays of a task that ended: the counts and the refs it cited, not the conversation with the model (which
 * holds the pages it read). A task the domain ended itself (cancel, expiry) keeps its last state until it is purged.
 */
const endedState = (core: TaskState, work: Work, cited?: string[]) => ({
	v: 1,
	ended: true,
	callsMade: core.callsMade,
	refusals: core.refusals,
	captures: work.captures,
	...(cited ? { cited } : {}),
});
const taskFailed = (
	core: TaskState,
	work: Work,
	code: string,
	text = "",
): TaskStepOutcome => ({
	kind: "done",
	state: "failed",
	coreState: endedState(core, work),
	text,
	errorCode: code,
});

/**
 * The operator package's fixed set, from the active acceptance toolchain: the package it runs is the one the
 * acceptance package depends on. The frozen text goes into the task core's first messages, so a later
 * revision never changes a task that is running.
 */
function operatorOf(
	db: Database,
	caps: NonNullable<ReturnType<TaskRunnerPorts["capabilities"]>>,
	input: TaskStepInput,
): Operator {
	const frozen = frozenSchema.parse(input.frozen ?? {});
	const toolchain = caps
		.toolchainsInTransaction(db)
		.find((d: FixedDefinition) => d.id === TOOLCHAIN_ID);
	if (!toolchain) throw new Error("capability_unavailable");
	const set = caps.toolchainSetInTransaction(db, toolchain.revisionId);
	const operators = set.package.dependencies.filter((id: string) =>
		id.startsWith("package:"),
	);
	if (operators.length !== 1) throw new Error("capability_unavailable");
	const owner = {
		rootRunId: input.taskId,
		taskId: input.taskId,
		cancelEpoch: 0,
	};
	const prepared = caps.prepareActiveByIdInTransaction(
		db,
		owner,
		frozen.packageRevisionId ?? operators[0]!,
		{ request: clip(input.request, 8000) },
	);
	const pack = prepared.package;
	const byId = new Map(prepared.dependencies.map((d) => [d.revisionId, d]));
	const profile = byId.get(pack.profileRevisionId ?? "")?.body?.trim();
	const skills = (pack.requiredSkillRevisionIds ?? []).map((id: string) =>
		byId.get(id)?.body?.trim(),
	);
	if (!profile || skills.some((s) => !s))
		throw new Error("required_context_missing");
	const tools = (pack.toolRevisionIds ?? []).map((id: string) => {
		const tool = byId.get(id);
		const host = tool ? PAGE_TOOLS[tool.id] : undefined;
		// The package may only offer tools the host executes, with the schema the host checks.
		if (
			!tool?.schemaKey ||
			!host ||
			(host.schemaKey !== tool.schemaKey &&
				!host.compatible?.includes(tool.schemaKey as SchemaKey))
		)
			throw new Error("capability_unavailable");
		return {
			id: tool.id,
			description: tool.summary,
			inputSchema: zSchema(tool.schemaKey as SchemaKey),
		};
	});
	if (!tools.length) throw new Error("capability_unavailable");
	const binding = set.binding?.document;
	return {
		profile,
		skills: skills as string[],
		tools,
		toolIds: tools.map((t: AgentTool) => t.id),
		schemaKeys: new Map(
			(pack.toolRevisionIds ?? []).flatMap((id: string) => {
				const tool = byId.get(id);
				return tool?.schemaKey ? [[tool.id, tool.schemaKey] as const] : [];
			}),
		),
		turn: binding?.execution === "command" ? binding.agent?.turn : undefined,
	};
}

export function createTaskRunner(ports: TaskRunnerPorts): TaskStepRunner {
	const { store, inference } = ports;

	const infer = taskInference(ports);

	/** The total must fit the saved model's window before a call is made (spec §5.5). */
	function fits(messages: ReturnType<typeof taskMessages>) {
		const used = inference.countControlTokens?.(messages) ?? null;
		const window = inference.savedLlmContextWindow?.() ?? null;
		return used === null || window === null || used + OUTPUT_TOKENS <= window;
	}

	/** The task's first job: its operator, the target tab and its observation, and the core's first state. */
	async function begin(input: TaskStepInput, api: TaskApi): Promise<Persisted> {
		const caps = ports.capabilities();
		if (!caps) throw new Error("capability_unavailable");
		const frozen = frozenSchema.parse(input.frozen ?? {});
		const source = frozen.execution
			? store.read((db) => ports.taskExecutionSourceInTransaction?.(db, frozen))
			: input.request;
		if (!source) throw new Error("execution_source_invalid");
		const operator = store.read((db) => operatorOf(db, caps, input));
		if (frozen.caller && !api.connection().availability.available)
			await api.connect();
		const tabs = (await api.tabs()).filter((t) => t.status !== "closed");
		// A tab the request named is that tab or none: the task never moves to another one.
		const target = input.tabRef
			? tabs.find((t) => t.tabRef === input.tabRef)
			: (tabs.find((t) => t.active) ?? tabs[0]);
		if (!target && (input.tabRef || (!input.scriptRequired && !frozen.caller)))
			throw new Error("tab_lost");
		const safeTarget = target?.status === "blocked" ? undefined : target;
		const observation = safeTarget
			? await api.observe(safeTarget.tabRef)
			: null;
		const approved = api.approvals();
		const history = api.histories();
		// With no issued input reference, the only available input source is a request quotation.
		// Present that existing contract with its required pair, rather than two optional sources.
		const tools = approved.some((item) => item.kind === "input_value")
			? operator.tools
			: operator.tools.map((tool) =>
					tool.id === "browser.page.type"
						? {
								...tool,
								inputSchema: zSchema(
									operator.schemaKeys.get(tool.id) === "browserPageTypeValue"
										? "browserPageType"
										: "browserPageType2",
								),
							}
						: tool,
				);
		const work: Work = {
			tabRef: safeTarget?.tabRef ?? null,
			origin: observation ? originOf(observation.url) : null,
			tools: operator.toolIds,
			seen: addSeen(
				[],
				...tabs.map((t) => t.title),
				observation ? `${observation.title}\n${observation.text}` : "",
			),
			evidence: observation ? [observation.observationRef] : [],
			captures: [],
		};
		const core = startTask({
			control: taskControl({
				profile: operator.profile,
				skills: operator.skills,
				rules: RULES,
				tools,
			}),
			request: source,
			...(frozen.brief ? { brief: frozen.brief } : {}),
			reference: {
				...(input.url ? { requestedUrl: input.url } : {}),
				connection: api.connection(),
				scriptRequired: !!input.scriptRequired,
				target:
					safeTarget && observation
						? {
								tabRef: safeTarget.tabRef,
								title: clip(observation.title, 100),
								place: placeOf(observation.url),
							}
						: null,
				tabs: tabs.slice(0, 20).map((t) => ({
					tabRef: t.tabRef,
					title: clip(t.title, 100),
					place: placeOf(t.url),
					active: t.active,
					status: t.status,
				})),
				observation: observation ? observationView(observation) : null,
				...(approved.length ? { approved: approvedView(approved) } : {}),
				...(history.length ? { history } : {}),
			},
			referenceIntro: REFERENCE_INTRO,
			correction: CORRECTION,
			policy: resolveTaskPolicy(
				frozen.maxModelCalls
					? { ...operator.turn, maxModelCalls: frozen.maxModelCalls }
					: operator.turn,
				DEFAULT_MODEL_CALLS,
			),
			nowMs: Date.now(),
		});
		return { v: 1, core, work };
	}

	function restore(coreState: unknown): Persisted {
		const parsed = persistedSchema.safeParse(coreState);
		const core = parsed.success ? parseTaskState(parsed.data.core) : null;
		if (!parsed.success || !core) throw new Error("task_state_invalid");
		return { ...parsed.data, v: 1, core };
	}

	/** Waits for the captures this task started, so a result never names an image that is not saved yet. */
	async function settleCaptures(env: ToolEnv) {
		for (const id of env.work.captures) await settleCapture(env, id);
	}

	/** Runs one invoked tool; a refusal of the host or the browser goes back to the model as data. */
	async function runTool(
		tool: string,
		args: Record<string, unknown>,
		env: ToolEnv,
	): Promise<ToolOutcome> {
		const host = env.work.tools.includes(tool) ? PAGE_TOOLS[tool] : undefined;
		if (!host) return { kind: "result", result: refusal("unknown_tool") };
		const parsed = validators[host.schemaKey].safeParse(args);
		if (!parsed.success) {
			const detail = argumentHints(parsed.error.issues);
			// Diagnose the supplied source branch without changing the authoritative validation above.
			const paired =
				host.schemaKey === "browserPageTypeValue2" &&
				!Object.hasOwn(args, "inputValueRef")
					? validators.browserPageType2.safeParse(args)
					: null;
			const issues =
				paired && !paired.success ? paired.error.issues : parsed.error.issues;
			return {
				kind: "result",
				result: refusal("invalid_arguments", {
					...(detail ? { detail } : {}),
					issues: issues.slice(0, 8).map((issue) => ({
						path: issue.path.map(String).join("."),
						code: issue.code,
					})),
				}),
			};
		}
		try {
			return await host.run(parsed.data as never, env);
		} catch (e) {
			const code =
				e instanceof Error && /^[a-z][a-z0-9_]*$/.test(e.message)
					? e.message
					: "operation_failed";
			if (FATAL_CODES.has(code) || env.signal.aborted) throw e;
			return { kind: "result", result: refusal(code) };
		}
	}

	const cont = (p: Persisted, core: TaskState): TaskStepOutcome => ({
		kind: "continue",
		coreState: { v: 1, core, work: p.work } satisfies Persisted,
	});

	async function advance(
		input: TaskStepInput,
		p: Persisted,
		env: ToolEnv,
	): Promise<TaskStepOutcome> {
		const { signal } = env;
		signal.throwIfAborted();
		const messages = taskMessages(p.core);
		if (!fits(messages))
			return taskFailed(p.core, p.work, "observation_budget_exceeded");
		await env.api.progress("thinking");
		signal.throwIfAborted();
		const raw = await infer(input, messages, signal);
		signal.throwIfAborted();
		const { state: core, step } = recordOutput(p.core, raw);
		log.info("browser.task_step", {
			taskId: input.taskId,
			attempt: input.step,
			controlAction: step.kind,
			...(step.kind === "invoke" ? { kind: step.tool } : {}),
		});
		switch (step.kind) {
			case "repair":
				return cont(p, core);
			case "failed":
				return taskFailed(core, p.work, step.code);
			case "clarify":
				return {
					kind: "done",
					state: "needs_input",
					coreState: endedState(core, p.work),
					text: step.text,
				};
			case "finish": {
				await settleCaptures(env);
				const cited = step.refs.filter((ref) => p.work.evidence.includes(ref));
				return {
					kind: "done",
					state: "completed",
					coreState: endedState(core, p.work, cited),
					text: step.text,
				};
			}
			case "invoke": {
				const out = await runTool(step.tool, step.arguments, env);
				signal.throwIfAborted();
				if (out.kind === "stop") {
					log.info("browser.task_stopped", {
						taskId: input.taskId,
						reason: out.code,
						kind: step.tool,
					});
					return {
						kind: "done",
						state: "needs_input",
						coreState: endedState(core, p.work),
						text: out.text,
						...(out.approvals ? { approvals: out.approvals } : {}),
					};
				}
				// Refs of the pages read so far are void once a newer observation arrives.
				const recorded = recordToolResult(
					out.result.ok && "observation" in out.result
						? expireObservations(core)
						: core,
					step.tool,
					out.result,
				);
				if (recorded.step.kind === "failed") {
					// A sent operation that may have reached the page already ended the task as indeterminate.
					const sent = !out.result.ok && out.result.retryable === false;
					return taskFailed(
						recorded.state,
						p.work,
						sent ? "operation_indeterminate" : recorded.step.code,
						!out.result.ok
							? `ブラウザ操作を続けられません（${out.result.error}）。`
							: "",
					);
				}
				return cont(p, recorded.state);
			}
		}
	}

	return async (input, { signal, api }) => {
		let finished = true;
		try {
			const p =
				input.coreState == null
					? await begin(input, api)
					: restore(input.coreState);
			const outcome = await advance(input, p, {
				api,
				signal,
				work: p.work,
				request: input.request,
			});
			finished = outcome.kind === "done";
			return outcome;
		} finally {
			// The agent session of a task that ended or broke off is dropped; a continuing task keeps its own.
			if (finished)
				inference.releaseTaskSession?.(input.taskId).catch(() => undefined);
		}
	};
}

function taskInference(ports: TaskRunnerPorts) {
	const { store, inference } = ports;
	async function infer(
		input: TaskStepInput,
		messages: ReturnType<typeof taskMessages>,
		signal: AbortSignal,
	) {
		if (!inference.captureUserControlInTransaction || !inference.executeControl)
			throw new Error("control_unavailable");
		const deadline = Math.min(
			Date.now() +
				(frozenSchema.parse(input.frozen ?? {}).modelStepMs ?? CALL_MS),
			input.deadline,
		);
		if (deadline < Date.now() + MIN_CALL_MS) throw new Error("task_expired");
		const requestId = await store.write((db) =>
			inference.captureUserControlInTransaction!(db, {
				subject: `browser-task:${input.taskId}-${input.step}`,
				deadline,
				maxOutputTokens: OUTPUT_TOKENS,
				...(frozenSchema.parse(input.frozen ?? {}).execution
					? { route: "subagent" as const }
					: {}),
			}),
		);
		const discard = () =>
			store
				.write((db) => inference.cancelRequestsInTransaction?.(db, [requestId]))
				.catch(() => undefined);
		let receipt: Awaited<
			ReturnType<NonNullable<typeof inference.executeControl>>
		>;
		try {
			receipt = await inference.executeControl(
				requestId,
				messages,
				signal,
				undefined,
				frozenSchema.parse(input.frozen ?? {}).execution
					? {
							...executionCallSession(
								frozenSchema.parse(input.frozen ?? {})
									.execution as ChildExecution,
							),
							taskId: input.taskId,
						}
					: { sessionRole: "subagent", taskId: input.taskId },
			);
		} catch (e) {
			await discard();
			throw e;
		}
		const accepted = await store.write(
			(db) => inference.acceptInTransaction?.(db, receipt) ?? false,
		);
		if (!accepted) {
			await discard();
			throw new Error("permission_revoked");
		}
		if (typeof receipt.value !== "string")
			throw new Error("invalid_inference_result");
		return receipt.value;
	}

	return infer;
}
