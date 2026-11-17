import type { Database } from "bun:sqlite";
import { z } from "zod";
import { hash } from "../../capabilities";
import type { HandlerDefinition } from "../../queue";
import { getLogger } from "../../../infrastructure/logger";
import type { DebugDiagnosticDetail } from "../contracts/debug-diagnostics";
import { byId, recentRuns } from "../repository";
import { workOfRun } from "../repository/work";
import type { DialogueDeps } from "./context";
import {
	createDebugExplanation,
	DIAGNOSTIC_TIMEOUT_MS,
	type DebugPayload,
	type DebugResult,
} from "./debug-explanation";

const KIND = "dialogue.debug_diagnostics";
const INTERVAL = 30_000;
const TTL = 30 * 60_000;
const bytes = new TextEncoder();
const log = getLogger("dialogue");
const payloadSchema = z.strictObject({
	epoch: z.uuid(),
	conversationId: z.string(),
	runId: z.string(),
	triggerId: z.string(),
	source: z.string(),
	origin: z.string(),
	manual: z.boolean(),
	stage: z.string(),
});
type Payload = DebugPayload;
type Result = DebugResult;
export type DebugDiagnosticsOptions = {
	enabled(tx: Database): boolean;
	onChange?(listener: () => void): () => void;
	publish?(): void;
};

export function createDebugDiagnostics(
	deps: DialogueDeps,
	options: DebugDiagnosticsOptions,
) {
	const { store, queue, conversation, larm } = deps;
	let epoch = crypto.randomUUID();
	let active: AbortController | undefined;
	const cache = createDebugCache(deps.clock, options.publish);
	const omitted = new Map<string, number>();
	const staged = new Map<string, { payload: Payload; result: Result }>();

	function noteOmitted(id: string) {
		const count = (omitted.get(id) ?? 0) + 1;
		omitted.delete(id);
		omitted.set(id, count);
		if (omitted.size > 100) omitted.delete(omitted.keys().next().value!);
	}
	let enabled = store.read(options.enabled);
	const unsubscribe = options.onChange?.(() => {
		const next = store.read(options.enabled);
		if (next === enabled) return;
		enabled = next;
		deps.contextInputs?.setEnabled(next);
		epoch = crypto.randomUUID();
		active?.abort();
		cache.clear();
		omitted.clear();
		staged.clear();
		options.publish?.();
	});

	function visible(tx: Database, conversationId: string, runId: string) {
		const run = byId(tx, runId);
		if (!run || run.conversationId !== conversationId) return null;
		const message = conversation.messageInTransaction(
			tx,
			run.inputMessageId,
		)?.message;
		if (
			!message ||
			deps.memory
				?.blockedMessageIdsOfConversationInTransaction(tx, conversationId)
				.includes(message.id)
		)
			return null;
		return { run, message };
	}
	function readSource(
		tx: Database,
		conversationId: string,
		runId: string,
		triggerId: string,
	) {
		const target = visible(tx, conversationId, runId);
		const trigger =
			runId === triggerId ? target : visible(tx, conversationId, triggerId);
		if (!target || !trigger) return null;
		const works = workOfRun(tx, runId).slice(-8);
		const source = hash([
			target.run.revision,
			target.message.text,
			trigger.message.text,
			works.map(({ id, revision }) => [id, revision]),
		]);
		return {
			...target,
			trigger,
			works,
			source,
			origin: hash([target.message.text, trigger.message.text]),
		};
	}
	function current(tx: Database, p: Payload) {
		if (!options.enabled(tx) || p.epoch !== epoch) return null;
		const found = readSource(tx, p.conversationId, p.runId, p.triggerId);
		return found?.source === p.source ? found : null;
	}

	const handler: HandlerDefinition<
		Payload,
		{ requestId?: string; payload: Payload },
		Result
	> = {
		kind: KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		resourceKey: KIND,
		prepareInTransaction(tx, claim) {
			const candidate = claim.payload;
			const found =
				options.enabled(tx) && candidate.epoch === epoch
					? readSource(
							tx,
							candidate.conversationId,
							candidate.runId,
							candidate.triggerId,
						)
					: null;
			if (!found || found.origin !== candidate.origin)
				return { status: "stale", reason: "debug_source_unavailable" };
			const requestId = larm.captureInTransaction?.(
				tx,
				`${KIND}:${claim.jobId}`,
				"llm",
				Date.now() + DIAGNOSTIC_TIMEOUT_MS,
			);
			return {
				status: "ready",
				input: { requestId, payload: { ...candidate, source: found.source } },
			};
		},
		execute: createDebugExplanation(
			deps,
			current,
			(controller) => {
				active = controller;
			},
			(controller) => {
				if (active === controller) active = undefined;
			},
		),
		settleInTransaction(tx, claim, input, outcome) {
			const payload = input?.payload ?? claim.payload;
			if (!current(tx, payload)) {
				if (input?.requestId)
					larm.cancelRequestsInTransaction?.(tx, [input.requestId]);
				return "stale";
			}
			const result =
				outcome.type === "success"
					? outcome.result
					: {
							summary: null,
							observation: "診断の記録を取得できませんでした。",
						};
			const adopted =
				result.receipt && larm.acceptInTransaction?.(tx, result.receipt);
			if (!adopted && input?.requestId)
				larm.cancelRequestsInTransaction?.(tx, [input.requestId]);
			staged.clear();
			staged.set(claim.jobId, {
				payload,
				result: { ...result, summary: adopted ? result.summary : null },
			});
			return "applied";
		},
		afterCommit() {
			for (const [id, entry] of staged) {
				staged.delete(id);
				const state = queue.get(id)?.state;
				if (
					state &&
					["completed", "failed", "expired", "interrupted"].includes(state) &&
					store.read((tx) => current(tx, entry.payload))
				)
					cache.display(id, entry.payload, entry.result);
			}
		},
		cancelInTransaction() {},
	};
	queue.registerHandler(handler);

	return {
		enabled: () => enabled && store.read(options.enabled),
		/** References are exposed only on demand, and valid only within this conversation. */
		candidates(conversationId: string, currentRunId: string) {
			if (!enabled) return [];
			return store.read((tx) =>
				options.enabled(tx)
					? recentRuns(tx, conversationId, currentRunId, 8)
							.filter((r) => visible(tx, conversationId, r.id))
							.slice(0, 3)
							.map((r) => ({ id: r.id, at: r.createdAt, status: r.status }))
					: [],
			);
		},
		target(conversationId: string, currentRunId: string, args: object) {
			const parsed = z
				.strictObject({
					target: z.strictObject({
						kind: z.literal("run"),
						id: z.string().min(1).max(160).optional(),
					}),
				})
				.safeParse(args);
			if (!parsed.success || !enabled) return undefined;
			const candidates = this.candidates(conversationId, currentRunId);
			const id = parsed.data.target.id;
			if (!id) return candidates.length === 1 ? candidates[0]?.id : candidates;
			const prior = this.detail(conversationId, id);
			return (
				prior?.runId ?? candidates.find((candidate) => candidate.id === id)?.id
			);
		},
		enqueue(
			tx: Database,
			conversationId: string,
			runId: string,
			triggerId = runId,
			manual = false,
			stage = "run",
		) {
			if (!enabled || !options.enabled(tx)) return;
			try {
				const found = readSource(tx, conversationId, runId, triggerId);
				if (!found) return;
				const waiting = queue.listByKindInTransaction(tx, KIND, "queued", 20);
				const scoped = waiting.filter(
					(job) => job.scope === `debug:${conversationId}`,
				);
				if (waiting.length >= 20 || scoped.length >= 3) {
					noteOmitted(conversationId);
					return;
				}
				const now = Date.now();
				const scope = `debug:${conversationId}`;
				const latest = queue.listByKindInTransaction(
					tx,
					KIND,
					undefined,
					1,
					scope,
				)[0];
				const prior = [...(latest ? [latest] : []), ...scoped];
				const availableAtMs = Math.max(
					now,
					...prior.map(
						(job) => Math.max(job.availableAtMs, job.updatedAtMs) + INTERVAL,
					),
				);
				queue.enqueueInTransaction(tx, {
					kind: KIND,
					scope,
					subjectRef: runId,
					dedupeKey: hash([epoch, stage, runId, triggerId, found.source]),
					payload: {
						epoch,
						conversationId,
						runId,
						triggerId,
						source: found.source,
						origin: found.origin,
						manual,
						stage,
					},
					lane: "background",
					availableAtMs,
					deadlineAtMs: now + 10 * 60_000,
				});
			} catch {
				noteOmitted(conversationId);
				log.warn("dialogue.debug_diagnostic_omitted");
			}
		},
		list(conversationId: string) {
			if (!enabled) return null;
			cache.prune();
			return store.read((tx) =>
				options.enabled(tx)
					? {
							entries: [...cache.rows.values()]
								.filter(
									(row) =>
										row.payload.conversationId === conversationId &&
										current(tx, row.payload),
								)
								.map(
									({ result: { observation: _observation, ...entry } }) =>
										entry,
								),
							omitted: omitted.get(conversationId) ?? 0,
						}
					: null,
			);
		},
		detail(conversationId: string, id: string) {
			if (!enabled) return null;
			cache.prune();
			const row = cache.rows.get(id);
			return row?.payload.conversationId === conversationId &&
				store.read((tx) => current(tx, row.payload))
				? row.result
				: null;
		},
		close() {
			unsubscribe?.();
			active?.abort();
		},
	};
}

function createDebugCache(clock: () => string, publish?: () => void) {
	const rows = new Map<
		string,
		{ payload: Payload; result: DebugDiagnosticDetail; size: number }
	>();
	let size = 0;
	function remove(id: string) {
		const row = rows.get(id);
		if (row) size -= row.size;
		rows.delete(id);
	}
	function prune() {
		for (const [id, row] of rows)
			if (row.result.expiresAt <= Date.now()) remove(id);
	}
	function display(id: string, payload: Payload, output: Result) {
		prune();
		const { summary, observation } = output;
		const result = {
			id,
			runId: payload.runId,
			at: clock(),
			expiresAt: Date.now() + TTL,
			summary,
			observation,
		};
		const rowSize = bytes.encode(JSON.stringify(result)).length;
		remove(id);
		rows.set(id, { payload, result, size: rowSize });
		size += rowSize;
		const same = [...rows].filter(
			([, row]) => row.payload.conversationId === payload.conversationId,
		);
		for (const [old] of same.slice(0, Math.max(0, same.length - 100)))
			remove(old);
		while (size > 1024 * 1024) remove(rows.keys().next().value!);
		publish?.();
	}

	return {
		rows,
		prune,
		display,
		clear() {
			rows.clear();
			size = 0;
		},
	};
}
