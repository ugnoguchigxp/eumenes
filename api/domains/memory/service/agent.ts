import type { Database } from "bun:sqlite";
import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import type { StateItem } from "eumenes-memory/sqlite";
import { z } from "zod";
import { sha256Hex } from "../../../infrastructure/digest";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import type { MemoryEmbed, TurnRecall } from "../contracts";
import {
	advanceCursor,
	countCursorFailure,
	initCursor,
	isExcluded,
	listActiveTendencies,
	listCursors,
	putRequest,
	readCursorRow,
	takeRequest,
} from "../repository";
import {
	AGENT_INSTRUCTIONS,
	agentOutputJsonSchema,
	parseAgentOutput,
	type ParsedOp,
} from "./agent-schema";
import { LONG_TERM_BYTES, SHORT_TERM_BYTES } from "./context-render";
import type { ContextWindowStore } from "./context-window";
import {
	createAgentVectors,
	type QueryVector,
	type TurnVectors,
} from "./agent-vectors";
import type {
	AgentOperations,
	AgentOpResult,
	AgentReason,
	AgentRefs,
	AgentTurn,
} from "./operation";
import type {
	AgentChatMessage,
	AgentInferencePort,
	AgentJobHandler,
	AgentQueuePort,
	AgentReceipt,
} from "./ports";
import type { RecallInput } from "./turn-recall";
import { localDay, validityOf } from "./validity";

const log = getLogger("memory");

export const AGENT_KIND = "memory.agent.v1";
export const AGENT_RESOURCE = "inference.aux";
/** Messages read per run; the rest waits for the next job. */
const BATCH_MESSAGES = 8;
const TURN_CHARS = 2000;
/** The turn text one run reads, on top of the message count: a long backlog is read over several runs. */
const BATCH_BYTES = 16 * 1024;
/** Consecutive failed runs over the same messages after which they are skipped. */
const MAX_FAILURES = 3;
const NOTICE_TARGET_CHARS = 30;
/** The control request's own deadline and output cap (inference refuses more than 30 s / 1500 tokens). */
const INFERENCE_MS = 25_000;
const MAX_OUTPUT_TOKENS = 1200;
/** The job's queue deadline: waiting behind an earlier job of the same conversation counts. */
const JOB_DEADLINE_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024;

const STOP_NOTICE =
	"利用を止めました。完全に消すには設定の「メモリー」から操作してください。";
const REASON_TEXT: Record<AgentReason, string> = {
	quote_mismatch: "発言を確認できませんでした",
	limit_reached: "保存できる量を超えています",
	user_stopped: "以前に利用を止めた内容です",
	user_protected: "本人が確認した記憶と内容が違います",
	item_changed: "他で変更されました",
	conflict: "他で変更されました",
	invalid_input: "内容を判断できませんでした",
	unknown_ref: "内容を判断できませんでした",
};

const payloadSchema = z.object({ conversationId: z.string().min(1) });
type Payload = z.infer<typeof payloadSchema>;
export type AgentJobInput = {
	conversationId: string;
	jobId: string;
	requestId: string;
	turns: AgentTurn[];
	refs: AgentRefs;
	/** The text behind each ref, for the refusal notice only. */
	refTexts: Record<string, string>;
	lastOrdinal: number;
	messages: AgentChatMessage[];
	/** sha256 of each turn's full message text when it was read: what a stored vector stands for. */
	digests: Record<string, string>;
};
export type AgentJobOutput = {
	receipt: AgentReceipt;
	/** null: the answer was not usable output at all. */
	ops: ParsedOp[] | null;
	/** The turns' passage vectors; null when embedding was not available or failed (no vector is stored then). */
	turnVectors: TurnVectors | null;
	/**
	 * The prefetch query as a vector: undefined when the model asked for none (the earlier prefetch stays),
	 * null when it asked and embedding failed (the earlier prefetch stays too).
	 */
	prefetch: QueryVector | null | undefined;
};

const clip = (text: string, chars: number) =>
	[...text].slice(0, chars).join("");

/**
 * What the model is shown besides the new turns: the long-term list (State, then tendencies), the live
 * notes, and how full the two layers are. Every item gets a short ref ("m1", "t1", "n1"); the ref table
 * and the text behind each ref stay on the host (ids and revisions never reach the model).
 */
function describeMemory(
	db: Database,
	deps: {
		continuity: ContinuityService;
		windows: ContextWindowStore;
		listState(db: Database, all: boolean): readonly StateItem[];
		conversationId: string;
		nowMs: number;
	},
	turns: AgentTurn[],
): { refs: AgentRefs; refTexts: Record<string, string>; data: string } {
	const { conversationId, nowMs, continuity, windows } = deps;
	const refs: AgentRefs = {};
	const refTexts: Record<string, string> = {};
	const longTerm: Array<Record<string, unknown>> = [];
	let m = 0;
	for (const item of [...deps.listState(db, false)].sort(
		(a, b) => b.updatedSeq - a.updatedSeq,
	)) {
		if (
			item.subject !== "self" ||
			item.status !== "active" ||
			classifyValidity(
				periodFromStateMs(item.validFromMs, item.validUntilMs),
				nowMs,
			) === "past"
		)
			continue;
		const ref = `m${++m}`;
		refs[ref] = {
			namespace: "state",
			id: item.itemId,
			revision: item.revision,
		};
		refTexts[ref] = item.value.text;
		const period = validityOf(item);
		longTerm.push({
			ref,
			kind: item.kind,
			text: item.value.text,
			...(item.value.polarity === "negated" ? { polarity: "negated" } : {}),
			...(period?.from ? { validFrom: period.from } : {}),
			...(period?.until ? { validUntil: period.until } : {}),
		});
	}
	let t = 0;
	for (const row of listActiveTendencies(db)) {
		const ref = `t${++t}`;
		refs[ref] = { namespace: "tendency", id: row.id, revision: row.revision };
		refTexts[ref] = row.text;
		longTerm.push({ ref, kind: "tendency", text: row.text });
	}
	let n = 0;
	const shortTerm: Array<Record<string, unknown>> = [];
	for (const item of continuity.snapshotInTransaction(db, conversationId)
		.items) {
		const ref = `n${++n}`;
		refs[ref] = {
			namespace: "continuity",
			id: item.id,
			revision: item.revision,
		};
		refTexts[ref] = item.text;
		shortTerm.push({ ref, kind: item.kind, text: item.text });
	}
	const window = windows.readForRunInTransaction(db, conversationId);
	const data = JSON.stringify({
		today: localDay(nowMs),
		turns: turns.map(({ label, role, text, createdAt }) => ({
			label,
			role,
			text,
			createdAt,
		})),
		longTerm,
		shortTerm,
		budgets: {
			longTermBytes: window.longTerm.bytes,
			longTermLimit: LONG_TERM_BYTES,
			shortTermBytes: window.shortTerm.bytes,
			shortTermLimit: SHORT_TERM_BYTES,
		},
	});
	return { refs, refTexts, data };
}

/** The words a refusal notice names: the item the request pointed at, else the user's own message. Never the model's quote. */
function noticeFor(
	target: {
		requested?: boolean | undefined;
		ref?: string | undefined;
		turn?: string | undefined;
	},
	result: Extract<AgentOpResult, { status: "rejected" }>,
	input: AgentJobInput,
): string | null {
	const { reason } = result;
	// What the user confirmed is kept: the conversation hears of the disagreement even though nobody asked.
	if (reason === "user_protected" && result.protectedText)
		return protectedNotice(result.protectedText);
	if (target.requested !== true) return null;
	const named =
		(target.ref ? input.refTexts[target.ref] : undefined) ??
		input.turns.find(
			(turn) => turn.label === target.turn && turn.role === "user",
		)?.text ??
		"";
	return `「${clip(named, NOTICE_TARGET_CHARS)}」の記憶の依頼は保存できませんでした（${REASON_TEXT[reason]}）。`;
}

/** Said when an inference disagreed with an item the user confirmed: the user can then ask for the change. */
function protectedNotice(itemText: string): string {
	return `「${clip(itemText, NOTICE_TARGET_CHARS)}」と違う内容の発言がありました。記憶を更新するときは、覚え直すよう伝えてください。`;
}

/**
 * Where a conversation's reading starts. A conversation the agent has never read starts at its latest
 * user message: an existing long history is not worked through, only the present utterance.
 */
function cursorOf(
	db: Database,
	conversation: ConversationService,
	conversationId: string,
): number {
	const row = readCursorRow(db, conversationId);
	if (row) return row.lastOrdinal;
	const latestUser = conversation.nthLatestUserOrdinalInTransaction(
		db,
		conversationId,
		1,
	);
	const start =
		latestUser > 0
			? latestUser - 1
			: conversation.latestOrdinalInTransaction(db, conversationId);
	initCursor(db, conversationId, start);
	return start;
}

/** A run that read the messages and failed. After enough of them the messages are skipped, so one bad batch cannot stall the agent. */
function countFailure(
	db: Database,
	conversationId: string,
	lastOrdinal: number,
) {
	const failures = countCursorFailure(db, conversationId);
	if (failures < MAX_FAILURES) return;
	advanceCursor(db, conversationId, lastOrdinal);
	log.info("memory.agent_skipped", {
		reason: "repeated_failure",
		count: failures,
	});
}

/**
 * The next messages to read: at most BATCH_MESSAGES and BATCH_BYTES of turn text (the first message always),
 * minus scheduled prompts, which are never learned from. `lastOrdinal` is where the cursor goes afterwards.
 */
function selectBatch(
	db: Database,
	conversation: ConversationService,
	conversationId: string,
) {
	const fetched = conversation.messagesAfterInTransaction(
		db,
		conversationId,
		cursorOf(db, conversation, conversationId),
		BATCH_MESSAGES,
	);
	const batch: typeof fetched = [];
	let bytes = 0;
	for (const entry of fetched) {
		const size = Buffer.byteLength(clip(entry.message.text, TURN_CHARS));
		if (batch.length > 0 && bytes + size > BATCH_BYTES) break;
		batch.push(entry);
		bytes += size;
	}
	const last = batch[batch.length - 1];
	if (!last) return null;
	return {
		lastOrdinal: last.ordinal,
		readable: batch.filter(({ message }) => !isExcluded(db, message.id)),
	};
}

/**
 * The control request for one run, or null when LARM is not connected or has no auxiliary route: nothing was
 * attempted, so nothing is counted and the same messages are retried next time.
 */
function captureRequest(
	db: Database,
	inference: AgentInferencePort,
	claim: { jobId: string; generation: number },
): string | null {
	db.exec("SAVEPOINT memory_agent_capture");
	try {
		const deadline = Date.now() + INFERENCE_MS;
		const requestId = inference.captureBackgroundControlInTransaction!(db, {
			taskId: "memory-agent",
			decisionId: claim.jobId,
			authorityEpoch: 1,
			executionGeneration: claim.generation,
			deadline,
			taskDeadline: deadline,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		});
		db.exec("RELEASE memory_agent_capture");
		return requestId;
	} catch {
		db.exec("ROLLBACK TO memory_agent_capture");
		db.exec("RELEASE memory_agent_capture");
		log.info("memory.agent_skipped", {
			reason: "background_inference_unavailable",
		});
		return null;
	}
}

export function createMemoryAgent(deps: {
	store: SqliteStore;
	conversation: ConversationService;
	continuity: ContinuityService;
	windows: ContextWindowStore;
	operations: AgentOperations;
	/** Memory is healthy and switched on. */
	ready(db: Database): boolean;
	listState(db: Database, all: boolean): readonly StateItem[];
	atMs(): number;
	/** Embedding, when the application provides it (looked up at each use: the embedder may be created later). */
	embed?: (() => MemoryEmbed | undefined) | undefined;
	/** Earlier exchanges found by meaning (see `recallTurns`). */
	recall(db: Database, input: RecallInput): TurnRecall | null;
	queue: AgentQueuePort | undefined;
	inference: AgentInferencePort | undefined;
}) {
	const { store, conversation, windows, operations, inference } = deps;
	const vectors = createAgentVectors({
		conversation,
		atMs: deps.atMs,
		embed: deps.embed,
		recall: deps.recall,
	});
	const cancelledRequests = new Set<string>();
	if (inference)
		store.onCommit(() => {
			if (cancelledRequests.size === 0) return;
			const ids = [...cancelledRequests];
			cancelledRequests.clear();
			inference.flushCancelledRequests?.(ids);
		});

	/** The run could not be started or its result is not used: the request goes with it (cancelled, then flushed after the commit). */
	function releaseRequest(db: Database, requestId: string) {
		inference?.cancelRequestsInTransaction?.(db, [requestId]);
		cancelledRequests.add(requestId);
	}

	/**
	 * Queues the agent for a conversation with messages it has not read. Never throws, whatever fails
	 * inside: it runs in the user's message acceptance and in the answer's adoption, which it must not undo.
	 */
	function scheduleInTransaction(db: Database, conversationId: string) {
		const queue = deps.queue;
		if (!queue || !inference) return;
		db.exec("SAVEPOINT memory_agent_schedule");
		try {
			if (deps.ready(db)) {
				const cursor = cursorOf(db, conversation, conversationId);
				const latest = conversation.latestOrdinalInTransaction(
					db,
					conversationId,
				);
				if (latest > cursor)
					queue.enqueueInTransaction(db, {
						scope: "memory",
						kind: AGENT_KIND,
						// The cursor is part of the key: a job that read part of a backlog must be able to queue its successor.
						dedupeKey: `${conversationId}:${cursor}:${latest}`,
						payload: { conversationId },
						subjectRef: conversationId,
						lane: "background",
						resourceKey: AGENT_RESOURCE,
						concurrencyKey: `memory-agent:${conversationId}`,
						maxAttempts: 1,
						deadlineAtMs: Date.now() + JOB_DEADLINE_MS,
					});
			}
			db.exec("RELEASE memory_agent_schedule");
		} catch (error) {
			db.exec("ROLLBACK TO memory_agent_schedule");
			db.exec("RELEASE memory_agent_schedule");
			log.warn("memory.agent_skipped", { reason: "schedule_failed" }, error);
		}
	}

	function prepareInTransaction(
		db: Database,
		claim: { jobId: string; generation: number; payload: Payload },
	):
		| { status: "ready"; input: AgentJobInput }
		| { status: "stale"; reason: string } {
		const { conversationId } = claim.payload;
		if (
			!deps.ready(db) ||
			!inference?.captureBackgroundControlInTransaction ||
			!inference.executeControl
		)
			return { status: "stale", reason: "memory_unavailable" };
		const selected = selectBatch(db, conversation, conversationId);
		if (!selected) return { status: "stale", reason: "nothing_to_do" };
		const { readable, lastOrdinal } = selected;
		if (readable.length === 0) {
			// Only scheduled prompts: skipped, but the cursor moves past them.
			advanceCursor(db, conversationId, lastOrdinal);
			scheduleInTransaction(db, conversationId);
			return { status: "stale", reason: "nothing_to_do" };
		}
		let users = 0;
		let assistants = 0;
		const turns: AgentTurn[] = readable.map(({ message }) => ({
			label: message.role === "user" ? `u${++users}` : `a${++assistants}`,
			messageId: message.id,
			runId: message.runId,
			role: message.role,
			text: clip(message.text, TURN_CHARS),
			createdAt: message.createdAt,
		}));
		const nowMs = deps.atMs();
		const { refs, refTexts, data } = describeMemory(
			db,
			{ ...deps, conversationId, nowMs },
			turns,
		);
		const requestId = captureRequest(db, inference, claim);
		if (requestId === null)
			return { status: "stale", reason: "background_inference_unavailable" };
		// Kept in the database: a job lost to a restart or an expired lease can still release its request.
		putRequest(db, claim.jobId, requestId);
		return {
			status: "ready",
			input: {
				conversationId,
				jobId: claim.jobId,
				requestId,
				turns,
				refs,
				refTexts,
				lastOrdinal,
				digests: Object.fromEntries(
					readable.map(({ message }) => [message.id, sha256Hex(message.text)]),
				),
				messages: [
					{
						role: "system",
						// The instructions and the schema the model must follow, in the form control requests carry them.
						content: `${AGENT_INSTRUCTIONS}\nOUTPUT_SCHEMA=${JSON.stringify(agentOutputJsonSchema)}`,
					},
					{ role: "user", content: data },
				],
			},
		};
	}

	async function execute(
		input: AgentJobInput,
		context: { signal: AbortSignal },
	): Promise<AgentJobOutput> {
		const signal = AbortSignal.any([
			context.signal,
			AbortSignal.timeout(INFERENCE_MS),
		]);
		// Alongside the inference: neither waits for the other, and embedding never throws.
		const turnVectors = vectors.embedTurns(input.turns, context.signal);
		const receipt = await inference!.executeControl!(
			input.requestId,
			input.messages,
			signal,
			{ instructions: AGENT_INSTRUCTIONS, outputSchema: agentOutputJsonSchema },
		);
		// A malformed answer is data, not a failure: settle rejects it and moves on.
		let parsed: ReturnType<typeof parseAgentOutput> = null;
		try {
			parsed = parseAgentOutput(parseLlmJson(receipt.value, MAX_OUTPUT_BYTES));
		} catch {
			parsed = null;
		}
		const query = parsed?.prefetch?.query;
		return {
			receipt,
			ops: parsed?.ops ?? null,
			turnVectors: await turnVectors,
			prefetch: query
				? await vectors.embedQuery(query, context.signal)
				: undefined,
		};
	}

	function settleInTransaction(
		db: Database,
		claim: { jobId: string },
		input: AgentJobInput | null,
		outcome:
			| { type: "success"; result: AgentJobOutput }
			| { type: "retry" | "failed" | "expired" | "interrupted" },
	): "applied" {
		// Every end of a job comes through here (or cancel): the stored request is the one to release.
		const stored = takeRequest(db, claim.jobId);
		const requestId = input?.requestId ?? stored;
		const release = () => requestId && releaseRequest(db, requestId);
		const done = () => "applied" as const;
		if (!input) {
			release();
			return done();
		}
		const conversationId = input.conversationId;
		if (outcome.type !== "success") {
			release();
			// A shutdown is not the messages' fault.
			if (outcome.type !== "interrupted")
				countFailure(db, conversationId, input.lastOrdinal);
			return done();
		}
		const { receipt, ops, turnVectors, prefetch } = outcome.result;
		// Nothing below may touch the window while memory is off or unhealthy.
		if (receipt.requestId !== input.requestId || !deps.ready(db)) {
			release();
			return done();
		}
		let applied = 0;
		let rejected = 0;
		let requestedRejected = 0;
		const notices: string[] = [];
		if (ops === null) {
			// Read and unusable: skip these messages instead of asking again forever.
			inference?.rejectControlInTransaction?.(
				db,
				receipt,
				"memory_agent_invalid_output",
			);
		} else {
			if (!inference?.acceptInTransaction?.(db, receipt)) {
				countFailure(db, conversationId, input.lastOrdinal);
				return done();
			}
			const ctx = { conversationId, refs: input.refs, turns: input.turns };
			let stopped = false;
			for (const parsed of ops) {
				const op = parsed.ok ? parsed.op : undefined;
				const result: AgentOpResult = op
					? operations.applyInTransaction(db, ctx, op)
					: { status: "rejected", reason: "invalid_input" };
				if (result.status === "applied") {
					applied++;
					if (op?.type === "stop") stopped = true;
					continue;
				}
				rejected++;
				const notice = noticeFor(parsed.ok ? parsed.op : parsed, result, input);
				if (notice) {
					if (result.reason !== "user_protected") requestedRejected++;
					notices.push(notice);
				}
			}
			if (stopped) notices.push(STOP_NOTICE);
		}
		vectors.saveTurnVectors(db, input, turnVectors);
		const prefetched = vectors.prefetchOf(db, conversationId, prefetch);
		windows.rebuildInTransaction(db, conversationId, {
			refreshLongTerm: false,
			addNotices: [...new Set(notices)],
			...(prefetched ? { prefetch: prefetched } : {}),
		});
		advanceCursor(db, conversationId, input.lastOrdinal);
		scheduleInTransaction(db, conversationId);
		log.info("memory.agent_settled", {
			messageCount: input.turns.length,
			applied,
			rejected,
			requestedRejected,
		});
		return done();
	}

	const handler: AgentJobHandler<Payload, AgentJobInput, AgentJobOutput> = {
		kind: AGENT_KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		resourceKey: AGENT_RESOURCE,
		prepareInTransaction,
		execute,
		// A failed run is not retried: its messages are read again by the next start.
		classify: () => "fail",
		settleInTransaction,
		cancelInTransaction(db, job) {
			const requestId = takeRequest(db, job.jobId);
			if (requestId) releaseRequest(db, requestId);
		},
	};
	/**
	 * Messages that arrived while memory was off or unhealthy are never learned: every conversation the
	 * agent knows is moved to its newest message (conversations it has not read start at their latest user message).
	 */
	function skipUnreadInTransaction(db: Database) {
		for (const { conversationId } of listCursors(db))
			advanceCursor(
				db,
				conversationId,
				conversation.latestOrdinalInTransaction(db, conversationId),
			);
	}
	return { handler, scheduleInTransaction, skipUnreadInTransaction };
}
