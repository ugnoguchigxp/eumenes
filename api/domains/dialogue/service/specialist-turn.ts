import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { ControlContract, Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { Run, SpecialistSet } from "../contracts";
import {
	byId,
	sessionById,
	sessionRunsBefore,
	transition,
	type SessionRecord,
} from "../repository";
import { SPECIALIST_KIND, type ChatMessage } from "./context";
import type { DialogueDeps, SpecialistTurnPayload } from "./context";
import { endRun } from "./run-end";
import { traceFailure } from "./selection-trace";
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
	specialistInput,
	specialistSystemMessage,
	specialistViolations,
	toolResultMessage,
	type SpecialistAction,
} from "./specialist-prompt";
import { viewedSpecialistTarget } from "./specialist-context";
import { settleSpecialistTurn } from "./specialist-settle";
import { subagentRoute } from "./toolchain-command";

const log = getLogger("dialogue");

/** Model calls of one turn (an invoke's follow-up and the one structural repair count). */
const MAX_MODEL_CALLS = 6;
/** The turn's own earlier exchanges kept in the prompt, newest first, within these bounds. */
const HISTORY_RUNS = 12;
const HISTORY_BYTES = 24 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
/** The longest repair hint of a refused operation that reaches the specialist. */
const DETAIL_CHARS = 300;

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

/** The session's own earlier exchanges (completed turns), oldest first, within a size budget. */
function sessionHistory(
	deps: DialogueDeps,
	tx: Database,
	session: SessionRecord,
	run: Run,
): ChatMessage[] {
	const entries: ChatMessage[][] = [];
	let bytes = 0;
	const runs = sessionRunsBefore(tx, session.id, run.id, HISTORY_RUNS).filter(
		(entry) => entry.status === "completed" && entry.answerMessageId,
	);
	for (const entry of runs.reverse()) {
		const input = deps.conversation.messageInTransaction(
			tx,
			entry.inputMessageId,
		);
		const answer = deps.conversation.messageInTransaction(
			tx,
			entry.answerMessageId!,
		);
		if (!input || !answer) continue;
		const pair: ChatMessage[] = [
			{ role: "user", content: input.message.text },
			{ role: "assistant", content: answer.message.text },
		];
		const size = pair.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0);
		if (bytes + size > HISTORY_BYTES) break;
		bytes += size;
		entries.unshift(pair);
	}
	return entries.flat();
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
				TURN_BUDGET_MS,
				Date.parse(run.deadlineAt!) - Date.parse(clock()),
				Date.parse(session.expiresAt) - Date.parse(clock()),
			);
			// Too little time left for one model call and the answer: end with a clear code.
			if (remaining <= 5000) return failRun(deps, tx, run, "deadline_exceeded");
			if (!transition(tx, run.id, run.revision, "running", clock()))
				return { status: "stale", reason: "run_changed" };
			const control = specialistControl(set);
			const handedOver = claim.payload.request;
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
					messages: [
						specialistSystemMessage(control),
						...sessionHistory(deps, tx, session, run),
						{
							role: "user",
							content: specialistInput({
								request: handedOver ?? input.message.text,
								...(handedOver && handedOver !== input.message.text
									? { userUtterance: input.message.text }
									: {}),
								label: work.label,
								dirty: work.dirty,
								current: work.current,
								savedRef: work.savedRef,
								viewing: viewedSpecialistTarget(deps, tx, run),
								nowMs: Date.parse(clock()),
							}),
						},
					],
					deadline: Date.now() + remaining,
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
					if (timeout.aborted && !caller.aborted)
						throw new Error("specialist_turn_timeout");
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
		let repaired = false;
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
		for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
			signal.throwIfAborted();
			const requestId = await store.write((tx) => {
				stillMine(tx);
				return larm.captureControlInTransaction!(tx, {
					subject: `specialist:${input.runId}:${call}`,
					policySubject: input.runId,
					deadline: input.deadline,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					// The saved sub-agent resource (read in this transaction); none keeps the call on LARM.
					route: subagentRoute(larm.snapshotInTransaction?.(tx)),
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
				if (repaired) throw new Error("specialist_invalid_contract");
				repaired = true;
				messages.push(correctionMessage(raw, specialistViolations(value)));
				continue;
			}
			if (action.kind !== "invoke") return { receipts, action };
			messages.push({ role: "assistant", content: raw });
			messages.push(
				toolResultMessage(
					await invoke(deps, input, action, stillMine, receipts, signal),
				),
			);
		}
		// The specialist neither answered nor handed back within its calls.
		throw new Error("specialist_turn_limit");
	}
}

/** One operation of the set, run in its own writer transaction; a refusal is data for the next call. */
async function invoke(
	deps: DialogueDeps,
	input: TurnInput,
	action: Extract<SpecialistAction, { kind: "invoke" }>,
	stillMine: (tx: Database) => void,
	receipts: Receipt[],
	signal: AbortSignal,
): Promise<unknown> {
	const port = deps.specialist!;
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
		return {
			ok: false,
			error: checked.code,
			...(checked.detail?.length ? { detail: checked.detail } : {}),
		};
	}
	try {
		const result = await deps.store.write((tx) => {
			stillMine(tx);
			signal.throwIfAborted();
			// Check the authority of every result used to choose this operation before any mutation.
			for (const receipt of receipts)
				if (!deps.larm.validateReceiptInTransaction?.(tx, receipt))
					throw new StaleTurn("permission_revoked");
			return port.invokeInTransaction(tx, input.set, {
				operationName: checked.operationName,
				input: checked.input,
				requestId: crypto.randomUUID(),
				sessionId: input.sessionId,
				runId: input.runId,
				conversationId: input.conversationId,
				workRef: input.workRef,
			});
		});
		port.afterCommit(input.adapterRef);
		return { ok: true, result: result.answerContext };
	} catch (error) {
		if (error instanceof StaleTurn || signal.aborted) throw error;
		const code = safeCode(error, "operation_failed");
		log.warn("dialogue.operation_rejected", {
			reason: "specialist_operation_refused",
			validationCode: code,
		});
		// A short repair hint the operation attached (never a definition): data for the next call.
		const detail = (error as { detail?: unknown }).detail;
		return {
			ok: false,
			error: code,
			...(typeof detail === "string" && detail
				? { detail: detail.slice(0, DETAIL_CHARS) }
				: {}),
		};
	}
}
