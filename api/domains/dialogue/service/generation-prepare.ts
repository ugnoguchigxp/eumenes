import { offerContext } from "./conversation-offers";
import type { InputOrigin } from "../../../infrastructure/model-input";
import { answerMessages } from "./answer-input";
import { generatedImageLines } from "./generated-image-text";
import { reservePendingImageObservations } from "./generated-images";
import type { Database } from "bun:sqlite";
import { recentDiagnostics } from "./diagnostic-evidence";
import { getLogger } from "../../../infrastructure/logger";
import type { WindowSnapshot } from "../../memory";
import type { ConversationEvent } from "../../continuity";
import {
	REFERENCE_WINDOW_TOKENS,
	estimateTextTokens,
	planWindow,
} from "../../inference";
import { exchangeEnd } from "../../../infrastructure/context-budget";
import type { HandlerDefinition } from "../../queue";
import { isSystemPrompt, type Run } from "../contracts";
import { byId, transition } from "../repository";
import { liveSession } from "../repository/specialist";
import { withAttachmentNotes } from "./attachment-context";
import {
	DEFAULT_DEADLINE_MS,
	type ChatMessage,
	type DialogueDeps,
	type FinalMessage,
	type GenerateInput,
	type GeneratePayload,
	type RoutedInput,
} from "./context";
import {
	conversationPrefixFrom,
	conversationSystem,
	placeCutInTransaction,
	inputMessageRevision,
	workingLimits,
	type ConversationPrefix,
} from "./conversation-input";
import { localHarness, routeConversation } from "./harness";
import { INPUT_HEADINGS, dataText, lineText } from "./input-text";
import { answerTicketInTransaction } from "./result-intake";
import { endRun } from "./run-end";
import {
	stateProjectionInTransaction,
	agencyStateLines,
	stateText,
} from "./state-text";
import { ASK_STEP } from "./tool-exchange";
import { screenLinesInTransaction } from "./resource-context";
import { preparedMemoryInTransaction } from "./memory-refs";
import { recordPromptSources } from "./generation-prepare-sources";
import { parkGenerationInTransaction } from "./targets-hold";

const log = getLogger("dialogue");

/** A gap this long since the last delivery is a break in the talk (section 7.3). */
export const TALK_BREAK_MS = 2 * 60 * 1000;

/**
 * Where the answer's messages split for a provider that keeps a history (the call's `context`): the one system
 * message, then the adopted conversation, then this turn's input. The turn joins the prefix's last message when that
 * one is the user's (`withLastMessage`), so that message is the turn's, not history. The first history message holds
 * `## Memory` (alone, or in front of the opening utterance): it is protected, with the answer to the opening
 * utterance when they are one message, so a list over the window loses the oldest exchanges and never the memory.
 */
export function answerSessionContext(
	prefix: Pick<ConversationPrefix, "messages">,
) {
	const { messages } = prefix;
	const joinsLast = messages.length > 1 && messages.at(-1)!.role === "user";
	const historyCount = messages.length - 1 - (joinsLast ? 1 : 0);
	const holdsMemory =
		historyCount > 0 &&
		messages[1]!.role === "user" &&
		messages[1]!.content.startsWith(INPUT_HEADINGS.memory);
	// The memory/summary message stays with the entire opening exchange after it (including any tool_calls + tool
	// results), so trimming never orphans a tool message or leaves two user messages in a row.
	const historyRoles = messages
		.slice(1, 1 + historyCount)
		.map((message) => message.role);
	const protectedCount = holdsMemory
		? exchangeEnd(historyRoles, 0, historyCount)
		: 0;
	return {
		instructionCount: 1,
		historyCount,
		...(protectedCount ? { protectedCount } : {}),
	};
}

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
	traceInput?: boolean,
): {
	texts: string[];
	final: FinalMessage;
	attachments: Pick<ChatMessage, "attachments" | "sourceMessageId">;
	origins?: InputOrigin[];
} {
	if (pending.length === 0)
		return { texts: [], final: { kind: "fixed" }, attachments: {} };
	const texts: string[] = [];
	const origins: InputOrigin[] | undefined = traceInput ? [] : undefined;
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
		origins?.push({
			kind: "user",
			id: found.message.id,
			at: found.message.createdAt,
			...inputMessageRevision(deps, tx, found.message.id),
		});
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
		origins,
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

function noticeForAnswer(
	notAdopted: boolean,
	hostNote: string | null,
	noticeText: string | null,
	unresolved: ReadonlyArray<{ what: string }>,
) {
	return [
		...unresolved.map(
			({ what }) =>
				`「${lineText(what)}」の対象を決められず、何も変えていません。`,
		),
		...(notAdopted
			? [
					"前の返事は届けられませんでした。すでに頼んだ仕事は「## State」の assignments にあります。",
				]
			: []),
		...(hostNote ? [dataText(hostNote)] : []),
		...(noticeText !== null ? noticeLines(noticeText) : []),
	];
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

/** The user's utterances of the run's own input, handled or not: what a generation that was not delivered answers again. */
function ownUtterances(
	events: DialogueDeps["continuity"]["events"],
	tx: Database,
	run: Run,
): ConversationEvent[] {
	return events
		.ofMessageInTransaction(tx, run.inputMessageId)
		.filter(
			(event) =>
				event.conversationId === run.conversationId &&
				event.type === "said" &&
				event.by === "user" &&
				!event.forgotten,
		);
}

/** The trigger of a generation: the utterances it handles, or what a host notice says. */
function triggerOf(
	run: Run,
	pending: readonly ConversationEvent[],
	noticeText: string | null,
	hostNote: string | null,
	notAdopted: boolean,
): Array<Record<string, unknown>> {
	const trigger: Array<Record<string, unknown>> = [];
	// The earlier generation acted and was not adopted (section 13): the log and the assignments show what it did.
	if (notAdopted) trigger.push({ kind: "not_adopted" });
	if (hostNote) trigger.push({ kind: "host_note", text: hostNote });
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

/** How long after the agent asked back the user's next words are taken as the answer to it. */
const ASKED_MS = 5 * 60 * 1000;
/**
 * The toolchain a hand-over waits for the user's word on (unsaved work stands in its way), offered without a search.
 * The answer to that question ("discard it") names nothing a search with its words would find.
 */
function switchingCardInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
): GenerateInput["switching"] {
	const switching = liveSession(tx, conversationId)?.pendingSwitch?.toolchainId;
	const revision = switching
		? deps.toolchains
				?.catalogInTransaction(tx)
				.find((entry) => entry.id === switching)?.revisionId
		: undefined;
	return (
		(revision ? deps.toolchains?.cardInTransaction(tx, revision) : undefined) ??
		null
	);
}

/** The excerpts shown to argument extraction from the agent's reply and earlier user utterances. */
const PREVIOUS_REPLY_CHARS = 200;

/** The host records needed by the conversation tools and argument extraction. */
function routedInputInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: {
		conversationId: string;
		nowMs: number;
		state: ReturnType<typeof stateProjectionInTransaction>;
		media: readonly { line: string }[];
		diagnostics: readonly { line: string; ref: string }[];
		lastAgent: {
			text: string;
			at: string;
			toolCalls?: ReadonlyArray<{ name: string; arguments: string }>;
		} | null;
		prefix: Pick<ConversationPrefix, "memory" | "earlier">;
	},
): RoutedInput {
	const { lastAgent } = input;
	const askStep = lastAgent?.toolCalls?.find((call) => call.name === ASK_STEP);
	let asked: RoutedInput["asked"] = null;
	if (askStep && input.nowMs - Date.parse(lastAgent!.at) <= ASKED_MS) {
		try {
			const request = (JSON.parse(askStep.arguments) as { request?: unknown })
				.request;
			if (typeof request === "string" && request.trim()) asked = { request };
		} catch {
			// A step it cannot read asks nothing.
		}
	}
	return {
		memory: input.prefix.memory,
		// Words with no text (a voice message left empty) name nothing a request could point to.
		earlier: input.prefix.earlier
			.map((said) => lineText(said).slice(0, PREVIOUS_REPLY_CHARS))
			.filter((said) => said.trim()),
		state: stateText([
			...input.state.lines,
			...input.media.map(({ line }) => line),
			...input.diagnostics.map(({ line }) => line),
		]),
		diagnosticRefs: input.diagnostics.map(({ ref }) => ref),
		previousReply: lastAgent
			? lineText(lastAgent.text).slice(0, PREVIOUS_REPLY_CHARS)
			: null,
		asked,
		resources: input.state.resources,
		switching:
			liveSession(tx, input.conversationId)?.pendingSwitch?.toolchainId ?? null,
		switchTarget:
			liveSession(tx, input.conversationId)?.pendingSwitch?.targetRef ?? null,
	};
}

/** The run's LARM request on the conversation's routes, taken once when its settings snapshot is there. */
function captureLlmRoute(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	deadlineAtMs: number | null | undefined,
) {
	const { larm } = deps;
	if (!larm.captureInTransaction || larm.requestFor?.(tx, runId, "llm")) return;
	const snapshot = larm.snapshotInTransaction?.(tx);
	if (!snapshot) return;
	routeConversation(snapshot);
	for (const p of ["asr", "tts"] as const)
		snapshot.routes[p] = {
			...snapshot.routes[p],
			mode: "larm-only",
			cloudAllowed: false,
		};
	larm.captureInTransaction(
		tx,
		runId,
		"llm",
		deadlineAtMs ?? Date.now() + DEFAULT_DEADLINE_MS,
		snapshot,
	);
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
	const { conversation, larm, clock, memory } = deps;
	const events = deps.continuity.events;
	return (tx, claim) => {
		const run = byId(tx, claim.payload.runId);
		if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
			return { status: "stale", reason: "run_not_queued" };
		// A forget the agency has not settled yet would still be in this prompt: the run waits behind it.
		if (parkGenerationInTransaction(deps, tx, run, claim))
			return { status: "stale", reason: "targets_pending" };
		if (!transition(tx, run.id, run.revision, "running", clock()))
			return { status: "stale", reason: "run_changed" };
		const current = byId(tx, run.id) as Run;
		const conversationId = run.conversationId;
		const nowMs = Date.parse(clock());
		const agent = answerTicketInTransaction(deps, tx, current);
		// A host notice speaks about what happened; a user's or a schedule's input is a pending utterance.
		const notice = run.sourceKind === "notice";
		const waiting = notice
			? []
			: events.pendingInTransaction(tx, conversationId);
		// The earlier generation handled the run's utterance with its first action (a request to the memory) and was not
		// delivered: the reply is still the answer to that request, so it stays the input, not a line of the history.
		const notAdopted = claim.payload.notAdopted === true;
		const pending =
			notAdopted && !notice && waiting.length === 0
				? ownUtterances(events, tx, current)
				: waiting;
		// A host note (a specialist switch to confirm) is this run's trigger.
		const hostNote = claim.payload.commandNote ?? null;
		if (!notice && !hostNote && !notAdopted && pending.length === 0) {
			// An earlier generation handled this utterance already.
			endRun(deps, tx, current, "cancelled", "utterance_handled");
			return { status: "stale", reason: "utterance_handled" };
		}
		const failPrepare = (reason: string) => {
			endRun(deps, tx, current, "failed", reason);
			return { status: "stale" as const, reason };
		};
		let window: WindowSnapshot | null = null;
		try {
			window = memory?.windowForRunInTransaction(tx, conversationId) ?? null;
		} catch (error) {
			if (error instanceof Error && error.message === "memory_blocked")
				return failPrepare("memory_blocked");
			throw error;
		}
		captureLlmRoute(deps, tx, run.id, claim.deadlineAtMs);
		const requestId = larm.requestFor?.(tx, run.id, "llm");
		const harness = localHarness;
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		if (requestId)
			try {
				larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
			} catch (error) {
				if (error instanceof Error && error.message === "permission_revoked")
					return failPrepare("permission_revoked");
				throw error;
			}
		const system = conversationSystem(deps, tx, conversationId);
		const fixed = estimateTextTokens(system);
		const plan = planWindow({ window: windowOf(deps, tx, run.id), fixed });
		if (!plan.usable) return failPrepare("window_too_small");
		const pendingIds = new Set(pending.flatMap((event) => event.messageIds));
		// The recent conversation is cut by the host's fixed rules before it is drawn (section 6.1.1).
		const limits = workingLimits(plan);
		const placed = placeCutInTransaction(deps, tx, conversationId, {
			system,
			window,
			nowMs,
			pending: pendingIds,
			limits,
		});
		window = placed.window;
		if (placed.reason)
			log.info("dialogue.input_cut", { reason: placed.reason, runId: run.id });
		const prefix = conversationPrefixFrom(deps, tx, conversationId, {
			harness,
			system,
			window,
			pending: pendingIds,
			traceInput: deps.contextInputs?.enabled(),
			assignRefs: true,
		});
		const { texts, final, attachments, origins } = pendingInput(
			deps,
			tx,
			pending,
			deps.contextInputs?.enabled(),
		);
		// The images the agency's assignments made are looked at once; what was seen of them is told below.
		if (!notice) reservePendingImageObservations(deps, tx, conversationId);
		const media = notice
			? []
			: generatedImageLines(deps, tx, conversationId, prefix.since);
		const observeInput = deps.contextInputs?.begin(tx, current, placed.reason);
		const noticeText = notice
			? (conversation.messageInTransaction(tx, run.inputMessageId)?.message
					.text ?? null)
			: null;
		// What the agency could not settle of the user's forgets and corrections: told once, nothing was changed.
		const unresolved =
			deps.steward?.takeUnresolvedTargetsInTransaction(tx, conversationId) ??
			[];
		const noticeBody = noticeForAnswer(
			notAdopted,
			hostNote,
			noticeText,
			unresolved,
		);
		const lastAgent =
			[...prefix.recent].reverse().find((u) => u.speaker === "agent") ?? null;
		const screenLines = screenLinesInTransaction(deps, tx, current);
		const state = stateProjectionInTransaction(deps, tx, {
			conversationId,
			run: current,
			screenLines,
			agencyLines: [],
			nowMs,
			lastAt: prefix.lastAt,
			lastAgent,
			state: deps.conversation.input.latestStateInTransaction(
				tx,
				conversationId,
			),
			...(claim.payload.specialistHandoff
				? { handoff: handoffLine(claim.payload.specialistHandoff) }
				: {}),
		});
		const diagnostics = notice
			? []
			: recentDiagnostics(deps, tx, conversationId);
		const userTurn =
			final.kind === "utterances" && !isSystemPrompt(current.sourceKind);
		const { offers, sources } = userTurn
			? offerContext(deps, tx, conversationId, state.lines)
			: { offers: [], sources: [] };
		recordPromptSources(deps, tx, {
			runId: run.id,
			conversationId,
			prefix,
			pendingIds: new Set([...pendingIds, ...sources]),
			media,
			notAdopted,
		});
		// Scheduled prompts can receive an answer but carry no authority to control or start work.
		const routed = userTurn
			? routedInputInTransaction(deps, tx, {
					conversationId,
					nowMs,
					state,
					media,
					diagnostics,
					lastAgent,
					prefix,
				})
			: undefined;
		const viewing = screenLines.map(({ text }) => text);
		const screenState = viewing.length ? ["提示中:", ...viewing] : [];
		const messages = answerMessages(prefix, {
			stateLines: routed
				? state.lines
				: [...state.lines.slice(0, 1), ...screenState],
			askedRequest: routed?.asked?.request,
			agencyLines: agencyStateLines(deps, tx, conversationId),
			media,
			diagnostics,
			notice: noticeBody,
			texts,
			attachments,
			trace: observeInput
				? { nowMs, noticeId: notice ? run.inputMessageId : undefined, origins }
				: undefined,
		});
		const shownForMemory = [
			...new Set([
				...(final.kind === "utterances" ? final.messageIds : []),
				...(prefix.summarySourceRefs ?? []).filter((ref) => !ref.includes(":")),
			]),
		];
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
				limits,
				messages,
				...(observeInput ? { observeInput } : {}),
				utterances: texts,
				...(routed ? { routed } : {}),
				final,
				trigger: triggerOf(current, pending, noticeText, hostNote, notAdopted),
				...(agent ? { agent } : {}),
				memoryItemIds: prefix.memoryItemIds,
				cut: placed.reason,
				inputRevision: prefix.cut?.revision ?? 0,
				offers,
				switching: switchingCardInTransaction(deps, tx, conversationId),
				sessionContext: answerSessionContext(prefix),
				...(window && memory && prefix.refsKey
					? {
							memory: preparedMemoryInTransaction(memory, tx, {
								window,
								shownMessageIds: shownForMemory,
								refsKey: prefix.refsKey,
							}),
						}
					: {}),
			},
		};
	};
}
