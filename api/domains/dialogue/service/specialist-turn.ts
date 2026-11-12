import { z } from "zod";
import type { Database } from "bun:sqlite";
import { stateProposalSchema } from "eumenes-collaboration";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import {
	toolResultMessage,
	type ControlContract,
	type Receipt,
} from "../../inference";
import type { HandlerDefinition } from "../../queue";
import {
	guidanceLanguageSchema,
	type GuidanceLanguage,
	type Run,
	type SpecialistSet,
} from "../contracts";
import { byId, sessionById, transition } from "../repository";
import { SPECIALIST_KIND, type ChatMessage } from "./context";
import type { DialogueDeps, SpecialistTurnPayload } from "./context";
import { endRun } from "./run-end";
import { traceFailure } from "./selection-outcome";
import { TURN_BUDGET_MS, flushDeferred, turnRefusal } from "./specialist-core";
import {
	correctionMessage,
	parseSpecialistAction,
	specialistViolations,
	violationNames,
	statefulSpecialistContract,
	type SpecialistAction,
} from "./specialist-prompt";
import { agentPolicy } from "./specialist-agent";
import { invokeSpecialistTool, StaleTurn } from "./specialist-invoke";
import {
	decodeSpecialistOutput,
	SpecialistOutputError,
	specialistOutputSchema,
	specialistSingleSentenceOutputSchema,
} from "./specialist-output";
import {
	appendGuidanceResult,
	prepareSpecialistPrompt,
} from "./specialist-turn-prompt";
import { settleSpecialistTurn } from "./specialist-settle";
import {
	collaborationSnapshot,
	collaborationReference,
	adoptCollaborationState,
	stateUpdateBase,
} from "./collaboration-state";

const log = getLogger("dialogue");

const MAX_OUTPUT_TOKENS = 24_576;
/** A refusal that a retry does not fix: the request named nothing to change (spec §7.5). */
const NO_CHANGE_REPLY = "変更点が分かりませんでした。どこを変えますか。";
/** Refusals beyond the tool's retries end the turn (spec §6.5); a kept whole draft can be read in the source. */
const REFUSED_REPLY = "反映できませんでした。";
const KEPT_REPLY = "反映できませんでした。作った案はソースで確認できます。";
/** The domain's fixer dropped parts it could not show (spec §12 S2); a dropped key or option is no part. */
const DROPPED_NOTE = "表示できない部分は省きました。";
/** The work changed but the specialist gave no valid reply: the host says so (spec §6.5, D10). */
const updatedReply = (label: string) =>
	`${label.length > 40 ? `${label.slice(0, 40)}…` : label}を更新しました。`;

/** What the specialist prepared for the host to apply at settlement. */
export type TurnOutput = {
	/** Every control receipt of the turn; each is accepted (or the turn is not adopted). */
	receipts: Receipt[];
	action:
		| Exclude<SpecialistAction, { kind: "invoke" }>
		| {
				kind: "handoff";
				handoff: import("../../tool-runtime").SpecialistHandoff;
				text?: string;
		  };
};
export type TurnInput = {
	observation?: true;
	observedExcerpt?: string;
	guidanceNoticeRef?: string;
	runId: string;
	revision: number;
	sessionId: string;
	epoch: number;
	adapterRef: string;
	workRef: string;
	conversationId: string;
	set: SpecialistSet;
	control: ControlContract;
	guidanceToolId?: string;
	guidanceLanguage?: GuidanceLanguage;
	guidanceReport?: string;
	candidateDelivery?: {
		acceptedAt: number;
		workRevision: number;
		kind: string;
		skillDigest: string;
		requestBytes: number;
	};
	messages: ChatMessage[];
	/** Epoch ms the model calls and operations of this turn must finish by. */
	deadline: number;
	/** The turn's time from its start: the shortest of its turn time, the run's and the session's remaining time. */
	limitMs: number;
};

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

function updatedTurn(
	deps: DialogueDeps,
	input: TurnInput,
	receipts: Receipt[],
): TurnOutput {
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
}

function assertTurnCurrent(deps: DialogueDeps, tx: Database, input: TurnInput) {
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
}

/** State adoption shares the turn's live-run, cancellation and receipt boundary. */
const stateChanges = z.looseObject({
	stateUpdate: stateProposalSchema
		.pick({ upserts: true, removals: true })
		.nullish(),
});
const fullStateUpdate = z.looseObject({ stateUpdate: stateProposalSchema });

function proposalRefusal(error: z.ZodError) {
	return {
		ok: false as const,
		reason: "proposal_invalid",
		issues: error.issues.slice(0, 8).map((issue) => ({
			path: issue.path.join("."),
			code: issue.code,
			...("expected" in issue ? { expected: issue.expected } : {}),
		})),
	};
}

async function statefulAction(
	deps: DialogueDeps,
	input: TurnInput,
	signal: AbortSignal,
	stillMine: (tx: Database) => void,
	output: {
		value: unknown;
		receipt: Receipt;
		call: number;
		baseline?: ReturnType<typeof stateUpdateBase>;
	},
) {
	let value = output.value;
	if (output.baseline) {
		const proposal = stateChanges.safeParse(value);
		if (!proposal.success) return proposalRefusal(proposal.error);
		value = {
			...proposal.data,
			stateUpdate: { ...output.baseline, ...proposal.data.stateUpdate },
		};
	}
	const checked = statefulSpecialistContract.check(value);
	if (!checked.ok) {
		if (checked.reason === "proposal_invalid") {
			const proposal = fullStateUpdate.safeParse(value);
			if (!proposal.success) return proposalRefusal(proposal.error);
		}
		return checked;
	}
	const adopted = await deps.store.write((tx) => {
		stillMine(tx);
		signal.throwIfAborted();
		if (!deps.larm.validateReceiptInTransaction?.(tx, output.receipt))
			throw new StaleTurn("permission_revoked");
		return adoptCollaborationState(
			deps,
			tx,
			{
				sessionId: input.sessionId,
				epoch: input.epoch,
				runId: input.runId,
				operationId: `${input.runId}:${input.sessionId}:${input.epoch}:${output.call}`,
			},
			checked.proposal,
		);
	});
	return adopted.ok ? { ok: true as const, action: checked.action } : adopted;
}

function stateReference(
	deps: DialogueDeps,
	tx: Database,
	input: TurnInput,
	reference: string,
) {
	if (!input.set.agent.collaborationState || input.observation)
		return { content: reference };
	const hostBound = input.set.agent.collaborationState === "host-bound";
	const snapshot = collaborationSnapshot(
		deps,
		tx,
		sessionById(tx, input.sessionId)!,
		input.runId,
	);
	return {
		content: reference + collaborationReference(snapshot, hostBound),
		baseline: hostBound ? stateUpdateBase(snapshot) : undefined,
	};
}

/** The specialist turn: the user's utterance goes to the toolchain's specialist, never to the main model. */
function logCandidateDelivery(input: TurnInput) {
	if (!input.candidateDelivery) return;
	const { acceptedAt, ...delivery } = input.candidateDelivery;
	log.info("knowledge.specialist_candidate", {
		...delivery,
		durationMs: Date.now() - acceptedAt,
	});
}

function specialistRepair(
	input: TurnInput,
	raw: string,
	violations: Parameters<typeof correctionMessage>[1],
	callsLeft: number,
) {
	const message = correctionMessage(raw, violations, callsLeft);
	const singleSentence =
		input.candidateDelivery &&
		violations.some(
			(issue) => "path" in issue && issue.path.startsWith("text."),
		);
	if (singleSentence)
		message.content +=
			"\n要点を first の一文にまとめ、second は null にします。原文の引用と観測値は正確に保ちます。";
	return {
		message,
		outputSchema: singleSentence
			? specialistSingleSentenceOutputSchema
			: specialistOutputSchema,
	};
}

export function createSpecialistTurnHandler(
	deps: DialogueDeps,
): HandlerDefinition<SpecialistTurnPayload, TurnInput, TurnOutput> {
	const { larm, clock } = deps;
	return {
		kind: SPECIALIST_KIND,
		payloadVersions: [1],
		schema: z.object({
			runId: z.string(),
			epoch: z.number().int(),
			request: z.string().max(8000).optional(),
			guidanceLanguage: guidanceLanguageSchema.optional(),
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
					...prepareSpecialistPrompt(
						deps,
						tx,
						run,
						session,
						set,
						work,
						input.message.text,
						claim.payload.guidanceLanguage,
					),
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
					signal.throwIfAborted();
					if (input.observedExcerpt !== undefined)
						return {
							receipts: [],
							action: { kind: "reply", text: input.observedExcerpt },
						} satisfies TurnOutput;
					logCandidateDelivery(input);
					await appendGuidanceResult(deps, input, signal);
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
}

/** The turn's model calls, with the operations the specialist invokes in between. */
async function runTurn(
	deps: DialogueDeps,
	input: TurnInput,
	signal: AbortSignal,
): Promise<TurnOutput> {
	const { larm, store } = deps;
	const messages = [...input.messages];
	const reference = messages[1]?.content ?? "";
	const receipts: Receipt[] = [];
	const policy = agentPolicy(input.set);
	const max = policy.maxModelCalls;
	/** The current output was rejected once; a valid action resets it (one repair per output, D3). */
	let repaired = false;
	let replySchema: Record<string, unknown> = specialistOutputSchema;
	/** An operation of this turn succeeded: the turn is not lost when its reply is. */
	let applied = false;
	/** Refusals per tool in this turn, against the tool's retries (spec §7.4). */
	const refusals = new Map<string, number>();
	const updated = () => updatedTurn(deps, input, receipts);
	const hostReply = (text: string): TurnOutput => ({
		receipts,
		action: { kind: "reply", text },
	});
	/** The session still addresses this turn; checked in the same transaction as each capture/operation. */
	const stillMine = (tx: Database) => assertTurnCurrent(deps, tx, input);
	for (let call = 1; call <= max; call++) {
		signal.throwIfAborted();
		const { requestId, baseline } = await store.write((tx) => {
			stillMine(tx);
			const state = stateReference(deps, tx, input, reference);
			messages[1] = {
				...messages[1]!,
				content: state.content,
			};
			const requestId = larm.captureControlInTransaction!(tx, {
				subject: `specialist:${input.runId}:${input.sessionId}:${input.epoch}:${call}`,
				policySubject: input.runId,
				deadline: input.deadline,
				maxOutputTokens: input.set.agent.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
				...(input.set.timeLimits
					? { attemptMs: input.set.timeLimits.inferenceMs }
					: {}),
			});
			return { requestId, baseline: state.baseline };
		});
		// The provider session lives as long as the specialist session; it is released when that ends.
		const receipt = await larm.executeControl!(
			requestId,
			messages,
			signal,
			input.control,
			{
				sessionRole: "subagent",
				...(input.candidateDelivery ? { outputSchema: replySchema } : {}),
				taskId: input.sessionId,
				agentSession: {
					conversationId: input.conversationId,
					agentId: input.sessionId,
				},
			},
		);
		receipts.push(receipt);
		const raw = String(receipt.value);
		let value: unknown;
		let action: SpecialistAction | null = null;
		let issues: ReturnType<typeof specialistViolations> | undefined;
		try {
			value = input.candidateDelivery
				? decodeSpecialistOutput(raw)
				: parseLlmJson(raw);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof SpecialistOutputError) issues = error.issues;
			else if (error instanceof LlmJsonError)
				issues = [{ path: "", code: error.code }];
			else throw error;
		}
		if (!issues) {
			if (input.set.agent.collaborationState && !input.observation) {
				const checked = await statefulAction(deps, input, signal, stillMine, {
					value,
					receipt,
					call,
					baseline,
				});
				if (checked.ok) action = checked.action;
				else if ("violations" in checked) issues = checked.violations;
				else if ("issues" in checked && checked.issues)
					issues = [...checked.issues];
				else issues = [{ path: "stateUpdate", code: checked.reason }];
			} else action = parseSpecialistAction(value);
		}
		if (!action || (input.observation && action.kind !== "reply")) {
			const violations = action
				? [{ path: "action", code: "host_event_reply_only" }]
				: (issues ?? specialistViolations(value));
			log.warn("dialogue.specialist_output_rejected", {
				reason: "invalid_contract",
				repairAttempt: repaired ? 1 : 0,
				violations: violationNames(violations).join(" ").slice(0, 256),
			});
			if (repaired || call === max) {
				if (applied) return updated();
				throw new Error(
					repaired ? "specialist_invalid_contract" : "specialist_turn_limit",
				);
			}
			repaired = true;
			const repair = specialistRepair(input, raw, violations, max - call);
			messages.push(repair.message);
			replySchema = repair.outputSchema;
			continue;
		}
		repaired = false;
		replySchema = specialistOutputSchema;
		if (action.kind !== "invoke") return { receipts, action };
		const lookup = action.tool === input.guidanceToolId;
		// A lookup needs a following call to consume the result.
		if (call === max && (!action.text || lookup)) {
			if (applied) return updated();
			throw new Error("specialist_turn_limit");
		}
		const result = await invokeSpecialistTool(
			deps,
			input,
			action,
			stillMine,
			receipts,
			signal,
		);
		if (result.ok) {
			if (result.handoff)
				return {
					receipts,
					action: {
						kind: "handoff",
						handoff: result.handoff,
						text: action.text,
					},
				};
			// Reading the document changes nothing: only an operation that may change the work counts.
			if (action.tool !== "doc.view" && !lookup) applied = true;
			// The reply the operation carried ends the turn without another call (spec §6.3).
			if (action.text && !lookup)
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
