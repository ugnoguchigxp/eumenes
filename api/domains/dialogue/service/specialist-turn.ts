import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import {
	agentSystemMessage,
	toolResultMessage,
	type ControlContract,
	type Receipt,
} from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { Run, SpecialistSet } from "../contracts";
import {
	byId,
	insertSessionEvent,
	sessionById,
	transition,
} from "../repository";
import { SPECIALIST_KIND, type ChatMessage } from "./context";
import type { DialogueDeps, SpecialistTurnPayload } from "./context";
import { endRun } from "./run-end";
import { traceFailure } from "./selection-outcome";
import {
	TURN_BUDGET_MS,
	flushDeferred,
	safeCode,
	turnRefusal,
} from "./specialist-core";
import {
	correctionMessage,
	parseSpecialistAction,
	specialistControl,
	specialistViolations,
	type SpecialistAction,
} from "./specialist-prompt";
import { viewedSpecialistTarget } from "./specialist-context";
import { sessionCourse, specialistTurnMessages } from "./specialist-memory";
import {
	agentPolicy,
	type AgentPolicy,
	documentTools,
	documentView,
	isDocTool,
	runDocTool,
} from "./specialist-agent";
import { settleSpecialistTurn } from "./specialist-settle";

const log = getLogger("dialogue");

const MAX_OUTPUT_TOKENS = 24_576;
/** The longest repair hint of a refused operation that reaches the specialist. */
const DETAIL_CHARS = 1000;
/** A refusal that a retry does not fix: the request named nothing to change (spec §7.5). */
const NO_CHANGE_REPLY = "変更点が分かりませんでした。どこを変えますか。";
/** Refusals beyond the tool's retries end the turn (spec §6.5); a kept whole draft can be read in the source. */
const REFUSED_REPLY = "反映できませんでした。";
const KEPT_REPLY = "反映できませんでした。作った案はソースで確認できます。";
/** The domain's fixer dropped parts it could not show (spec §12 S2); a dropped key or option is no part. */
const DROPPED_NOTE = "表示できない部分は省きました。";
const DROPPED_PART = /^drop_(part|parts|form|model)(:|$)/;
/** The work changed but the specialist gave no valid reply: the host says so (spec §6.5, D10). */
const updatedReply = (label: string) =>
	`${label.length > 40 ? `${label.slice(0, 40)}…` : label}を更新しました。`;

/** What the specialist prepared for the host to apply at settlement. */
export type TurnOutput = {
	/** Every control receipt of the turn; each is accepted (or the turn is not adopted). */
	receipts: Receipt[];
	action: Exclude<SpecialistAction, { kind: "invoke" }>;
};
export type TurnInput = {
	runId: string;
	revision: number;
	sessionId: string;
	epoch: number;
	adapterRef: string;
	workRef: string;
	conversationId: string;
	set: SpecialistSet;
	control: ControlContract;
	messages: ChatMessage[];
	/** Epoch ms the model calls and operations of this turn must finish by. */
	deadline: number;
	/** The turn's time from its start: the shortest of its turn time, the run's and the session's remaining time. */
	limitMs: number;
};

/** The session changed under the turn (cancelled, returned, re-addressed, expired): nothing more is done. */
class StaleTurn extends Error {
	constructor(code: string) {
		super(code);
	}
}

function failRun(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	code: string,
): { status: "stale"; reason: string } {
	endRun(deps, tx, run, "failed", code);
	traceFailure(deps, tx, run.id, "failed", code);
	return { status: "stale", reason: code };
}

/**
 * The session's work document for this turn, read as its canonical text: whole, or an outline (then the agent
 * gets doc.view to read lines). Null when the binding names none or it cannot be read.
 */
function turnDocument(
	port: NonNullable<DialogueDeps["specialist"]>,
	set: SpecialistSet,
	workRef: string,
	policy: AgentPolicy,
	tx: Database,
) {
	const declared = set.agent.document;
	const document = declared
		? port.documentOf(set.adapterRef)?.readInTransaction(tx, workRef)
		: null;
	if (!declared || !document) return null;
	return {
		path: declared.path,
		revision: document.revision,
		title: document.title,
		...documentView(document.text, policy.inlineBytes),
		rejected: document.rejected,
		inlineBytes: policy.inlineBytes,
	};
}

/** The specialist turn: the user's utterance goes to the toolchain's specialist, never to the main model. */
export function createSpecialistTurnHandler(
	deps: DialogueDeps,
): HandlerDefinition<SpecialistTurnPayload, TurnInput, TurnOutput> {
	const { larm, store, clock } = deps;
	return {
		kind: SPECIALIST_KIND,
		payloadVersions: [1],
		schema: z.object({
			runId: z.string(),
			epoch: z.number().int(),
			request: z.string().max(8000).optional(),
		}),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(tx, claim) {
			const run = byId(tx, claim.payload.runId);
			if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
				return { status: "stale", reason: "run_not_queued" };
			const port = deps.specialist;
			if (!port || !larm.captureControlInTransaction || !larm.executeControl)
				return failRun(deps, tx, run, "control_unavailable");
			const session = run.specialistSessionId
				? sessionById(tx, run.specialistSessionId)
				: null;
			const refusal = turnRefusal(
				session,
				run.id,
				claim.payload.epoch,
				clock(),
			);
			if (refusal || !session) return failRun(deps, tx, run, refusal ?? "x");
			let set: SpecialistSet;
			try {
				set = port.setInTransaction(tx, session.toolchainRevisionId);
			} catch {
				return failRun(deps, tx, run, "toolchain_unavailable");
			}
			if (
				set.bindingRevisionId !== session.bindingRevisionId ||
				set.adapterRef !== session.adapterRef
			)
				return failRun(deps, tx, run, "version_invalidated");
			const work = port.workStateInTransaction(
				tx,
				session.adapterRef,
				session.workRef,
			);
			if (!work) return failRun(deps, tx, run, "work_missing");
			const input = deps.conversation.messageInTransaction(
				tx,
				run.inputMessageId,
			);
			if (!input) return failRun(deps, tx, run, "run_input_missing");
			const remaining = Math.min(
				set.timeLimits?.turnMs ?? TURN_BUDGET_MS,
				Date.parse(run.deadlineAt!) - Date.parse(clock()),
				Date.parse(session.expiresAt) - Date.parse(clock()),
			);
			// Too little time left for one model call and the answer: end with a clear code.
			if (remaining <= 5000) {
				log.warn("dialogue.specialist_turn_timeout", {
					runId: run.id,
					toolchainId: set.toolchainId,
					reason: "deadline_exceeded",
					limitMs: Math.max(0, remaining),
				});
				return failRun(deps, tx, run, "deadline_exceeded");
			}
			if (!transition(tx, run.id, run.revision, "running", clock()))
				return { status: "stale", reason: "run_changed" };
			const policy = agentPolicy(set);
			const document = turnDocument(port, set, session.workRef, policy, tx);
			const control = specialistControl(
				set,
				documentTools(set, document?.outlined ?? false),
			);
			return {
				status: "ready",
				input: {
					runId: run.id,
					revision: (byId(tx, run.id) as Run).revision,
					sessionId: session.id,
					epoch: session.epoch,
					adapterRef: session.adapterRef,
					workRef: session.workRef,
					conversationId: run.conversationId,
					set,
					control,
					messages: specialistTurnMessages({
						system: agentSystemMessage(control),
						utterance: input.message.text,
						course: sessionCourse(deps, tx, session, run, policy),
						work: {
							label: work.label,
							dirty: work.dirty,
							current: work.current,
							...(work.context !== undefined ? { context: work.context } : {}),
							savedRef: work.savedRef,
						},
						viewing: viewedSpecialistTarget(deps, tx, run),
						nowMs: Date.parse(clock()),
						callsLeft: policy.maxModelCalls,
						...(document ? { document } : {}),
					}),
					deadline: Date.now() + remaining,
					limitMs: remaining,
				},
			};
		},
		async execute(input, { signal: caller }) {
			const timeout = AbortSignal.timeout(
				Math.max(1, input.deadline - Date.now()),
			);
			const signal = AbortSignal.any([caller, timeout]);
			return withLogContext({ runId: input.runId }, async () => {
				try {
					return await runTurn(deps, input, signal);
				} catch (error) {
					if (timeout.aborted && !caller.aborted) {
						log.warn("dialogue.specialist_turn_timeout", {
							runId: input.runId,
							toolchainId: input.set.toolchainId,
							limitMs: input.limitMs,
						});
						throw new Error("specialist_turn_timeout");
					}
					throw error;
				}
			});
		},
		classify: () => "fail",
		afterCommit: () => flushDeferred(deps),
		settleInTransaction: (tx, claim, input, outcome) =>
			settleSpecialistTurn(deps, tx, claim, input, outcome),
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running")) {
				endRun(deps, tx, run, "cancelled", "cancel_requested");
				traceFailure(deps, tx, run.id, "cancelled", "cancel_requested");
			}
		},
	};

	/** The turn's model calls, with the operations the specialist invokes in between. */
	async function runTurn(
		deps: DialogueDeps,
		input: TurnInput,
		signal: AbortSignal,
	): Promise<TurnOutput> {
		const messages = [...input.messages];
		const receipts: Receipt[] = [];
		const policy = agentPolicy(input.set);
		const max = policy.maxModelCalls;
		/** The current output was rejected once; a valid action resets it (one repair per output, D3). */
		let repaired = false;
		/** An operation of this turn succeeded: the turn is not lost when its reply is. */
		let applied = false;
		/** Refusals per tool in this turn, against the tool's retries (spec §7.4). */
		const refusals = new Map<string, number>();
		const updated = (): TurnOutput => {
			const work = deps.store.read((tx) =>
				deps.specialist!.workStateInTransaction(
					tx,
					input.adapterRef,
					input.workRef,
				),
			);
			return {
				receipts,
				action: {
					kind: "reply",
					text: updatedReply(work?.label ?? input.set.title),
				},
			};
		};
		const hostReply = (text: string): TurnOutput => ({
			receipts,
			action: { kind: "reply", text },
		});
		/** The session still addresses this turn; checked in the same transaction as each capture/operation. */
		const stillMine = (tx: Database) => {
			const run = byId(tx, input.runId);
			const refusal =
				run?.status === "running"
					? turnRefusal(
							sessionById(tx, input.sessionId),
							input.runId,
							input.epoch,
							deps.clock(),
						)
					: "specialist_session_changed";
			if (refusal) throw new StaleTurn(refusal);
		};
		for (let call = 1; call <= max; call++) {
			signal.throwIfAborted();
			const requestId = await store.write((tx) => {
				stillMine(tx);
				return larm.captureControlInTransaction!(tx, {
					subject: `specialist:${input.runId}:${call}`,
					policySubject: input.runId,
					deadline: input.deadline,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					...(input.set.timeLimits
						? { attemptMs: input.set.timeLimits.inferenceMs }
						: {}),
				});
			});
			// The provider session lives as long as the specialist session; it is released when that ends.
			const receipt = await larm.executeControl!(
				requestId,
				messages,
				signal,
				input.control,
				{ sessionRole: "subagent", taskId: input.sessionId },
			);
			receipts.push(receipt);
			const raw = String(receipt.value);
			let value: unknown;
			let action: SpecialistAction | null = null;
			try {
				value = parseLlmJson(raw);
				action = parseSpecialistAction(value);
			} catch {
				action = null;
			}
			if (!action) {
				log.warn("dialogue.specialist_output_rejected", {
					reason: "invalid_contract",
					repairAttempt: repaired ? 1 : 0,
				});
				if (repaired || call === max) {
					if (applied) return updated();
					throw new Error(
						repaired ? "specialist_invalid_contract" : "specialist_turn_limit",
					);
				}
				repaired = true;
				messages.push(
					correctionMessage(raw, specialistViolations(value), max - call),
				);
				continue;
			}
			repaired = false;
			if (action.kind !== "invoke") return { receipts, action };
			// The last call cannot read a tool's result: an operation then must carry its reply (D11).
			if (call === max && !action.text) {
				if (applied) return updated();
				throw new Error("specialist_turn_limit");
			}
			const result = await invoke(
				deps,
				input,
				action,
				stillMine,
				receipts,
				signal,
			);
			if (result.ok) {
				// Reading the document changes nothing: only an operation that may change the work counts.
				if (action.tool !== "doc.view") applied = true;
				// The reply the operation carried ends the turn without another call (spec §6.3).
				if (action.text)
					return hostReply(
						result.dropped ? `${action.text}${DROPPED_NOTE}` : action.text,
					);
			} else {
				if (result.error === "no_change")
					return applied ? updated() : hostReply(NO_CHANGE_REPLY);
				const count = (refusals.get(action.tool) ?? 0) + 1;
				refusals.set(action.tool, count);
				// Beyond the tool's retries, or with no call left to retry in, the host ends the turn.
				if (count > policy.retriesOf(action.tool) || call === max) {
					if (applied) return updated();
					return hostReply(result.kept ? KEPT_REPLY : REFUSED_REPLY);
				}
			}
			messages.push({ role: "assistant", content: raw });
			messages.push(toolResultMessage({ ...result, callsLeft: max - call }));
		}
		if (applied) return updated();
		// The specialist neither answered nor handed back within its calls.
		throw new Error("specialist_turn_limit");
	}
}

/** What the next call reads of an operation, and what the turn decides by. */
type InvokeResult =
	| { ok: true; result: unknown; dropped?: boolean }
	| {
			ok: false;
			error: string;
			detail?: string | string[];
			/** A whole-document write failed its check and was kept as the rejected draft. */
			kept?: boolean;
			[key: string]: unknown;
	  };

/** One operation of the set, run in its own writer transaction; a refusal is data for the next call. */
async function invoke(
	deps: DialogueDeps,
	input: TurnInput,
	action: Extract<SpecialistAction, { kind: "invoke" }>,
	stillMine: (tx: Database) => void,
	receipts: Receipt[],
	signal: AbortSignal,
): Promise<InvokeResult> {
	const port = deps.specialist!;
	const record = (
		tx: Database,
		outcome: { ok: boolean; error?: string; revision?: number },
	) =>
		insertSessionEvent(
			tx,
			input.sessionId,
			{
				kind: "tool",
				runId: input.runId,
				tool: action.tool,
				...outcome,
				...sizeOf(action.arguments),
			},
			deps.clock(),
		);
	/**
	 * A refusal is recorded on its own (the operation's transaction rolled back), only while the session still
	 * addresses this turn: a cancelled or ended turn leaves no late record.
	 */
	const refused = (error: string) =>
		deps.store.write((tx) => {
			try {
				stillMine(tx);
			} catch {
				return;
			}
			record(tx, { ok: false, error });
		});
	/** Check the authority of every result used to choose this operation before any mutation. */
	const authorized = (tx: Database) => {
		stillMine(tx);
		signal.throwIfAborted();
		for (const receipt of receipts)
			if (!deps.larm.validateReceiptInTransaction?.(tx, receipt))
				throw new StaleTurn("permission_revoked");
	};
	if (isDocTool(action.tool) && input.set.agent.document) {
		const document = port.documentOf(input.adapterRef);
		if (!document) {
			await refused("workspace_unavailable");
			return { ok: false, error: "workspace_unavailable" };
		}
		const tool = action.tool;
		const outcome = await deps.store.write((tx) => {
			authorized(tx);
			const done = runDocTool(tx, document, tool, action.arguments, input);
			record(tx, {
				ok: done.ok,
				...(!done.ok ? { error: done.error } : {}),
				...(done.revision !== undefined ? { revision: done.revision } : {}),
			});
			return done;
		});
		port.afterCommit(input.adapterRef);
		if (!outcome.ok) {
			const issue = outcome.issues?.[0];
			log.warn("dialogue.operation_rejected", {
				reason: "specialist_operation_refused",
				validationCode: outcome.error,
				// A position and a rule name only, as for an operation's repair hint; for an edit not found, the
				// edit's position and the kind of mismatch (never the text).
				...(issue
					? { repairHint: `${issue.path}: ${issue.rule}`.slice(0, 200) }
					: outcome.mismatch
						? { repairHint: `edits/${outcome.index}: ${outcome.mismatch}` }
						: {}),
			});
			return outcome;
		}
		const dropped = outcome.fixes?.some((fix) => DROPPED_PART.test(fix));
		return { ok: true, result: outcome, ...(dropped ? { dropped } : {}) };
	}
	const checked = port.parseInvocation(
		input.set,
		action.tool,
		action.arguments,
	);
	if (!checked.ok) {
		log.warn("dialogue.operation_rejected", {
			reason: "specialist_arguments_invalid",
			validationCode: checked.code,
		});
		await refused(checked.code);
		return {
			ok: false,
			error: checked.code,
			...(checked.detail?.length ? { detail: checked.detail } : {}),
		};
	}
	try {
		const result = await deps.store.write((tx) => {
			authorized(tx);
			const done = port.invokeInTransaction(tx, input.set, {
				operationName: checked.operationName,
				input: checked.input,
				requestId: crypto.randomUUID(),
				sessionId: input.sessionId,
				runId: input.runId,
				conversationId: input.conversationId,
				workRef: input.workRef,
			});
			const revision = (done.answerContext as { revision?: unknown } | null)
				?.revision;
			record(tx, {
				ok: true,
				...(typeof revision === "number" ? { revision } : {}),
			});
			return done;
		});
		port.afterCommit(input.adapterRef);
		return { ok: true, result: result.answerContext };
	} catch (error) {
		if (error instanceof StaleTurn || signal.aborted) throw error;
		const code = safeCode(error, "operation_failed");
		// A short repair hint the operation attached (never a definition): data for the next call.
		const detail = (error as { detail?: unknown }).detail;
		await refused(code);
		log.warn("dialogue.operation_rejected", {
			reason: "specialist_operation_refused",
			validationCode: code,
			// The hint names a position and a rule only, so it is safe to keep for finding why drafts fail.
			...(typeof detail === "string" && detail
				? { repairHint: detail.slice(0, 200) }
				: {}),
		});
		return {
			ok: false,
			error: code,
			...(typeof detail === "string" && detail
				? { detail: detail.slice(0, DETAIL_CHARS) }
				: {}),
		};
	}
}

/** What an operation carried, as counts only (spec §8.1): edits, or the characters of a whole text. */
function sizeOf(args: Record<string, unknown>): {
	size?: Record<string, number>;
} {
	const size: Record<string, number> = {};
	if (Array.isArray(args.edits)) size.edits = args.edits.length;
	if (typeof args.text === "string") size.chars = args.text.length;
	if (args.definition !== undefined)
		size.chars = JSON.stringify(args.definition).length;
	return Object.keys(size).length ? { size } : {};
}
