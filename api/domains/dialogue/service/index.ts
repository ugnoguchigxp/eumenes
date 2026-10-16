import { createToolchainCommandHandler } from "./toolchain-command";
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
import type {
	Run,
	StewardPort,
	GoalsLayerPort,
	WorldContextPort,
} from "../contracts";
import { byId, interruptUnfinished, listRuns, linkAnswer } from "../repository";
import { createAgentSync } from "./agent-sync";
import {
	DEFAULT_DEADLINE_MS,
	GENERATE_KIND,
	TERMINAL,
	type DialogueDeps,
} from "./context";
import { createGenerationHandler } from "./generation-handler";
import { createIntake } from "./intake";
import { endRun, runEndedInTransaction } from "./run-end";
import { createProgress } from "./progress";
import type { MusicPort } from "../contracts/music";
import type { ImagePort } from "../contracts/image";
import type { ObjectRecognitionPort } from "../contracts/object-recognition";
const log = getLogger("dialogue");

export function createDialogueService({
	store,
	conversation,
	larm,
	queue,
	clock = () => new Date().toISOString(),
	id = () => crypto.randomUUID(),
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
	toolchains,
}: {
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock?: () => string;
	id?: () => string;
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
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
}) {
	const deps: DialogueDeps = {
		store,
		conversation,
		larm,
		queue,
		clock,
		id,
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
		toolchains,
	};
	const progress = createProgress(deps);
	const intake = createIntake(deps);
	// Handlers read `deps.interactions`, so it exists before any is registered.
	const interactions = createCommandInteractions(
		deps,
		intake.acceptInTransaction,
	);
	deps.interactions = interactions;
	queue.registerHandler(createGenerationHandler(deps, progress));
	queue.registerHandler(createToolchainCommandHandler(deps));
	const agentSync = createAgentSync(deps);
	const service = {
		linkOperationJobInTransaction(db: Database, runId: string, jobId: string) {
			linkAnswer(db, runId, jobId);
		},
		finishOperationInTransaction(db: Database, runId: string) {
			const run = byId(db, runId);
			if (!run || !["queued", "running"].includes(run.status)) return;
			if (Date.parse(run.deadlineAt!) <= Date.parse(clock())) {
				endRun(deps, db, run, "failed", "deadline_exceeded");
				return;
			}
			const { job } = queue.enqueueInTransaction(db, {
				scope: "dialogue",
				kind: GENERATE_KIND,
				dedupeKey: `operation-answer:${run.id}`,
				payload: { runId },
				subjectRef: runId,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				concurrencyKey: `conversation:${run.conversationId}`,
				deadlineAtMs: Date.parse(run.deadlineAt!),
			});
			linkAnswer(db, runId, job.id);
		},
		interactions,
		promptTarget: intake.promptTarget,
		progress: progress.progress,
		subscribeProgress: progress.subscribeProgress,
		submitVoice: intake.submitVoice,
		submit: intake.submit,
		notify: intake.notify,
		async recover() {
			// Runs without a queue job predate the queue and are interrupted as before.
			await store.write((db) => {
				for (const run of interruptUnfinished(db, clock()))
					runEndedInTransaction(deps, db, run, "interrupted", null);
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
		answerDelivery(runId: string): SpeechDelivery | undefined {
			const run = store.read((db) => byId(db, runId));
			if (run?.status !== "completed" || !run.answerMessageId) return undefined;
			return conversation.message(run.answerMessageId)?.delivery;
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
		/** Runs are stopped by the queue's own shutdown; nothing is owned here. */
		async close() {
			await agentSync.close();
			progress.close();
		},
	};
	return service;
}
export type DialogueService = ReturnType<typeof createDialogueService>;
