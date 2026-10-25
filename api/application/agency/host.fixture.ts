import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmPort, LlmRequest } from "eumenes-agency";
import {
	createConversationService,
	migrations,
} from "../../domains/conversation";
import type { MemoryItemDto } from "../../domains/memory";
import { settle } from "../../infrastructure/wait-for";
import { openStore } from "../../infrastructure/sqlite";
import { createAgencyHost, type AgencySettings } from "./host";
import { createAgencyWork } from "./work";

export const T0 = Date.parse("2026-10-22T09:00:00Z");
export const baseSettings: AgencySettings = {
	idleSec: 20,
	maxUnanswered: 1,
	interests: [],
	emotion: false,
};

/** What the fake background model answers for one purpose. */
export type Reply = (
	request: LlmRequest<unknown>,
) => unknown | Promise<unknown>;
export const updated = (over: Record<string, unknown> = {}) => ({
	summary: "s",
	missingInfo: null,
	focusRefs: [],
	ops: [],
	reconciliations: [],
	reportedTodos: [],
	...over,
});
export const update: Reply = () => updated();
export const choice = (
	action: "speak" | "wait",
	over: { utterance?: string; refs?: string[] } = {},
) => ({
	action,
	candidateRef: null,
	utterance:
		action === "speak"
			? (over.utterance ?? "ねえ、さっきの話の続きは？")
			: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: over.refs ?? [],
	valueNow: "v",
	userBurden: "b",
	lossIfWait: "l",
	conflicts: null,
	reason: "テストの理由",
});
export const wait: Reply = () => choice("wait");

export const memoryItem = (over: Partial<MemoryItemDto>): MemoryItemDto => ({
	id: "m1",
	kind: "preference",
	semanticKey: "k",
	text: "コーヒーが好き",
	polarity: "affirmed",
	status: "active",
	origin: "agent",
	revision: 1,
	sourceMessageIds: [],
	validFromMs: null,
	validUntilMs: null,
	evidence: [],
	validity: null,
	capturedBy: "agent",
	...over,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

export function harness(
	options: {
		settings?: Partial<AgencySettings>;
		select?: Reply;
		update?: Reply;
		memory?: MemoryItemDto[];
		busy?: () => boolean;
		start?: boolean;
		llm?: (
			next: Parameters<Parameters<typeof createAgencyHost>[0]["createLlm"]>[0],
		) => LlmPort;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-agency-host-"));
	const store = openStore(join(dir, "test.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	let agency: AgencySettings = { ...baseSettings, ...options.settings };
	const listeners = new Set<() => void>();
	let now = T0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let timerId = 0;
	const calls = { update: 0, select: 0, respond: 0 };
	const requests: LlmRequest<unknown>[] = [];
	const identities: Array<{ decisionId: string; generation: number }> = [];
	let select = options.select ?? wait;
	const inference = { busy: false };
	const memoryReads = { count: 0 };
	const spoke: Array<Record<string, unknown>> = [];
	const archived: Array<Record<string, unknown>> = [];
	const host = createAgencyHost({
		store,
		conversation,
		inference: { foregroundBusy: () => inference.busy },
		settings: {
			get: () => ({ agency }),
			inTransaction: () => ({ agency }),
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		memory: {
			status: () => ({ enabled: true, healthy: true }),
			list: () => {
				memoryReads.count++;
				return options.memory ?? [];
			},
		},
		conversationBusy: () => options.busy?.() ?? false,
		recordSpokeInTransaction: (_db, input) => {
			spoke.push(input);
		},
		archiveReportedInTransaction: (_db, input) => {
			archived.push(input);
		},
		createLlm:
			options.llm ??
			((next) => ({
				async complete<T>(request: LlmRequest<T>) {
					identities.push(next(request as LlmRequest<unknown>));
					calls[request.purpose]++;
					requests.push(request as LlmRequest<unknown>);
					const reply =
						request.purpose === "update" ? (options.update ?? update) : select;
					const value = request.schema.parse(
						await reply(request as LlmRequest<unknown>),
					);
					return {
						value,
						model: "fake",
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 0,
						latencyMs: 1,
					};
				},
			})),
		nowMs: () => now,
		setTimer: (fn, ms) => {
			timers.set(++timerId, { at: now + ms, fn });
			return timerId;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
	});
	if (options.start !== false) host.start();
	cleanups.push(async () => {
		await host.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const message = (
		conversationId: string,
		id: string,
		role: "user" | "assistant",
		text: string,
		runId: string | null = null,
	) => ({
		id,
		conversationId,
		role,
		text,
		createdAt: new Date(now).toISOString(),
		runId,
	});
	return {
		store,
		conversation,
		host,
		calls,
		requests,
		identities,
		inference,
		memoryReads,
		spoke,
		archived,
		setSelect: (reply: Reply) => {
			select = reply;
		},
		setAgency: (over: Partial<AgencySettings>) => {
			agency = { ...agency, ...over };
			for (const listener of listeners) listener();
		},
		/** The committed setting changes before the listeners hear of it. */
		setAgencyUnannounced: (over: Partial<AgencySettings>) => {
			agency = { ...agency, ...over };
		},
		/** Settings changed somewhere else (cloud allowed, a connection, a model). */
		announceSettings: () => {
			for (const listener of listeners) listener();
		},
		say: (
			id: string,
			role: "user" | "assistant",
			text: string,
			runId: string | null = null,
			conversationId = "c1",
		) => conversation.append(message(conversationId, id, role, text, runId)),
		message,
		texts: (conversationId = "c1") =>
			conversation.get(conversationId).messages.map((m) => m.id),
		/** Runs the fake timers due within `ms`, in order, letting each cycle finish. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				await settle();
			}
			now = end;
		},
		pendingTimers: () => timers.size,
		setNow: (value: number) => {
			now = value;
		},
		advanceClock: (ms: number) => {
			now += ms;
		},
	};
}
export type Harness = ReturnType<typeof harness>;

/** A user message and the run answer that ends the turn. */
export async function exchange(h: Harness, n: number, conversationId = "c1") {
	await h.say(`u${n}`, "user", `こんにちは${n}`, null, conversationId);
	await h.say(`a${n}`, "assistant", `はい${n}`, `run-${n}`, conversationId);
}

/** A ledger TODO as the dialogue reports it to the agency. */
export const ledgerTodo = (
	id: string,
	status: "todo" | "waiting" | "done",
	over: Record<string, unknown> = {},
) => ({
	id,
	title: `仕事 ${id}`,
	status,
	revision: 1,
	createdAt: new Date(T0).toISOString(),
	updatedAt: new Date(T0).toISOString(),
	changedAt: new Date(T0).toISOString(),
	result: null,
	...over,
});
export const attachLedger = (
	h: Harness,
	todos: () => ReturnType<typeof ledgerTodo>[],
) =>
	h.host.attachWork(
		createAgencyWork({
			dialogue: { todosInTransaction: () => todos() as never },
		}),
	);
