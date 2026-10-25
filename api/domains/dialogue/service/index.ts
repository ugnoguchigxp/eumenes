import { createToolchainCommandHandler } from "./toolchain-command";
import { createSpecialistOps } from "./specialist-commands";
import { flushCancelled } from "./specialist-core";
import { createSpecialistTurnHandler } from "./specialist-turn";
import { createCommandInteractions } from "./command-interactions";
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
import type {
	Run,
	StewardPort,
	AgencyLayerPort,
	ConversationAgentPort,
	GoalsLayerPort,
	WorldContextPort,
} from "../contracts";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { byId, interruptUnfinished, listRuns } from "../repository";
import { workOfRun } from "../repository/work";
import { createAgentSync } from "./agent-sync";
import { DEFAULT_DEADLINE_MS, TERMINAL, type DialogueDeps } from "./context";
import { createGenerationHandler } from "./generation-handler";
import { createWorkLedger } from "./work-ledger";
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
import { executionCommands } from "./execution-command";
import { conversationPrefixPort } from "./conversation-prefix";
import { revokeExecutionNotice } from "./execution-notices";
import type { MusicPort } from "../contracts/music";
import type { ImagePort } from "../contracts/image";
import type { ObjectRecognitionPort } from "../contracts/object-recognition";
const log = getLogger("dialogue");

/** A corrected message is shown as corrected: the log's frozen copy of it is rewritten (section 13). */
function registerCorrectionHook(deps: DialogueDeps) {
	deps.conversation.addCorrectHook?.((db, messageId, at) => {
		const found = deps.conversation.messageInTransaction(db, messageId);
		if (!found) return;
		const { message } = found;
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
	});
}

function registerHandlers(
	deps: DialogueDeps,
	progress: ReturnType<typeof createProgress>,
) {
	deps.queue.registerHandler(createGenerationHandler(deps, progress));
	deps.queue.registerHandler(createToolchainCommandHandler(deps));
	deps.queue.registerHandler(createSpecialistTurnHandler(deps));
}

interface DialogueServiceOptions {
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock?: () => string;
	id?: () => string;
	/** The conversation's active short-term memory: events, episode, work results and window version. */
	continuity: ContinuityService;
	memory?: MemoryService;
	steward?: StewardPort;
	agents?: AgentRuntime;
	music?: MusicPort;
	excalidraw?: ImagePort;
	image?: ImagePort;
	objectRecognition?: ObjectRecognitionPort;
	delegation?: import("../contracts/delegation").DelegationPort;
	worldContext?: WorldContextPort;
	goals?: GoalsLayerPort;
	/** The conversation agent's own state for the main context, and its opportunity when work changes. */
	agency?: AgencyLayerPort;
	/** The conversation agent that answers every generation. */
	conversationAgent: ConversationAgentPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	/** The resource registry and the kinds each toolchain makes; without it the conversation has no resources. */
	resources?: ResourceAccess;
	specialist?: import("../contracts").SpecialistPort;
	/** The operational log file the error report reads (`config.logFile`); no log is read when absent. */
	logFile?: () => string | undefined;
}
export function createDialogueService({
	store,
	conversation,
	larm,
	queue,
	clock = () => new Date().toISOString(),
	id = () => crypto.randomUUID(),
	continuity,
	memory,
	steward,
	agents,
	delegation,
	objectRecognition,
	excalidraw,
	image,
	music,
	worldContext,
	goals,
	agency,
	conversationAgent,
	toolchains,
	resources,
	specialist,
	logFile,
}: DialogueServiceOptions) {
	const deps: DialogueDeps = {
		store,
		conversation,
		larm,
		queue,
		clock,
		id,
		continuity,
		memory,
		steward,
		agents,
		delegation,
		objectRecognition,
		excalidraw,
		image,
		music,
		worldContext,
		goals,
		agency,
		conversationAgent,
		toolchains,
		resources,
		specialist,
	};
	const progress = createProgress(deps);
	const intake = createIntake(deps);
	// Handlers read `deps.interactions`, so it exists before any is registered.
	const interactions = createCommandInteractions(
		deps,
		intake.acceptInTransaction,
	);
	deps.interactions = interactions;
	if (resources) deps.resourceLedger = createResourceLedger(deps);
	deps.work = createWorkLedger(deps);
	const work = deps.work;
	// Forgetting and deleted reports reach the TODOs and their result slots (section 13).
	memory?.registerForgetPurge((db, purge) =>
		work.forgetInTransaction(db, purge.messageIds),
	);
	agents?.registerDataDeletion?.((db, runId) =>
		work.dropRunResultsInTransaction(db, runId),
	);
	registerCorrectionHook(deps);
	registerHandlers(deps, progress);
	const specialistOps = createSpecialistOps(deps);
	const agentSync = createAgentSync(deps);
	const errorReport = createErrorReport({
		store,
		agents,
		logFile: logFile ?? (() => undefined),
	});
	const service = {
		executionCommands: executionCommands(deps),
		/** True while the conversation has a queued or running run (the agency host waits for a quiet moment). */
		conversationHasActiveRunInTransaction: conversationHasActiveRun,
		executionSourceInTransaction: (db: Database, runId: string) =>
			executionSourceInTransaction(deps, db, runId),
		notifyInTransaction: intake.notifyInTransaction,
		revokeExecutionNoticeInTransaction: (db: Database, eventId: string) =>
			revokeExecutionNotice(deps, db, eventId),
		...createOperationPorts(deps),
		interactions,
		/** `GET /api/conversations/:id/resources`: the resources the conversation has met and each message's chips. */
		conversationResources: (conversationId: string) =>
			conversationResources(deps, conversationId),
		/** The conversation's resource ledger (`a<n>`), for the `resources` tool and the screen receipts. */
		resourceLedger: deps.resourceLedger,
		/** The conversation's live specialist session, or null (`GET /api/conversations/:id/specialist`). */
		specialistSession: specialistOps.session,
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
		promptTarget: intake.promptTarget,
		progress: progress.progress,
		subscribeProgress: progress.subscribeProgress,
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
			// Questions past their time and interactions whose run ended are closed after a restart.
			if (toolchains?.bound) await interactions.maintenance();
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
		...conversationPrefixPort(deps, clock),
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
		/**
		 * Stops a run's reply only (a voice turn cut off, muted or given up). A run that handed its work over waits
		 * for that work, whose lifetime is not the reply's: the run and its open TODO stay. Any other run is cancelled.
		 */
		async stopReply(runId: string): Promise<Run | null> {
			const handedOver = store.read((db) =>
				workOfRun(db, runId).some((row) => row.status !== "done"),
			);
			if (handedOver) return store.read((db) => byId(db, runId));
			return service.cancel(runId);
		},
		/** Runs are stopped by the queue's own shutdown; nothing is owned here. */
		async close() {
			await agentSync.close();
			progress.close();
		},
	};
	return service;
}
export type DialogueService = ReturnType<typeof createDialogueService>;
