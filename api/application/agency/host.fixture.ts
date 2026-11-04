import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LlmPort,
	LlmRequest,
	UpdateModelData,
	WireOp,
} from "eumenes-agency";
import {
	createConversationService,
	migrations,
} from "../../domains/conversation";
import type { Settings } from "../../domains/settings";
import type { MemoryItemDto } from "../../domains/memory";
import { settle } from "../../infrastructure/wait-for";
import { openStore } from "../../infrastructure/sqlite";
import { createAgencyHost, type AgencySettings } from "./host";
import { createAgencyWork } from "./work";
import { createAgencyStatePort } from "../../domains/dialogue";
import { openDialogueStore } from "../../domains/dialogue/test/store.fixture";

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
	interestOps: [],
	...over,
});
/** A scripted F model for host lifecycle tests. This is fixture data, never a product fallback. */
export const wireOp = (
	op: WireOp["op"],
	over: Partial<WireOp> = {},
): WireOp => ({
	op,
	id: null,
	localId: null,
	expectedRevision: null,
	state: null,
	text: null,
	reason: null,
	completionCondition: null,
	resumeCondition: null,
	withdrawCondition: null,
	applyWhen: null,
	hours: null,
	intentRef: null,
	desireRef: null,
	supersedes: null,
	kind: null,
	confidence: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	beliefRefs: [],
	...over,
});
export function pendingUpdate(data: UpdateModelData) {
	if (
		data.state.candidates.some((c) =>
			["available", "deferred"].includes(c.state),
		)
	)
		return updated();
	const evidenceRefs = data.observations.slice(-1).map((o) => o.id);
	if (evidenceRefs.length === 0) return updated();
	const intent = data.state.intents.find((i) =>
		["adopted", "proposed"].includes(i.state),
	);
	return updated({
		ops: [
			...(intent
				? []
				: [
						wireOp("intent.add", {
							localId: "g",
							state: "adopted",
							text: "Continue the topic",
							reason: "Unresolved question",
							completionCondition: "User confirms resolution",
							resumeCondition: "Quiet opportunity",
							withdrawCondition: "User declines",
							hours: 1,
							evidenceRefs,
						}),
					]),
			wireOp("candidate.add", {
				localId: "c",
				intentRef: intent?.id ?? "g",
				kind: "question",
				text: "Would you like to continue?",
				applyWhen: "Quiet opportunity",
				hours: 1,
				evidenceRefs,
			}),
		],
	});
}
export const update: Reply = (request) =>
	pendingUpdate(JSON.parse(request.prompt));
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
		general?: Partial<Settings["general"]>;
		select?: Reply;
		update?: Reply;
		memory?: MemoryItemDto[];
		busy?: () => boolean;
		start?: boolean;
		persistent?: boolean;
		routeSpeechInTransaction?: Parameters<
			typeof createAgencyHost
		>[0]["routeSpeechInTransaction"];
		llm?: (
			next: Parameters<Parameters<typeof createAgencyHost>[0]["createLlm"]>[0],
		) => LlmPort;
	} = {},
) {
	const persisted = options.persistent
		? openDialogueStore("agency-host-")
		: null;
	const dir =
		persisted?.dir ?? mkdtempSync(join(tmpdir(), "eumenes-agency-host-"));
	const store =
		persisted?.store ?? openStore(join(dir, "test.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	let general: Pick<Settings["general"], "agentName" | "userName" | "persona"> =
		{
			agentName: "Eumenes",
			userName: "",
			persona: "butler",
			...options.general,
		};
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
	const host = createAgencyHost({
		...(options.routeSpeechInTransaction
			? { routeSpeechInTransaction: options.routeSpeechInTransaction }
			: {}),
		...(options.persistent
			? { state: createAgencyStatePort({ now: () => now }) }
			: {}),
		store,
		conversation,
		inference: { foregroundBusy: () => inference.busy },
		settings: {
			get: () => ({ agency, general }),
			inTransaction: () => ({ agency, general }),
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
		createLlm:
			options.llm ??
			((next) => ({
				async complete<T>(request: LlmRequest<T>) {
					identities.push(next(request as LlmRequest<unknown>));
					calls[request.purpose]++;
					requests.push(request as LlmRequest<unknown>);
					const reply =
						request.purpose === "update" ? (options.update ?? update) : select;
					const raw = await reply(request as LlmRequest<unknown>);
					// Bind the scripted speech to the actual F candidate supplied by this call.
					const data = JSON.parse(request.prompt);
					const candidate = data.candidates?.[0];
					const spoken = raw as ReturnType<typeof choice>;
					const value = request.schema.parse(
						request.purpose === "select" &&
							spoken.action === "speak" &&
							!spoken.candidateRef &&
							candidate
							? {
									...spoken,
									candidateRef: {
										id: candidate.id,
										revision: candidate.revision,
									},
								}
							: raw,
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
		setSelect: (reply: Reply) => {
			select = reply;
		},
		setPersona: (over: Partial<typeof general>) => {
			general = { ...general, ...over };
			for (const listener of listeners) listener();
		},
		setAgency: (over: Partial<AgencySettings>) => {
			agency = { ...agency, ...over };
			for (const listener of listeners) listener();
		},
		/** The committed setting changes before the listeners hear of it. */
		setPersonaUnannounced: (over: Partial<typeof general>) => {
			general = { ...general, ...over };
		},
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
