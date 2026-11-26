import { clearOffersFromMessage } from "../repository/search-offers";
import {
	registerGeneratedImageObservation,
	type GeneratedImagePort,
} from "./generated-images";
import {
	createDebugDiagnostics,
	type DebugDiagnosticsOptions,
} from "./debug-diagnostics";
import { backgroundDiagnostic } from "./diagnostic-evidence";
import { createSpecialistOps } from "./specialist-commands";
import { activeSpecialistAgentLabel } from "./specialist-intake";
import { flushCancelled } from "./specialist-core";
import { createSpecialistTurnHandler } from "./specialist-turn";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { type AgentRuntime } from "../../agent-runtime";
import {
	acceptedAvatarMotion,
	type DeliveryContext,
	type SpeechDelivery,
} from "../../delivery";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { MemoryService } from "../../memory";
import type { ContinuityService } from "../../continuity";
import { conversationHasActiveRun } from "./active-run";
import {
	hideExcludedInTransaction,
	retractForgottenInput,
} from "./forget-hide";
import {
	createTargetsGate,
	createTargetsHoldHandler,
	type TargetsGate,
} from "./targets-hold";
import { releaseHiddenMessages } from "../repository/forget-hidden";
import type {
	Run,
	StewardPort,
	MemoryTargetPort,
	AgencyLayerPort,
	ConversationAgentPort,
	WorldContextPort,
} from "../contracts";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { byId, interruptUnfinished, listRuns } from "../repository";
import { createAgentSync } from "./agent-sync";
import {
	forgetRetiredTodoTracesInTransaction,
	type RetiredResearchErase,
} from "./retired-todo-traces";
import { DEFAULT_DEADLINE_MS, TERMINAL, type DialogueDeps } from "./context";
import { createCompactionSummaryHandler } from "./compaction-summary";
import { createGenerationHandler } from "./generation-handler";
import {
	conversationResources,
	createResourceLedger,
	type ResourceAccess,
} from "./resource-ledger";
import { withAttachmentNotes } from "./attachment-context";
import { eventText } from "./event-text";
import { createOperationPorts } from "./operation-ports";
import { createIntake } from "./intake";
import { createResubmit } from "./resubmit";
import { endRun, runEndedInTransaction } from "./run-end";
import { createProgress } from "./progress";
import { createErrorReport } from "./error-report";
import { executionSourceInTransaction } from "./execution-source";
import { createSpecialistHost } from "./specialist-host";
import { forgetObservations } from "../repository/specialist-observations";
import { forgetCollaborationState } from "./collaboration-state";
import { executionCommands } from "./execution-command";
import {
	clearRecentInTransaction,
	conversationTaskPort,
} from "./conversation-input";
import { revokeExecutionNotice } from "./execution-notices";
import { createContextInputs } from "./context-inputs";
import type { MusicPort } from "../contracts/music";
import type { ImagePort } from "../contracts/image";
import type { ObjectRecognitionPort } from "../contracts/object-recognition";
const log = getLogger("dialogue");

/** A corrected message is shown as corrected: the log's frozen copy of it is rewritten (section 13). */
function registerCorrectionHook(deps: DialogueDeps) {
	deps.conversation.addCorrectHook?.((db, messageId, at) => {
		clearOffersFromMessage(db, messageId);
		const found = deps.conversation.messageInTransaction(db, messageId);
		if (!found) return;
		const { message } = found;
		deps.contextInputs?.invalidate();
		const text =
			message.role === "user"
				? withAttachmentNotes(message.text, message.attachments)
				: message.text;
		deps.continuity.events.correctMessageInTransaction(
			db,
			messageId,
			eventText(deps, text),
			jstSeconds(Date.parse(at)),
		);
		// The input's copy says the corrected words; the state made from the old ones is made again.
		for (const conversationId of deps.conversation.input.correctUtterancesInTransaction(
			db,
			messageId,
			text,
		))
			deps.conversation.input.dropStatesInTransaction(db, conversationId);
	});
}

/** What follows a change elsewhere: a correction and a forget reach the conversation's input. */
function registerChangeHooks(deps: DialogueDeps) {
	registerCorrectionHook(deps);
	deps.conversation.addRetractHook?.((db, messageId) => {
		clearOffersFromMessage(db, messageId);
		deps.contextInputs?.invalidate();
	});
	registerForgetHook(deps);
}

/**
 * A forget reaches the conversation's input (the conversation input specification, section 11): the forgotten
 * utterances leave it (the recent conversation is cut at the next input when one was inside it), and the state that
 * may have been made from them is made again.
 */
function registerForgetHook(deps: DialogueDeps) {
	deps.memory?.registerForgetPurge?.((db, purge) => {
		deps.contextInputs?.invalidate();
		forgetCollaborationState(db, purge.messageIds);
		forgetObservations(db, purge.messageIds);
		releaseHiddenMessages(db, purge.messageIds);
		const changed = retractForgottenInput(deps, db, purge);
		// A forgotten memory item may stand in the state's records, copied as it was.
		if (purge.itemIds.length) changed.add(purge.conversationId);
		for (const conversationId of changed)
			deps.conversation.input.dropStatesInTransaction(db, conversationId);
	});
}

function registerHandlers(
	deps: DialogueDeps,
	progress: ReturnType<typeof createProgress>,
	targets: TargetsGate,
) {
	deps.queue.registerHandler(createGenerationHandler(deps, progress));
	deps.queue.registerHandler(createTargetsHoldHandler(deps, targets));
	deps.queue.registerHandler(createCompactionSummaryHandler(deps));
	deps.queue.registerHandler(createSpecialistTurnHandler(deps));
}

interface DialogueServiceOptions {
	externalOutput?: import("../contracts/external-output").ExternalOutputPort;
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock?: () => string;
	id?: () => string;
	/** The conversation's active short-term memory: its events, work results among them. */
	continuity: ContinuityService;
	memory?: MemoryService;
	steward?: StewardPort;
	memoryTargets?: MemoryTargetPort;
	agents?: AgentRuntime;
	music?: MusicPort;
	excalidraw?: ImagePort;
	image?: ImagePort;
	generatedImages?: GeneratedImagePort;
	objectRecognition?: ObjectRecognitionPort;
	worldContext?: WorldContextPort;
	debugDiagnostics?: DebugDiagnosticsOptions;
	diagnostics?: DialogueDeps["diagnostics"];
	/** The conversation agent's opportunity when work changes. */
	agency?: AgencyLayerPort;
	/** The conversation agent that answers every generation. */
	conversationAgent: ConversationAgentPort;
	lookup?: DialogueDeps["lookup"];
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	/** The resource registry and the kinds each toolchain makes; without it the conversation has no resources. */
	resources?: ResourceAccess;
	specialist?: import("../contracts").SpecialistPort;
	/** The operational log file the error report reads (`config.logFile`); no log is read when absent. */
	logFile?: () => string | undefined;
}
/** The agency's two calls on a forget it settles: the generations that waited go on, and what it excluded is hidden. */
function createTargetPorts(deps: DialogueDeps, targets: TargetsGate) {
	return {
		/**
		 * The agency settled what it was given to resolve (a forget that named no short reference, and the like): the
		 * conversation's generations, which waited for it, go on. Called after the transaction that settled it.
		 */
		targetsSettled: (conversationId: string) => targets.settled(conversationId),
		/**
		 * The immediate stage of a forget the agency settled: the messages the excluded records stand on leave the
		 * recent conversation, its summaries and the history reads at once. Called in the transaction that excluded them.
		 */
		hideExcludedInTransaction: (
			db: Database,
			input: { messageIds: readonly string[]; itemIds?: readonly string[] },
		) => hideExcludedInTransaction(deps, db, input),
	};
}

/** The user's hand on the recent conversation (`POST /api/conversations/:id/recent/clear`). */
function createRecentPorts(deps: DialogueDeps) {
	return {
		/** The next input starts with no earlier words (nothing is deleted). False while a run is queued or running. */
		clearRecent: async (conversationId: string) => {
			const cleared = await deps.store.write((tx) =>
				clearRecentInTransaction(
					deps,
					tx,
					conversationId,
					Date.parse(deps.clock()),
				),
			);
			if (cleared) log.info("dialogue.input_cut", { reason: "user_cleared" });
			return cleared;
		},
	};
}

export function createDialogueService({
	clock = () => new Date().toISOString(),
	id = () => crypto.randomUUID(),
	debugDiagnostics,
	...options
}: DialogueServiceOptions) {
	const deps: DialogueDeps = { ...options, clock, id };
	const { agents, conversation, larm, logFile, queue, resources, store } = deps;
	if (debugDiagnostics) {
		deps.contextInputs = createContextInputs(deps, debugDiagnostics);
		deps.debugDiagnostics = createDebugDiagnostics(deps, debugDiagnostics);
	}
	const progress = createProgress(deps);
	const intake = createIntake(deps);
	if (resources) deps.resourceLedger = createResourceLedger(deps);
	registerChangeHooks(deps);
	const targets = createTargetsGate();
	registerHandlers(deps, progress, targets);
	registerGeneratedImageObservation(deps);
	const specialistOps = createSpecialistOps(deps);
	const agentSync = createAgentSync(deps);
	const errorReport = createErrorReport({
		store,
		agents,
		logFile: logFile ?? (() => undefined),
	});
	let eraseRetiredResearch: RetiredResearchErase | undefined;
	const service = {
		...createSpecialistHost(deps),
		/** The owner that forgets the research runs a dropped TODO named; registered before `recover`. */
		registerRetiredResearchErase(erase: RetiredResearchErase) {
			eraseRetiredResearch = erase;
		},
		acceptExistingInTransaction: intake.acceptExistingInTransaction,
		executionCommands: executionCommands(deps),
		/** True while the conversation has a queued or running run (the agency host waits for a quiet moment). */
		conversationHasActiveRunInTransaction: conversationHasActiveRun,
		backgroundDiagnosticInTransaction: (db: Database, conversationId: string) =>
			backgroundDiagnostic(deps, db, conversationId),
		executionSourceInTransaction: executionSourceInTransaction.bind(null, deps),
		notifyInTransaction: intake.notifyInTransaction,
		revokeExecutionNoticeInTransaction: (db: Database, eventId: string) =>
			revokeExecutionNotice(deps, db, eventId),
		...createOperationPorts(deps),
		/** `GET /api/conversations/:id/resources`: the resources the conversation has met and each message's chips. */
		conversationResources: (conversationId: string) =>
			conversationResources(deps, conversationId),
		...createRecentPorts(deps),
		...createTargetPorts(deps, targets),
		/** The conversation's resource ledger (`a<n>`), for the `resources` tool and the screen receipts. */
		resourceLedger: deps.resourceLedger,
		/** The conversation's live specialist session, or null (`GET /api/conversations/:id/specialist`). */
		specialistSession: specialistOps.session,
		activeSpecialistAgentLabelInTransaction: (
			db: Database,
			conversationId: string,
		) => activeSpecialistAgentLabel(deps, db, conversationId),
		/** True only for an active or suspended session that has not expired (the guard of the work's screen operations). */
		specialistSessionLiveInTransaction: specialistOps.liveInTransaction,
		/** return / resume / discard / close from the screen: idempotent by requestId, guarded by the revision. */
		specialistCommand: specialistOps.command,
		specialistRetarget: specialistOps.retarget,
		/**
		 * The application's periodic sweep: ends sessions past their expiry, retries closing ones and ends
		 * suspended work that was saved meanwhile. The InTransaction form returns what to flush after commit.
		 */
		sweepSpecialistSessions: specialistOps.sweep,
		sweepSpecialistSessionsInTransaction: specialistOps.sweepInTransaction,
		/** At startup every session that is not ended ends as `restarted` (unsaved work does not survive). */
		recoverSpecialistSessions: specialistOps.recover,
		recoverSpecialistSessionsInTransaction: specialistOps.recoverInTransaction,
		/** After the commit of an InTransaction form: abort the jobs and requests it cancelled. */
		flushSpecialistCancellations(cancelled: {
			jobs: string[];
			runs: string[];
		}) {
			flushCancelled(deps, cancelled.jobs, cancelled.runs);
		},
		/** The diagnostic text of a failed run (`GET /api/runs/:id/error-report`). */
		errorReport,
		debugDiagnostics: deps.debugDiagnostics,
		contextInputs: deps.contextInputs,
		promptTarget: intake.promptTarget,
		progress: progress.progress,
		subscribeProgress: progress.subscribeProgress,
		subscribeAnswerStream: progress.subscribeAnswerStream,
		submitVoice: intake.submitVoice,
		submit: intake.submit,
		/** The latest utterance stopped, corrected and answered again (`POST .../messages/:id/resubmit`). */
		resubmit: createResubmit(deps).resubmit,
		notify: intake.notify,
		async recover() {
			// Runs without a queue job predate the queue and are interrupted as before.
			await store.write((db) => {
				for (const run of interruptUnfinished(db, clock()))
					runEndedInTransaction(deps, db, run, "interrupted");
			});
			// What the dropped TODO ledger made elsewhere is forgotten once.
			const forgotten = await store.write((db) =>
				forgetRetiredTodoTracesInTransaction(deps, db, eraseRetiredResearch),
			);
			if (forgotten > 0)
				log.info("dialogue.retired_todo_traces_forgotten", {
					count: forgotten,
				});
		},
		get(runId: string) {
			return store.read((db) => byId(db, runId));
		},
		/** Wait for a terminal run: re-reads the DB, honours the abort signal and an overall deadline. */
		async waitForTerminal(
			runId: string,
			options: {
				signal?: AbortSignal;
				timeoutMs?: number;
				pollMs?: number;
			} = {},
		): Promise<Run | null> {
			const read = () => store.read((db) => byId(db, runId));
			const first = read();
			if (!first || TERMINAL.includes(first.status) || options.signal?.aborted)
				return first;
			return await new Promise<Run | null>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					stop();
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", finish);
					resolve(read());
				};
				const stop = store.onCommit(() => {
					const run = read();
					if (!run || TERMINAL.includes(run.status)) finish();
				});
				const timer = setTimeout(
					finish,
					options.timeoutMs ?? DEFAULT_DEADLINE_MS + 10000,
				);
				options.signal?.addEventListener("abort", finish, { once: true });
				const current = read();
				if (
					!current ||
					TERMINAL.includes(current.status) ||
					options.signal?.aborted
				)
					finish();
			});
		},
		recordAnswerDeliveryInTransaction(
			db: Database,
			runId: string,
			delivery: SpeechDelivery,
		): boolean {
			const run = byId(db, runId);
			const motion = acceptedAvatarMotion(delivery);
			if (!run || !["running", "completed"].includes(run.status)) return false;
			if (delivery.version === 2)
				return conversation.recordAnswerDeliveryInTransaction(
					db,
					runId,
					run.conversationId,
					delivery,
				);
			if (!motion) return false;
			return conversation.recordAnswerMotionInTransaction(
				db,
				runId,
				run.conversationId,
				motion,
			);
		},
		answerContext(runId: string): DeliveryContext | null {
			const run = store.read((db) => byId(db, runId));
			if (!run || !["running", "completed"].includes(run.status)) return null;
			const answer = run.answerMessageId
				? conversation.message(run.answerMessageId)
				: null;
			// Later queued user messages must not leak into this answer's decision.
			const input = conversation.message(run.inputMessageId);
			const before = conversation.turnsBefore(
				run.conversationId,
				run.inputMessageId,
				3,
			);
			return {
				answer: answer?.text ?? progress.progress(runId)?.text ?? "",
				turns: (input ? [...before, input] : before).map(({ role, text }) => ({
					role,
					text,
				})),
			};
		},
		...conversationTaskPort(deps),
		answerDelivery(runId: string): SpeechDelivery | undefined {
			const run = store.read((db) => byId(db, runId));
			if (run?.status !== "completed" || !run.answerMessageId) return undefined;
			return conversation.message(run.answerMessageId)?.delivery;
		},
		/** A runless assistant message with a host-chosen delivery (agency utterance), else null. */
		hostMessageDelivery(
			messageId: string,
		): { text: string; delivery: SpeechDelivery } | null {
			const message = conversation.message(messageId);
			if (
				!message ||
				message.role !== "assistant" ||
				message.runId !== null ||
				message.delivery?.source !== "host"
			)
				return null;
			return { text: message.text, delivery: message.delivery };
		},
		answerText(runId: string): string | null {
			const run = store.read((db) => byId(db, runId));
			return run?.answerMessageId
				? (conversation.message(run.answerMessageId)?.text ?? null)
				: null;
		},
		list(conversationId: string) {
			return store.read((db) => listRuns(db, conversationId));
		},
		async cancel(runId: string): Promise<Run | null> {
			const current = store.read((db) => byId(db, runId));
			if (!current) return null;
			if (current.status !== "queued" && current.status !== "running")
				return current;
			log.info("dialogue.cancel_requested", {
				runId,
				jobId: current.jobId ?? undefined,
				requestId: current.requestId,
			});
			if (current.agentTaskId && agents) {
				await store.write((db) => {
					const row = byId(db, runId);
					if (!row || TERMINAL.includes(row.status)) return;
					agents.cancelTreeInTransaction(db, runId);
					if (row.jobId)
						queue.cancelInTransaction(db, row.jobId, "cancel_requested");
					endRun(deps, db, row, "cancelled", "cancel_requested");
				});
				if (current.jobId) queue.flushCancellations([current.jobId]);
			} else if (current.jobId) await queue.cancel(current.jobId);
			await larm.cancelSubject?.(runId);
			// No job (legacy) or the job already ended without settling the run.
			if (
				store.read((db) => byId(db, runId))?.status === "queued" ||
				store.read((db) => byId(db, runId))?.status === "running"
			)
				await store.write((db) => {
					const row = byId(db, runId);
					if (row && (row.status === "queued" || row.status === "running"))
						endRun(deps, db, row, "cancelled", "cancel_requested");
				});
			return store.read((db) => byId(db, runId));
		},
		/** Stops a run's reply only (a voice turn cut off, muted or given up): the run is cancelled. */
		async stopReply(runId: string): Promise<Run | null> {
			return service.cancel(runId);
		},
		/** Runs are stopped by the queue's own shutdown; nothing is owned here. */
		async close() {
			deps.debugDiagnostics?.close();
			deps.contextInputs?.close();
			await agentSync.close();
			progress.close();
		},
	};
	return service;
}
export type DialogueService = ReturnType<typeof createDialogueService>;
