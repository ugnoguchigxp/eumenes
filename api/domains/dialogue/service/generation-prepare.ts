import type { Database } from "bun:sqlite";
import { reportNoticeInTransaction } from "./report-notice";
import { getLogger } from "../../../infrastructure/logger";
import type { ConversationEvent } from "../../continuity";
import {
	REFERENCE_WINDOW_TOKENS,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
	planWindow,
} from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { Run } from "../contracts";
import { byId, transition } from "../repository";
import { withAttachmentNotes } from "./attachment-context";
import {
	DEFAULT_DEADLINE_MS,
	type ChatMessage,
	type DialogueDeps,
	type FinalMessage,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import type { DocumentRefs } from "./work-items";
import {
	conversationPrefixFrom,
	conversationSystem,
	placeCutInTransaction,
	withLastMessage,
} from "./conversation-input";
import { toolchainTitlesInTransaction } from "./delegate-conversation";
import { generationTools } from "./generation-tools";
import { harnessOf, routeConversation } from "./harness";
import { INPUT_HEADINGS, dataText, lineText, section } from "./input-text";
import {
	consumeAnswer,
	answerTicketInTransaction,
	intakeInTransaction,
} from "./result-intake";
import { resultText } from "./result-text";
import { acceptRunAnswer, endRun } from "./run-end";
import type { WorkRow } from "../repository/work";
import { madeOf, stateLinesInTransaction, stateText } from "./state-text";

const log = getLogger("dialogue");

/** A gap this long since the last delivery is a break in the talk: the context keeper's fallback runs (section 7.3). */
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

/** The pending utterances: their texts (with the notes of their attachments) and the newest one's images. */
function pendingInput(
	deps: DialogueDeps,
	tx: Database,
	pending: readonly ConversationEvent[],
): {
	texts: string[];
	final: FinalMessage;
	attachments: Pick<ChatMessage, "attachments" | "sourceMessageId">;
} {
	if (pending.length === 0)
		return { texts: [], final: { kind: "fixed" }, attachments: {} };
	const texts: string[] = [];
	let attachments: Pick<ChatMessage, "attachments" | "sourceMessageId"> = {};
	for (const event of pending) {
		const messageId = event.messageIds[0];
		const found = messageId
			? deps.conversation.messageInTransaction(tx, messageId)
			: null;
		if (!found) continue;
		texts.push(
			withAttachmentNotes(found.message.text, found.message.attachments),
		);
		// One message's images go with the input (the newest that has any).
		if (found.message.attachments?.length)
			attachments = {
				attachments: found.message.attachments,
				sourceMessageId: found.message.id,
			};
	}
	if (texts.length === 0) throw new Error("run_input_missing");
	return {
		texts,
		final: {
			kind: "utterances",
			seqs: pending.map((event) => event.seq),
			messageIds: pending.flatMap((event) => event.messageIds),
		},
		attachments,
	};
}

/** A host notice's text: a notice's own fields as items, or its plain text. */
function noticeLines(text: string): string[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return Object.entries(parsed as Record<string, unknown>).flatMap(
				([key, value]) =>
					value === null || value === undefined || typeof value === "object"
						? []
						: [`- ${key}: ${lineText(String(value))}`],
			);
	} catch {
		// A plain notice text.
	}
	return [dataText(text)];
}

/** The specialist's hand-back as a line of the work (`## State`): who gave the words back, and on what. */
function handoffLine(handoff: string): string {
	try {
		const parsed = JSON.parse(handoff) as {
			specialist?: unknown;
			label?: unknown;
		};
		return `担当 ${String(parsed.specialist ?? "")} が今回の発言を担当の外として戻した${parsed.label ? `（作業「${String(parsed.label)}」）` : ""}`;
	} catch {
		return handoff;
	}
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
 * The claim-time half of a generation (the conversation input specification, sections 3 to 8): the pending
 * utterances it handles, the cut of the recent conversation, and the messages (the system part, `## Memory`, the
 * recent conversation, then `## State` with `## Host notice` and `## User`), all fixed inside the claim transaction.
 */
export function createPrepare(
	deps: DialogueDeps,
): HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	unknown
>["prepareInTransaction"] {
	const { conversation, larm, clock, memory, agency } = deps;
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
		// A TODO that changed runs no generation: finished work is told by its notice on screen, a question is the
		// agency's to ask on its own opportunity. The sub-agent's answer is consumed here (one whose evidence changed
		// drops its result).
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
				routeConversation(snapshot);
				for (const p of ["asr", "tts"] as const) {
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
		// The harness follows the route the run captured and builds its input. A `larm-preferred` call that falls back
		// to the cloud mid-run takes the cloud harness's call settings (the generation passes both).
		const harness = harnessOf(larm.snapshotFor?.(tx, run.id) ?? null);
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		const system = conversationSystem(deps, tx, harness);
		const fixed = tokens(system) + estimateJsonTokens(generationTools);
		const plan = planWindow({ window: windowOf(deps, tx, run.id), fixed });
		if (!plan.usable) {
			endRun(deps, tx, current, "failed", "window_too_small");
			return { status: "stale", reason: "window_too_small" };
		}
		const pendingIds = new Set(pending.flatMap((event) => event.messageIds));
		// The recent conversation is cut by the host's fixed rules before it is drawn (section 6.1.1).
		const placed = placeCutInTransaction(deps, tx, conversationId, {
			system,
			window,
			nowMs,
			pending: pendingIds,
			history: harness.history,
		});
		window = placed.window;
		if (placed.reason)
			log.info("dialogue.input_cut", { reason: placed.reason, runId: run.id });
		const prefix = conversationPrefixFrom(deps, tx, conversationId, {
			harness,
			system,
			window,
			pending: pendingIds,
		});
		const { texts, final, attachments } = pendingInput(deps, tx, pending);
		const noticeText = notice
			? (conversation.messageInTransaction(tx, run.inputMessageId)?.message
					.text ?? null)
			: null;
		const refs: DocumentRefs = deps.work?.refsInTransaction(
			tx,
			conversationId,
		) ?? { todo: () => null, confirmation: () => null, resource: () => null };
		// The questions this generation was triggered by: the host notice shows them, this call only. Finished work
		// is archived as it finishes and told by its notice on screen, never here.
		const reported = (changed ?? []).filter(
			(row) => row.status === "waiting" && !row.archivedAt,
		);
		// The reply to them follows their notice in the recent conversation (section 5.5 #4).
		const reportNotice = reportNoticeInTransaction(
			deps,
			tx,
			conversationId,
			reported.map((row) => row.id),
		);
		const results = reported.map(
			(row) =>
				resultText({
					ref: refs.todo(row.id) ?? "t?",
					title: row.title,
					status: row.status,
					...(row.outcome ? { outcome: row.outcome } : {}),
					...(row.question ? { question: row.question } : {}),
					result: row.result,
					made: deps.work
						? deps.work
								.todosInTransaction(tx, conversationId)
								.filter((todo) => todo.id === row.id)
								.flatMap((todo) => madeOf(todo, refs))
						: [],
					resource: refs.resource,
				}).text,
		);
		const noticeBody = [
			...(notAdopted
				? [
						"前の返事は届けられませんでした。すでに頼んだ仕事は「## State」の仕事にあります。",
					]
				: []),
			...(hostNote ? [dataText(hostNote)] : []),
			...results,
			...(noticeText !== null ? noticeLines(noticeText) : []),
		];
		const lastAgent =
			[...prefix.recent].reverse().find((u) => u.speaker === "agent") ?? null;
		const state = stateText(
			stateLinesInTransaction(deps, tx, {
				conversationId,
				run: current,
				nowMs,
				lastAt: prefix.lastAt,
				since: prefix.since,
				lastAgent,
				state: deps.conversation.input.latestStateInTransaction(
					tx,
					conversationId,
				),
				...(claim.payload.specialistHandoff
					? { handoff: handoffLine(claim.payload.specialistHandoff) }
					: {}),
				refs,
			}),
		);
		const messages = withLastMessage(
			prefix,
			[
				state,
				section(INPUT_HEADINGS.notice, noticeBody),
				texts.length
					? `${INPUT_HEADINGS.user}\n${texts.map(dataText).join("\n")}`
					: null,
			],
			attachments,
		);
		log.debug("dialogue.context_measured", {
			kind: "estimated_tokens",
			count: estimateMessageTokens(messages),
		});
		return {
			status: "ready",
			input: {
				runId: run.id,
				inputMessageId: run.inputMessageId,
				lastSeq: events.latestSeqInTransaction(tx, conversationId),
				jobId: claim.jobId,
				revision: current.revision,
				conversationId,
				...(requestId ? { requestId } : {}),
				harness,
				messages,
				toolchainTitles: toolchainTitlesInTransaction(deps, tx),
				utterances: texts,
				final,
				trigger: triggerOf(
					current,
					pending,
					noticeText,
					changed,
					hostNote,
					notAdopted,
				),
				...(agent ? { agent } : {}),
				shown: { todos: reported.map((row) => row.id) },
				...(reportNotice ? { notice: reportNotice } : {}),
				memoryItemIds: prefix.memoryItemIds,
				cut: placed.reason,
				inputRevision: prefix.cut?.revision ?? 0,
				todoRevisions: Object.fromEntries(
					(deps.work?.todoRevisionsInTransaction(tx, conversationId) ?? []).map(
						(row) => [row.id, row.revision],
					),
				),
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
			},
		};
	};
}
