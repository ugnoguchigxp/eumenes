import { delegationContext } from "./confirmation-revisions";
import { workContextInput } from "./work-context-input";
import type { InputOrigin } from "../../../infrastructure/model-input";
import { answerMessages } from "./answer-input";
import { generatedImageLines } from "./generated-image-text";
import { backgroundInput } from "./background-input";
import type { Database } from "bun:sqlite";
import { recentDiagnostics } from "./diagnostic-evidence";
import { reportNoticeInTransaction } from "./report-notice";
import { getLogger } from "../../../infrastructure/logger";
import type { ConversationEvent } from "../../continuity";
import {
	REFERENCE_WINDOW_TOKENS,
	estimateTextTokens,
	planWindow,
} from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { isSystemPrompt, type Run } from "../contracts";
import { byId, transition } from "../repository";
import { agencyWork } from "../repository/agency";
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
import type { DocumentRefs } from "./work-items";
import {
	conversationPrefixFrom,
	conversationSystem,
	placeCutInTransaction,
	inputMessageRevision,
	type ConversationPrefix,
} from "./conversation-input";
import { localHarness, routeConversation } from "./harness";
import { dataText, lineText } from "./input-text";
import {
	consumeAnswer,
	answerTicketInTransaction,
	intakeInTransaction,
} from "./result-intake";
import { resultText } from "./result-text";
import { acceptRunAnswer, endRun } from "./run-end";
import { finishReportedWork } from "./generation-settle";
import { workOfRun, type WorkRow } from "../repository/work";
import {
	madeOf,
	stateProjectionInTransaction,
	agencyStateLines,
	stateText,
} from "./state-text";
import { ASK_STEP } from "./tool-exchange";
import { taskTargets } from "./task-work";
import { screenLinesInTransaction } from "./resource-context";

const log = getLogger("dialogue");

/** A gap this long since the last delivery is a break in the talk (section 7.3). */
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
	results: string[],
	noticeText: string | null,
) {
	return [
		...(notAdopted
			? [
					"前の返事は届けられませんでした。すでに頼んだ仕事は「## State」の仕事にあります。",
				]
			: []),
		...(hostNote ? [dataText(hostNote)] : []),
		...results,
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

/** How long after the agent asked back the user's next words are taken as the answer to it. */
const ASKED_MS = 5 * 60 * 1000;
/**
 * The toolchains this generation may hand over to without a search: those of the work in progress, and the one a
 * hand-over waits for the user's word on (unsaved work stands in its way). The answer to that question ("discard
 * it") names nothing a search with its words would find.
 */
function retainedInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
): GenerateInput["retained"] {
	const retained = deps.work?.retainedInTransaction(tx, conversationId) ?? [];
	const switching = liveSession(tx, conversationId)?.pendingSwitch?.toolchainId;
	if (!switching || retained.some((entry) => entry.card.id === switching))
		return retained;
	const revision = deps.toolchains
		?.catalogInTransaction(tx)
		.find((entry) => entry.id === switching)?.revisionId;
	const card = revision
		? deps.toolchains?.cardInTransaction(tx, revision)
		: undefined;
	return card
		? [...retained, { card, summary: card.summary, last: "" }]
		: retained;
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
		revisions: RoutedInput["pending"]["revisions"];
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
	const todos =
		deps.work
			?.todosInTransaction(tx, input.conversationId)
			.filter((todo) => todo.status !== "done") ?? [];
	// The finished work `## State` lists may be checked, as it shows them (a forgotten one has no title).
	// The agency reports its own research in notes and keeps it outside the user's work controls.
	const own = (row: { runId: string } | null | undefined) =>
		!!row && !!agencyWork(tx, row.runId);
	const finished = input.state.todos.flatMap((ref) => {
		if (todos.some((todo) => todo.ref === ref)) return [];
		const row = deps.work?.workByRefInTransaction(
			tx,
			input.conversationId,
			ref,
		);
		return row?.title && !own(row)
			? [
					{
						ref,
						title: row.title,
						open: false,
						...taskTargets(deps, tx, row),
					},
				]
			: [];
	});
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
		pending: {
			revisions: input.revisions,
			confirmations: (
				deps.work?.pendingConfirmationsInTransaction(
					tx,
					input.conversationId,
				) ?? []
			).map((c) => ({
				ref: c.ref,
				toolchain: c.toolchain,
				request: c.request,
				target: c.target,
			})),
			questions: todos.flatMap((todo) =>
				todo.status === "waiting" && todo.question
					? [{ ref: todo.ref, title: todo.title, question: todo.question }]
					: [],
			),
		},
		todos: [
			...todos.flatMap((todo) => {
				const row = deps.work?.workInTransaction(tx, todo.id);
				return own(row)
					? []
					: [
							{
								ref: todo.ref,
								title: todo.title,
								request: row?.request,
								open: true,
								...taskTargets(deps, tx, row),
							},
						];
			}),
			...finished,
		],
		resources: input.state.resources,
		switching:
			liveSession(tx, input.conversationId)?.pendingSwitch?.toolchainId ?? null,
		switchTarget:
			liveSession(tx, input.conversationId)?.pendingSwitch?.targetRef ?? null,
	};
}

function recordPromptSources(
	deps: DialogueDeps,
	tx: Database,
	{
		runId,
		conversationId,
		prefix,
		pendingIds,
		media,
		notAdopted,
	}: {
		runId: string;
		conversationId: string;
		prefix: ConversationPrefix;
		pendingIds: ReadonlySet<string>;
		media: ReadonlyArray<{ workId: string }>;
		notAdopted: boolean;
	},
) {
	const memory = deps.memory;
	if (!memory?.referenceInputs) return;
	const context = backgroundInput(deps, tx, conversationId, prefix);
	const pendingInput = memory.referenceInputs.captureInTransaction(tx, {
		messageIds: [...pendingIds],
	});
	const mediaInputs = media.map(({ workId }) =>
		workContextInput(deps, tx, workId, "image-observation"),
	);
	memory.referenceInputs.recordRunInTransaction(
		tx,
		runId,
		{
			sources: [
				...new Set([
					...context.sources,
					...pendingInput.sources,
					...mediaInputs.flatMap((entry) => entry?.sources ?? []),
				]),
			],
			complete:
				context.complete &&
				pendingInput.complete &&
				mediaInputs.every((entry) => entry?.complete),
		},
		// An already committed work item still inherits the sources of the attempt that created it.
		{ replace: notAdopted && workOfRun(tx, runId).length === 0 },
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
		const intake = intakeInTransaction(deps, tx, current, claim.payload);
		const changed = intake?.rows ?? null;
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
			finishReportedWork(deps, tx, current, notice ? intake : null);
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
		const harness = localHarness;
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		const system = conversationSystem(deps, tx, conversationId);
		const fixed = tokens(system);
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
		});
		const { texts, final, attachments, origins } = pendingInput(
			deps,
			tx,
			pending,
			deps.contextInputs?.enabled(),
		);
		const media = notice
			? []
			: generatedImageLines(deps, tx, conversationId, prefix.since);
		const observeInput = deps.contextInputs?.begin(tx, current, placed.reason);
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
		const noticeBody = noticeForAnswer(
			notAdopted,
			hostNote,
			results,
			noticeText,
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
		});
		const diagnostics = notice
			? []
			: recentDiagnostics(deps, tx, conversationId);
		const userTurn =
			final.kind === "utterances" && !isSystemPrompt(current.sourceKind);
		const { offers, revisions, sources } = userTurn
			? delegationContext(deps, tx, conversationId, state.lines)
			: { offers: [], revisions: [], sources: [] };
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
					revisions,
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
				...(observeInput ? { observeInput } : {}),
				utterances: texts,
				...(routed ? { routed } : {}),
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
				offers,
				retained: retainedInTransaction(deps, tx, conversationId),
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
