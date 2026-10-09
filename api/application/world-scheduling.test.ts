/**
 * P4-03 / A44 on the REAL queue, the REAL inference service and the production
 * foreground wiring (`createWorldForeground`): a temp-file store with the
 * production migrations. Fixture-grade: the LARM provider is a stub port (no
 * real Local Provider), Cloud is armed and spied on.
 */
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../domains/conversation";
import { createContinuityService } from "../domains/continuity";
import { createInference } from "../domains/inference";
import type { LarmPort } from "../domains/larm";
import { createMemoryService } from "../domains/memory";
import { createQueue } from "../domains/queue";
import { createSettings } from "../domains/settings";
import { WORLD_EXTRACT_KIND, type ExtractionInference } from "../domains/world";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
} from "./world";
import { createWorldForeground } from "./world-foreground";

const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const TEXT = "音声サービスは9月から利用できる。";
const ENTITY = {
	id: "svc-1",
	scope: SCOPE,
	revision: 1,
	displayName: "音声サービス",
	aliases: ["音声"],
	externalRefs: [],
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000) {
	for (let i = 0; i < ms / 10; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type Script = (
	messages: { role: string; content: string }[],
	signal: AbortSignal,
	options: Record<string, unknown> | undefined,
) => Promise<string>;

async function boot(
	script: Script,
	over: {
		mode?: "on" | "protect";
		stageBudgetMs?: number;
		confirmMs?: number;
		/** Reuse a database directory (a restart). */
		dir?: string;
		/** Leave the queue stopped: a job is created but never runs. */
		runQueue?: boolean;
		/** The model call never learns about a cancel (an unanswered cancel). */
		ignoreAbort?: boolean;
	} = {},
) {
	const dir = over.dir ?? mkdtempSync(join(tmpdir(), "eumenes-world-extract-"));
	if (!over.dir) dirs.push(dir);
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memoryJournalPath = join(dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(store),
		{ journalPath: memoryJournalPath },
	);
	const settings = await createSettings(store, { dbPath, env: {} });
	// Arm the Cloud path: a connection, a key and a fallback resource exist.
	const s = settings.get();
	const first = s.revision === 0;
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	s.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: "cloud-llm",
		contextWindow: 8192,
		voice: null,
	});
	s.routes.llm.fallbackId = resourceId;
	s.routes.llm.cloudAllowed = true;
	s.routes.llm.mode = "larm-preferred";
	s.connections.push({
		id: connectionId,
		name: "Cloud",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	if (first)
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: s,
			keys: [{ connectionId, value: "cloud-key" }],
		});
	let cloudRequests = 0;
	const larmCalls: {
		messages: { role: string; content: string }[];
		options: Record<string, unknown> | undefined;
	}[] = [];
	const port: LarmPort = {
		decisionModel: () => null,
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async (messages, signal, options) => {
			larmCalls.push({
				messages: messages.map((m) => ({ ...m })),
				options: options as Record<string, unknown> | undefined,
			});
			return script(
				messages.map((m) => ({ ...m })),
				signal,
				options as Record<string, unknown> | undefined,
			);
		},
		transcribe: async () => {
			throw new Error("unused");
		},
		speak: async () => {
			throw new Error("unused");
		},
		close: async () => {},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => port,
		fetch: async () => {
			cloudRequests += 1;
			throw new Error("cloud_must_not_be_called");
		},
		cloudMs: 500,
	});
	const queue = createQueue(store, {
		resourceAliases: { "larm.llm": "inference.llm" },
		resources: { "inference.llm": 1, "web.fetch": 2 },
		backoff: { baseMs: 10, maxMs: 20 },
		pollMs: 20,
	});
	const foreground = createWorldForeground({ store, queue, inference });
	const world = createWorldAssembly({
		store,
		conversation,
		memory,
		mode: over.mode ?? "on",
		journalPath: defaultWorldJournalPath(memoryJournalPath),
		cursorSecret: resolveWorldCursorSecret({ dbPath, env: {} }),
		debounceMs: 20,
		pollMs: 60_000,
		extraction: {
			queue,
			inference: (over.ignoreAbort
				? {
						captureMaintenanceControlInTransaction:
							inference.captureMaintenanceControlInTransaction.bind(inference),
						executeControl: (
							requestId: string,
							messages: {
								role: "system" | "user" | "assistant";
								content: string;
							}[],
						) =>
							inference.executeControl(
								requestId,
								messages,
								new AbortController().signal,
							),
						acceptInTransaction: inference.acceptInTransaction.bind(inference),
						rejectControlInTransaction:
							inference.rejectControlInTransaction.bind(inference),
						cancelRequestsInTransaction:
							inference.cancelRequestsInTransaction.bind(inference),
						snapshotFor: inference.snapshotFor.bind(inference),
					}
				: inference) as unknown as ExtractionInference,
			entities: () => [ENTITY],
			foreground: foreground.hub,
			...(over.stageBudgetMs === undefined
				? {}
				: { stageBudgetMs: over.stageBudgetMs }),
			...(over.confirmMs === undefined ? {} : { confirmMs: over.confirmMs }),
		},
	});
	const recovery = await memory.recover();
	await world.recover({
		feedResyncRequired: recovery.feedResyncRequired === true,
	});
	await queue.recover();
	if (over.runQueue !== false) queue.start();
	world.start();
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await world.close();
		foreground.stop();
		await queue.close(1000);
		await inference.close();
		await store.close();
	};
	closers.push(close);
	const jobs = () => queue.list({ kind: WORLD_EXTRACT_KIND }, null, 100).items;
	const q = <T>(sql: string, ...args: (string | number)[]) =>
		store.read((db) => db.query(sql).all(...args)) as T[];
	return {
		dir,
		close,
		store,
		conversation,
		queue,
		inference,
		foreground: foreground.hub,
		world,
		jobs,
		q,
		larmCalls,
		cloudRequests: () => cloudRequests,
		cloudAttempts: () =>
			q<{ n: number }>(
				"SELECT COUNT(*) AS n FROM inference_attempts WHERE source = 'cloud'",
			)[0]!.n,
		async register() {
			expect(
				(
					await world.service.apply({
						access: manualAccess(),
						scope: SCOPE,
						operationKey: "e-1",
						clock: 1791500000000,
						operation: {
							kind: "entity.register",
							entity: {
								id: ENTITY.id,
								displayName: ENTITY.displayName,
								aliases: ENTITY.aliases,
								externalRefs: [],
							},
						},
					})
				).status,
			).toBe("applied");
		},
		async say(id: string, text: string) {
			await conversation.append({
				id,
				conversationId: "c1",
				role: "user",
				text,
				createdAt: "2026-10-09T00:00:00.000Z",
				runId: null,
			});
		},
	};
}

const utteranceIdOf = (messages: { content: string }[]): string =>
	(
		JSON.parse(messages[1]!.content) as {
			utterances: { utteranceId: string }[];
		}
	).utterances[0]!.utteranceId;
const candidateFor = (id: string) =>
	JSON.stringify({
		candidates: [
			{
				subject: { kind: "id", id: "svc-1" },
				predicate: "available",
				payload: { kind: "value", value: { kind: "boolean", value: true } },
				quote: { utteranceId: id, startByte: 0, endByte: 18 },
				modality: "asserted",
			},
		],
	});
type Harness = Awaited<ReturnType<typeof boot>>;
const assertions = (h: Harness) =>
	h.q<{ id: string }>("SELECT id FROM world_assertion");
const events = (h: Harness) =>
	h.q<{ state: string; failures: number; job_id: string | null }>(
		"SELECT state, failures, job_id FROM world_host_extract_event ORDER BY seq",
	);
const isExtraction = (options: Record<string, unknown> | undefined) =>
	options?.["jsonOutput"] === true;

/** A queue job in the interactive lane that stays open until released (a conversation turn). */
function interactiveTurn(h: Harness) {
	let release: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.queue.registerHandler({
		kind: "test.turn",
		payloadVersions: [1],
		schema: z.object({}),
		recovery: "interrupt",
		resourceKey: "turn.slot",
		prepareInTransaction: () => ({ status: "ready", input: {} }),
		execute: async () => {
			await done;
			return {};
		},
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	} as never);
	return {
		release,
		async start() {
			await h.queue.enqueue({
				scope: "dialogue",
				kind: "test.turn",
				dedupeKey: `turn-${Math.random()}`,
				payload: {},
				lane: "interactive",
			});
		},
	};
}

test("A44 an interactive queue job is the foreground: nothing is scheduled while it is open, the held input resumes by itself after it", async () => {
	const h = await boot(async (messages) =>
		candidateFor(utteranceIdOf(messages)),
	);
	await h.register();
	const turn = interactiveTurn(h);
	await turn.start();
	await until(() => h.foreground.active());
	await h.say("m1", TEXT);
	await h.world.pump();
	await pause(150);
	// Received, checkpointed, but no job and no model request while the turn runs.
	expect(h.jobs()).toHaveLength(0);
	expect(h.larmCalls).toHaveLength(0);
	expect(events(h)).toEqual([{ state: "received", failures: 0, job_id: null }]);
	turn.release();
	// The foreground ended: the held input is picked up with no further trigger.
	await until(() => h.jobs().some((j) => j.state === "completed"));
	expect(assertions(h)).toHaveLength(1);
	expect(events(h)[0]).toMatchObject({ state: "applied", failures: 0 });
	expect(h.larmCalls.filter((c) => isExtraction(c.options))).toHaveLength(1);
	expect(h.cloudRequests()).toBe(0);
}, 30_000);

test("A44 a conversation answer running in the inference service is the foreground", async () => {
	let finish: (text: string) => void = () => {};
	const h = await boot(async (messages, _signal, options) => {
		if (isExtraction(options)) return candidateFor(utteranceIdOf(messages));
		return new Promise<string>((resolve) => {
			finish = resolve;
		});
	});
	await h.register();
	expect(h.inference.foregroundBusy()).toBe(false);
	const answer = h.inference.answer(
		[{ role: "user", content: "こんにちは" }],
		new AbortController().signal,
	);
	await until(() => h.inference.foregroundBusy());
	expect(h.foreground.active()).toBe(true);
	await h.say("m1", TEXT);
	await h.world.pump();
	await pause(150);
	expect(h.jobs()).toHaveLength(0);
	finish("やあ");
	await answer;
	await until(() => h.jobs().some((j) => j.state === "completed"));
	expect(assertions(h)).toHaveLength(1);
	// The extraction's own request never counted as foreground.
	expect(h.inference.foregroundBusy()).toBe(false);
}, 30_000);

test("A44 a foreground start cancels the running extraction: the call ends, the Local job slot is free, the same input is extracted by a new attempt afterwards", async () => {
	let started = 0;
	let aborted = 0;
	const h = await boot(
		(messages, signal, options) => {
			if (!isExtraction(options)) return Promise.resolve("ok");
			started += 1;
			if (started > 1)
				return Promise.resolve(candidateFor(utteranceIdOf(messages)));
			return new Promise<string>((_resolve, reject) =>
				signal.addEventListener("abort", () => {
					aborted += 1;
					reject(new Error("aborted"));
				}),
			);
		},
		{ stageBudgetMs: 10_000, confirmMs: 2000 },
	);
	await h.register();
	await h.say("m1", TEXT);
	await h.world.pump();
	await until(() => started === 1);
	const turn = h.foreground.hold("voice");
	await until(() => aborted === 1);
	// The first job did not adopt anything and did not penalise the input.
	await until(() => h.jobs().every((j) => j.state !== "running"));
	expect(assertions(h)).toHaveLength(0);
	expect(events(h)[0]).toMatchObject({ state: "received", failures: 0 });
	expect(h.queue.stats().resources["inference.llm"]!.inUse).toBe(0);
	const before = started;
	await pause(150);
	// Still foreground: no further model call.
	expect(started).toBe(before);
	turn();
	await until(() => assertions(h).length === 1, 8000);
	expect(events(h)[0]).toMatchObject({ state: "applied", failures: 0 });
	expect(started).toBe(2);
	expect(h.cloudRequests()).toBe(0);
	// Never more than one Local extraction at a time.
	const running = h.jobs().filter((j) => j.state === "running");
	expect(running).toHaveLength(0);
}, 30_000);

test("A44 a cancel the provider never answers keeps the slot: no second extraction call until the provider really ends it", async () => {
	let started = 0;
	let finish: (text: string) => void = () => {};
	const h = await boot(
		(messages, _signal, options) => {
			if (!isExtraction(options)) return Promise.resolve("ok");
			started += 1;
			if (started > 1)
				return Promise.resolve(candidateFor(utteranceIdOf(messages)));
			return new Promise<string>((resolve) => {
				finish = resolve;
			}); // ignores the abort
		},
		{ stageBudgetMs: 10_000, confirmMs: 100, ignoreAbort: true },
	);
	await h.register();
	await h.say("m1", TEXT);
	await h.world.pump();
	await until(() => started === 1);
	const turn = h.foreground.hold("tts");
	await until(() => h.jobs().some((j) => j.state === "failed"));
	expect(h.jobs()[0]).toMatchObject({
		errorCode: "extract_foreground_unconfirmed",
	});
	turn();
	// The foreground is over; the provider call is not: nothing new starts.
	await h.world.pump();
	await pause(300);
	expect(started).toBe(1);
	expect(assertions(h)).toHaveLength(0);
	expect(events(h)[0]).toMatchObject({ state: "received", failures: 0 });
	// The provider finally ends it (the late result is NOT adopted); input resumes.
	finish("{}");
	await until(() => assertions(h).length === 1, 8000);
	expect(started).toBe(2);
	expect(events(h)[0]).toMatchObject({ state: "applied" });
}, 30_000);

test("A44 a restart with a held input: the unextracted input survives and is extracted after the foreground is gone", async () => {
	const first = await boot(async () => "{}", { runQueue: false });
	await first.register();
	const turn = first.foreground.hold("asr");
	await first.say("m1", TEXT);
	await first.world.pump();
	await pause(100);
	expect(first.jobs()).toHaveLength(0);
	expect(events(first)).toEqual([
		{ state: "received", failures: 0, job_id: null },
	]);
	turn();
	const dir = first.dir;
	await first.close();
	const second = await boot(
		async (messages) => candidateFor(utteranceIdOf(messages)),
		{ dir },
	);
	await second.world.pump({ full: true });
	await until(() => assertions(second).length === 1, 8000);
	expect(events(second)[0]).toMatchObject({ state: "applied", failures: 0 });
}, 30_000);
