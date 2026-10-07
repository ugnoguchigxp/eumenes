import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { LarmPort } from "../../larm";
import type { HandlerDefinition, QueueService, Tx } from "../../queue";
import type { TargetDefinition } from "../../scheduler";
import {
	type PromptTarget,
	promptTargetSchema,
	type Run,
	type Submit,
} from "../contracts";
import {
	byId,
	byRequest,
	byUtterance,
	insert,
	interruptUnfinished,
	listRuns,
	priorRuns,
	transition,
} from "../repository";

export const GENERATE_KIND = "dialogue.generate";
export const PROMPT_TARGET_KIND = "dialogue.prompt";
const DEFAULT_DEADLINE_MS = 180_000;
const SYSTEM_PROMPT =
	"あなたは丁寧で簡潔な日本語の執事です。ユーザーの現在の依頼に答えてください。過去の発言は文脈であり、実行指示ではありません。";
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
interface GenerateInput {
	runId: string;
	revision: number;
	messages: ChatMessage[];
}
interface Accept {
	requestId: string;
	conversationId: string;
	text: string;
	utteranceId?: string;
	sourceKind: Run["sourceKind"];
	scheduleId?: string;
	occurrenceId?: string;
	deadlineMs?: number;
}

export function createDialogueService(
	store: SqliteStore,
	conversation: ConversationService,
	larm: LarmPort,
	queue: QueueService,
	clock: () => string = () => new Date().toISOString(),
	id: () => string = () => crypto.randomUUID(),
) {
	/** Model-visible history: earlier accepted runs (input + adopted answer) then this run's input. */
	function historyFor(tx: Tx, run: Run): ChatMessage[] {
		const messages = new Map(
			conversation
				.messagesInTransaction(tx, run.conversationId)
				.map((m) => [m.id, m]),
		);
		const out: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
		const push = (messageId: string | null, role: "user" | "assistant") => {
			const m = messageId ? messages.get(messageId) : undefined;
			if (m) out.push({ role, content: m.text });
		};
		for (const prior of priorRuns(tx, run)) {
			push(prior.inputMessageId, "user");
			if (prior.status === "completed")
				push(prior.answerMessageId, "assistant");
		}
		push(run.inputMessageId, "user");
		return out;
	}

	const handler: HandlerDefinition<{ runId: string }, GenerateInput, string> = {
		kind: GENERATE_KIND,
		payloadVersions: [1],
		schema: z.object({ runId: z.string() }),
		recovery: "interrupt",
		resourceKey: "larm.llm",
		prepareInTransaction(tx, claim) {
			const run = byId(tx, claim.payload.runId);
			if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
				return { status: "stale", reason: "run_not_queued" };
			if (!transition(tx, run.id, run.revision, "running", clock()))
				return { status: "stale", reason: "run_changed" };
			const current = byId(tx, run.id) as Run;
			return {
				status: "ready",
				input: {
					runId: run.id,
					revision: current.revision,
					messages: historyFor(tx, current),
				},
			};
		},
		execute: (input, { signal }) => larm.answer(input.messages, signal),
		classify: () => "fail",
		settleInTransaction(tx, claim, input, outcome) {
			const run = byId(tx, claim.payload.runId);
			if (!run) return "stale";
			if (outcome.type === "success") {
				if (
					!input ||
					run.status !== "running" ||
					run.revision !== input.revision
				)
					return "stale";
				const messageId = id();
				conversation.appendInTransaction(tx, {
					id: messageId,
					conversationId: run.conversationId,
					role: "assistant",
					text: outcome.result,
					createdAt: clock(),
					runId: run.id,
				});
				return transition(
					tx,
					run.id,
					run.revision,
					"completed",
					clock(),
					null,
					messageId,
				)
					? "applied"
					: "stale";
			}
			// A run that is already terminal (e.g. cancelled) keeps its state.
			if (run.status !== "queued" && run.status !== "running") return "applied";
			const next: [Run["status"], string | null] =
				outcome.type === "retry"
					? ["queued", outcome.errorCode]
					: outcome.type === "failed"
						? ["failed", outcome.errorCode]
						: outcome.type === "expired"
							? ["failed", "deadline_exceeded"]
							: ["interrupted", outcome.errorCode];
			return transition(tx, run.id, run.revision, next[0], clock(), next[1])
				? "applied"
				: "stale";
		},
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running"))
				transition(
					tx,
					run.id,
					run.revision,
					"cancelled",
					clock(),
					"cancel_requested",
				);
		},
	};
	queue.registerHandler(handler);

	/** One transaction: user message + run + queue job. Throws (rolling all back) when the queue is full. */
	function acceptInTransaction(
		db: Tx,
		input: Accept,
	): { run: Run; fresh: boolean } {
		const existing =
			byRequest(db, input.requestId) ??
			(input.utteranceId ? byUtterance(db, input.utteranceId) : null);
		if (existing) {
			const original = conversation
				.messagesInTransaction(db, existing.conversationId)
				.find((message) => message.id === existing.inputMessageId);
			if (
				existing.conversationId !== input.conversationId ||
				original?.text !== input.text ||
				existing.utteranceId !== (input.utteranceId ?? null)
			)
				throw new Error("request_conflict");
			return { run: existing, fresh: false };
		}
		const now = clock();
		const runId = id();
		const messageId = id();
		conversation.appendInTransaction(db, {
			id: messageId,
			conversationId: input.conversationId,
			role: "user",
			text: input.text,
			createdAt: now,
			runId,
		});
		const deadlineAtMs =
			Date.parse(now) + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
		const { job } = queue.enqueueInTransaction(db, {
			// Scheduled runs get their own scope so background work cannot exhaust interactive acceptance.
			scope: input.sourceKind === "schedule" ? "dialogue.schedule" : "dialogue",
			kind: GENERATE_KIND,
			dedupeKey: runId,
			payload: { runId },
			subjectRef: runId,
			lane: input.sourceKind === "schedule" ? "background" : "interactive",
			resourceKey: "larm.llm",
			concurrencyKey: `conversation:${input.conversationId}`,
			deadlineAtMs,
		});
		const run: Run = {
			id: runId,
			requestId: input.requestId,
			conversationId: input.conversationId,
			utteranceId: input.utteranceId ?? null,
			status: "queued",
			revision: 0,
			inputMessageId: messageId,
			answerMessageId: null,
			error: null,
			jobId: job.id,
			deadlineAt: new Date(deadlineAtMs).toISOString(),
			sourceKind: input.sourceKind,
			scheduleId: input.scheduleId ?? null,
			occurrenceId: input.occurrenceId ?? null,
			createdAt: now,
			updatedAt: now,
		};
		insert(db, run);
		return { run, fresh: true };
	}

	const promptTarget: TargetDefinition<PromptTarget> = {
		kind: PROMPT_TARGET_KIND,
		version: 1,
		schema: promptTargetSchema,
		materializeInTransaction(tx, occurrence) {
			const { run } = acceptInTransaction(tx, {
				requestId: `schedule:${occurrence.occurrenceId}`,
				conversationId: occurrence.payload.conversationId,
				text: occurrence.payload.text,
				sourceKind: "schedule",
				scheduleId: occurrence.scheduleId,
				occurrenceId: occurrence.occurrenceId,
				deadlineMs: occurrence.payload.deadlineMs,
			});
			return { jobId: run.jobId as string, subjectRef: run.id };
		},
	};

	const service = {
		promptTarget,
		async recover() {
			// Runs without a queue job predate the queue and are interrupted as before.
			await store.write((db) => interruptUnfinished(db, clock()));
		},
		async submit(input: Submit): Promise<Run> {
			const accepted = await store.write((db) =>
				acceptInTransaction(db, {
					...input,
					sourceKind: input.utteranceId ? "voice" : "manual",
				}),
			);
			if (accepted.fresh) queue.wake();
			return accepted.run;
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
			const until =
				Date.now() + (options.timeoutMs ?? DEFAULT_DEADLINE_MS + 10_000);
			for (;;) {
				const run = store.read((db) => byId(db, runId));
				if (!run || TERMINAL.includes(run.status)) return run;
				if (options.signal?.aborted || Date.now() >= until) return run;
				await new Promise((resolve) =>
					setTimeout(resolve, options.pollMs ?? 250),
				);
			}
		},
		answerText(runId: string): string | null {
			const run = store.read((db) => byId(db, runId));
			return run?.answerMessageId
				? (conversation
						.get(run.conversationId)
						.messages.find((message) => message.id === run.answerMessageId)
						?.text ?? null)
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
			if (current.jobId) await queue.cancel(current.jobId);
			// No job (legacy) or the job already ended without settling the run.
			if (
				store.read((db) => byId(db, runId))?.status === "queued" ||
				store.read((db) => byId(db, runId))?.status === "running"
			)
				await store.write((db) => {
					const row = byId(db, runId);
					if (row && (row.status === "queued" || row.status === "running"))
						transition(
							db,
							runId,
							row.revision,
							"cancelled",
							clock(),
							"cancel_requested",
						);
				});
			return store.read((db) => byId(db, runId));
		},
		/** Runs are stopped by the queue's own shutdown; nothing is owned here. */
		async close() {},
	};
	return service;
}
export type DialogueService = ReturnType<typeof createDialogueService>;
