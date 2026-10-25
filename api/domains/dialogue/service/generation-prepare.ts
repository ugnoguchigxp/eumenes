import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { jstDay, jstSeconds } from "../../../infrastructure/jst-time";
import { getLogger } from "../../../infrastructure/logger";
import type { ConversationEvent, ReconstructReason } from "../../continuity";
import {
	REFERENCE_WINDOW_TOKENS,
	estimateJsonTokens,
	estimateTextTokens,
	planWindow,
	type ContextBlock,
	type WindowPlan,
} from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { isSystemPrompt, type Run } from "../contracts";
import {
	byId,
	previousGeneration,
	savePrefixDigest,
	transition,
} from "../repository";
import { withAttachmentNotes } from "./attachment-context";
import {
	DEFAULT_DEADLINE_MS,
	type ChatMessage,
	type DialogueDeps,
	type FinalMessage,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import { historyTokens, renderNow, type NowSources } from "./context-document";
import { FIXED_TRIGGER_TEXT } from "./context-system";
import {
	conversationDocumentInTransaction,
	conversationSystem,
	profileLimitOf,
	tokyoYear,
} from "./conversation-prefix";
import { generationTools } from "./generation-tools";
import { eventFields } from "./event-fields";
import {
	consumeAnswer,
	answerTicketInTransaction,
	intakeInTransaction,
} from "./result-intake";
import { acceptRunAnswer, endRun } from "./run-end";
import type { WorkRow } from "../repository/work";
import { hostTextBlock } from "./context-blocks";
import { specialistWorkBlock, viewingBlock } from "./specialist-context";
import { worldNamesBlock } from "./topic-texts";

const log = getLogger("dialogue");

/** Without any request this long, the provider's KV for the conversation is taken as gone (section 12.3). */
export const CACHE_IDLE_MS = 6 * 60 * 1000;
/** A silence this long before the newest event is a resumed conversation (section 8.3). */
export const RESUME_GAP_MS = 30 * 60 * 1000;
/** A gap this long between events is a break in the talk, where a re-construction may cut (section 8.3). */
export const TALK_BREAK_MS = 2 * 60 * 1000;

const tokens = (text: string) => estimateTextTokens(text);

/** The model window of this run: the claimed LARM lease's, the saved cloud resource's, else the reference. */
function windowOf(deps: DialogueDeps, tx: Database, runId: string): number {
	const requestId = deps.larm.requestFor?.(tx, runId, "llm");
	return (
		(requestId && deps.larm.llmContextWindowInTransaction?.(tx, requestId)) ||
		REFERENCE_WINDOW_TOKENS
	);
}

/** The newest message(s): each pending utterance as its own user message, or the host's fixed text. */
function finalMessages(
	deps: DialogueDeps,
	tx: Database,
	pending: readonly ConversationEvent[],
): { messages: ChatMessage[]; final: FinalMessage } {
	if (pending.length === 0)
		return {
			messages: [{ role: "user", content: FIXED_TRIGGER_TEXT }],
			final: { kind: "fixed" },
		};
	const messages: ChatMessage[] = [];
	for (const event of pending) {
		const messageId = event.messageIds[0];
		const found = messageId
			? deps.conversation.messageInTransaction(tx, messageId)
			: null;
		if (!found) continue;
		const text = withAttachmentNotes(
			found.message.text,
			found.message.attachments,
		);
		messages.push({
			role: "user",
			content: pending.length > 1 ? `[${event.at}] ${text}` : text,
			...(found.message.attachments?.length
				? {
						attachments: found.message.attachments,
						sourceMessageId: found.message.id,
					}
				: {}),
		});
	}
	if (messages.length === 0) throw new Error("run_input_missing");
	return {
		messages,
		final: {
			kind: "utterances",
			seqs: pending.map((event) => event.seq),
			messageIds: pending.flatMap((event) => event.messageIds),
		},
	};
}

/**
 * The utterance being delivered: the newest agent answer or announcement (the utterances whose playback reports
 * `delivered`) with no `delivered` record yet, while the user has not spoken since.
 */
function speakingNow(log: readonly ConversationEvent[]): string | null {
	const delivered = new Set<string>();
	for (const event of log)
		if (event.type === "delivered") {
			const ref = eventFields(event).ref;
			if (typeof ref === "string") delivered.add(ref);
		}
	for (let i = log.length - 1; i >= 0; i--) {
		const event = log[i]!;
		if (event.type !== "said") continue;
		if (event.by === "user") return null;
		const key = event.deliveryKey ?? "";
		if (!key.startsWith("run:") && !key.startsWith("announcement:")) continue;
		return delivered.has(event.id) ? null : event.id;
	}
	return null;
}

/**
 * Why the window is re-constructed before this generation, if at all (section 12.3): a resumed conversation, a
 * provider cache taken as lost (idle too long, the fixed part changed), or a section over its limit.
 */
function reconstructReason(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	plan: WindowPlan,
	prefixDigest: string,
	now: number,
): ReconstructReason | null {
	const events = deps.continuity.events;
	const log = events.logInTransaction(tx, run.conversationId);
	// The newest event by its time (the log is in appending order, which a late append can reverse).
	const lastAt = Math.max(
		-Infinity,
		...log.map((event) => Date.parse(event.at)),
	);
	if (
		Number.isFinite(lastAt) &&
		(now - lastAt >= RESUME_GAP_MS || jstDay(lastAt) !== jstDay(now))
	)
		return "resumed";
	const previous = previousGeneration(tx, run.conversationId, run.id);
	if (
		previous &&
		(now - Date.parse(previous.at) >= CACHE_IDLE_MS ||
			previous.prefixDigest !== prefixDigest)
	)
		return "cache_lost";
	const logTokens = log.reduce((sum, event) => sum + event.tokens, 0);
	if (
		logTokens > plan.log.cap ||
		historyTokens(
			events.episodeInTransaction(tx, run.conversationId),
			tokyoYear(now),
		) > plan.sections.episode
	)
		return "section_over_limit";
	return null;
}

/** `<now>` within its section: the agency's lines go first, then the records. */
function fitNow(
	now: NowSources,
	limit: number,
	render: (now: NowSources) => number,
) {
	const fitted = {
		...now,
		agency: [...now.agency],
		records: [...now.records],
	};
	while (render(fitted) > limit && fitted.agency.length) fitted.agency.shift();
	while (render(fitted) > limit && fitted.records.length)
		fitted.records.shift();
	return fitted;
}

/** The trigger of a generation: the TODOs that changed, the utterances it handles, or what a host notice says. */
function triggerOf(
	run: Run,
	pending: readonly ConversationEvent[],
	noticeText: string | null,
	changed: readonly WorkRow[] | null,
	hostNote: string | null,
	notAdopted: boolean,
): Array<Record<string, unknown>> {
	const trigger: Array<Record<string, unknown>> = [];
	// The earlier generation acted and was not adopted (section 13): the log and the TODOs show what it did.
	if (notAdopted) trigger.push({ kind: "not_adopted" });
	if (hostNote) trigger.push({ kind: "host_note", text: hostNote });
	if (changed?.length)
		trigger.push({
			kind: "todo_changed",
			todos: changed.map((row) => ({ id: row.id, status: row.status })),
		});
	if (pending.length)
		trigger.push({
			kind: "utterance",
			events: pending.map((event) => event.id),
		});
	if (trigger.length) return trigger;
	if (noticeText !== null) {
		try {
			const parsed = JSON.parse(noticeText) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				return [parsed as Record<string, unknown>];
		} catch {
			// A plain notice text.
		}
		return [{ kind: run.sourceKind, text: noticeText }];
	}
	return [{ kind: run.sourceKind }];
}

/**
 * The claim-time half of a generation (the ContextWindow specification, sections 5, 7 and 12): the pending
 * utterances it handles, the re-construction a lost cache or a full section calls for, the material document and
 * the three messages, all fixed inside the claim transaction.
 */
export function createPrepare(
	deps: DialogueDeps,
): HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	unknown
>["prepareInTransaction"] {
	const { conversation, larm, clock, memory, agency, worldContext } = deps;
	const events = deps.continuity.events;
	return (tx, claim) => {
		const run = byId(tx, claim.payload.runId);
		if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
			return { status: "stale", reason: "run_not_queued" };
		if (!transition(tx, run.id, run.revision, "running", clock()))
			return { status: "stale", reason: "run_changed" };
		const current = byId(tx, run.id) as Run;
		const conversationId = run.conversationId;
		const nowMs = Date.parse(clock());
		// The work this run waited for, or a task's notice, reports into its TODO first (section 9.1).
		const changed = intakeInTransaction(deps, tx, current, claim.payload);
		if (changed && changed.length === 0) {
			endRun(deps, tx, current, "cancelled", "work_report_stale");
			return { status: "stale", reason: "work_report_stale" };
		}
		const agent = answerTicketInTransaction(deps, tx, current);
		// A host notice speaks about what happened; a user's or a schedule's input is a pending utterance.
		const notice = run.sourceKind === "notice";
		const pending = notice
			? []
			: events.pendingInTransaction(tx, conversationId);
		// A host note the work did not take as its report (a specialist switch to confirm) is this run's trigger.
		const hostNote = changed ? null : (claim.payload.commandNote ?? null);
		const notAdopted = claim.payload.notAdopted === true;
		// A TODO that changed is the conversation agent's to report, on its own opportunity: no generation runs for
		// it. The sub-agent's answer is consumed here (one whose evidence changed drops its result).
		if (changed?.length && !hostNote && !notAdopted && pending.length === 0) {
			if (agent) consumeAnswer(deps, tx, current, agent);
			// The report is recorded in the TODO already: a request that can no longer be accepted (settings changed,
			// deadline passed) only means nothing stands on it, so what waits on it (a voice turn) ends; the run does not
			// fail, nor is its TODO overwritten.
			if (!acceptRunAnswer(deps, tx, current))
				log.warn("dialogue.answer_request_not_accepted", {
					runId: run.id,
					reason: "permission_revoked",
				});
			endRun(deps, tx, current, "completed", null);
			agency?.workChangedInTransaction(tx, conversationId);
			return { status: "stale", reason: "work_reported" };
		}
		if (
			!notice &&
			!changed &&
			!hostNote &&
			!notAdopted &&
			pending.length === 0
		) {
			// An earlier generation handled this utterance already.
			endRun(deps, tx, current, "cancelled", "utterance_handled");
			return { status: "stale", reason: "utterance_handled" };
		}
		let window: ReturnType<
			NonNullable<typeof memory>["windowForRunInTransaction"]
		> = null;
		try {
			window = memory?.windowForRunInTransaction(tx, conversationId) ?? null;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "memory_blocked")
				throw error;
			// Never silently drop memory and continue; end the run with the reason.
			endRun(deps, tx, current, "failed", "memory_blocked");
			return { status: "stale", reason: "memory_blocked" };
		}
		if (larm.captureInTransaction && !larm.requestFor?.(tx, run.id, "llm")) {
			const snapshot = larm.snapshotInTransaction?.(tx);
			if (snapshot) {
				for (const p of ["llm", "asr", "tts"] as const) {
					snapshot.routes[p].mode = "larm-only";
					snapshot.routes[p].cloudAllowed = false;
				}
				larm.captureInTransaction(
					tx,
					run.id,
					"llm",
					claim.deadlineAtMs ?? Date.now() + DEFAULT_DEADLINE_MS,
					snapshot,
				);
			}
		}
		const requestId = larm.requestFor?.(tx, run.id, "llm");
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		const system = conversationSystem(deps, tx);
		const fixed = tokens(system) + estimateJsonTokens(generationTools);
		const plan = planWindow({ window: windowOf(deps, tx, run.id), fixed });
		if (!plan.usable) {
			endRun(deps, tx, current, "failed", "window_too_small");
			return { status: "stale", reason: "window_too_small" };
		}
		const prefixDigest = sha256Hex(system + JSON.stringify(generationTools));
		const reason = reconstructReason(
			deps,
			tx,
			current,
			plan,
			prefixDigest,
			nowMs,
		);
		if (reason) {
			const rebuilt = events.reconstructInTransaction(tx, {
				conversationId,
				at: jstSeconds(nowMs),
				reason,
				limits: {
					log: plan.log,
					episode: plan.sections.episode,
					silenceMs: TALK_BREAK_MS,
				},
			});
			// A re-construction republishes the profile: the waiting additions join it (sections 5.4 and 12.3).
			if (window?.republishRequested || window?.newMemories.length)
				window =
					memory?.republishWindowInTransaction(tx, conversationId) ?? window;
			log.info("dialogue.window_reconstructed", {
				reason,
				count: rebuilt.moved,
			});
		}
		savePrefixDigest(tx, run.id, prefixDigest);
		const { messages: newest, final } = finalMessages(deps, tx, pending);
		const noticeText = notice
			? (conversation.messageInTransaction(tx, run.inputMessageId)?.message
					.text ?? null)
			: null;
		const texts = newest.map((message) => message.content);
		const records: ContextBlock[] = [
			worldContext
				? worldNamesBlock(
						worldContext.knownNamesInTransaction(tx, { conversationId, texts }),
					)
				: null,
			deps.specialist && !isSystemPrompt(run.sourceKind)
				? specialistWorkBlock(deps, tx, current)
				: null,
			deps.specialist && !isSystemPrompt(run.sourceKind)
				? viewingBlock(deps, tx, current)
				: null,
			claim.payload.specialistHandoff
				? hostTextBlock("specialist.handoff", claim.payload.specialistHandoff)
				: null,
		].filter((block): block is ContextBlock => !!block);
		// The background calls on this conversation render the same document (conversation-prefix.ts): the profile
		// limit is the one they use too, so their prefix is this one while nothing changes.
		const { document, refs, todos, logged, adopted } =
			conversationDocumentInTransaction(deps, tx, conversationId, {
				window,
				profileLimit: profileLimitOf(deps, system, plan.window),
				nowMs,
			});
		const now = fitNow(
			{
				at: jstSeconds(nowMs),
				trigger: triggerOf(
					current,
					pending,
					noticeText,
					changed,
					hostNote,
					notAdopted,
				),
				speaking: speakingNow(logged),
				agency: agency?.stateForContextInTransaction(tx, conversationId) ?? [],
				records,
			},
			plan.sections.now,
			(fitted) => tokens(renderNow(fitted, refs)),
		);
		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			{ role: "user", content: document.text },
			{ role: "user", content: renderNow(now, refs) },
			...newest,
		];
		log.debug("dialogue.context_measured", {
			kind: "estimated_tokens",
			count: tokens(system) + document.tokens,
		});
		// The TODOs whose result the log shows: what a reply may report.
		const resulted = new Set(
			logged.flatMap((event) => {
				if (event.type !== "acted" || event.forgotten) return [];
				const fields = eventFields(event);
				return fields.action === "work.result" &&
					typeof fields.todo === "string"
					? [fields.todo]
					: [];
			}),
		);
		return {
			status: "ready",
			input: {
				runId: run.id,
				inputMessageId: run.inputMessageId,
				lastSeq: Math.max(
					0,
					...logged.map((event) => event.seq),
					...pending.map((event) => event.seq),
				),
				jobId: claim.jobId,
				revision: current.revision,
				conversationId,
				...(requestId ? { requestId } : {}),
				messages,
				final,
				trigger: now.trigger,
				plan,
				document,
				...(agent ? { agent } : {}),
				shown: {
					todos: todos
						.filter((todo) => resulted.has(todo.id))
						.map((todo) => todo.id),
				},
				todoRevisions: Object.fromEntries(
					(deps.work?.todoRevisionsInTransaction(tx, conversationId) ?? []).map(
						(row) => [row.id, row.revision],
					),
				),
				windowVersion: events.windowVersionInTransaction(tx, conversationId)
					.version,
				retained: deps.work?.retainedInTransaction(tx, conversationId) ?? [],
				sessionContext: { instructionCount: 1, historyCount: 0 },
				...(window && memory
					? {
							memory: {
								window: memory.preparedWindow(
									window,
									final.kind === "utterances" ? final.messageIds : [],
								),
								blockedAtPrepare: [
									...memory.blockedMessageIdsInTransaction(
										tx,
										final.kind === "utterances" ? final.messageIds : [],
									),
								],
							},
						}
					: {}),
				...(adopted.length
					? { goals: { goalIds: adopted.map((goal) => goal.goalId) } }
					: {}),
			},
		};
	};
}
