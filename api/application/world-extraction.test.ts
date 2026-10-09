/**
 * P4-02 on the REAL queue and the REAL inference service: a temp-file store
 * with the production migrations, `createQueue`, `createInference`, and the
 * World assembly from `./world` (the code `server.ts` runs).
 *
 * Fixture-grade, stated plainly: the LARM provider is a stub port (no real
 * Local Provider was run; see world-real-local-provider.test.ts). The Cloud
 * path is armed - a connection, a key and a fallback resource are configured -
 * and its `fetch` is a spy, so "no Cloud request" is observed, not assumed.
 * The stub is the registered LARM section of the settings; that registration,
 * not a LAN address, is what makes a provider Local here.
 *
 * Lives in api/application because it wires queue and inference with World;
 * the world domain may not depend on them.
 */
import { afterEach, expect, test } from "bun:test";
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
			inference: inference as unknown as ExtractionInference,
			entities: () => [ENTITY],
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
const assertions = (h: Awaited<ReturnType<typeof boot>>) =>
	h.q<{ id: string; lifecycle: string; origin: string }>(
		"SELECT id, lifecycle, origin FROM world_assertion",
	);
const events = (h: Awaited<ReturnType<typeof boot>>) =>
	h.q<{ state: string; failures: number }>(
		"SELECT state, failures FROM world_host_extract_event ORDER BY seq",
	);

test("A19/A43 the real queue runs ONE Local job: a candidate is adopted, no Cloud request exists", async () => {
	const h = await boot(async (messages) =>
		candidateFor(utteranceIdOf(messages)),
	);
	await h.register();
	await h.say("m1", TEXT);
	await h.world.pump();
	await until(() => h.jobs().some((j) => j.state === "completed"));
	// The job is the queue's: background lane, the LLM slot, jobs = 1.
	expect(h.jobs()).toHaveLength(1);
	expect(h.jobs()[0]).toMatchObject({ lane: "background", state: "completed" });
	expect(assertions(h)).toHaveLength(1);
	expect(assertions(h)[0]).toMatchObject({
		lifecycle: "candidate",
		origin: "user_report",
	});
	expect(events(h)).toEqual([{ state: "applied", failures: 0 }]);
	// Local only: the control path (JSON output) went to the stub, Cloud was armed and unused.
	expect(h.larmCalls).toHaveLength(1);
	expect(h.larmCalls[0]!.options).toMatchObject({ jsonOutput: true });
	expect(h.cloudRequests()).toBe(0);
	expect(h.cloudAttempts()).toBe(0);
	const request = h.q<{ mode: string; snapshot: string }>(
		"SELECT mode, snapshot FROM inference_requests WHERE subject LIKE 'world-extract:%'",
	);
	expect(request).toHaveLength(1);
	const route = JSON.parse(request[0]!.snapshot).routes.llm;
	expect(route).toMatchObject({ mode: "larm-only", cloudAllowed: false });
	expect(request[0]!.mode).toBe("control");
	// The status stages agree.
	const stage = h.world.lifecycle.feedStages(SCOPE).source;
	expect(stage.applied).toMatchObject({ applied: 1, pending: 0 });
	expect(stage.applied.cursor).not.toBeNull();
});

test("A43 an unavailable Local provider leaves the input pending; the Cloud route that is armed is never used", async () => {
	const h = await boot(async () => {
		throw new Error("larm_control_503");
	});
	await h.register();
	await h.say("m1", TEXT);
	await h.world.pump();
	await until(() => h.jobs().some((j) => j.state === "failed"));
	expect(assertions(h)).toHaveLength(0);
	expect(events(h)).toEqual([{ state: "received", failures: 1 }]);
	expect(h.cloudRequests()).toBe(0);
	expect(h.cloudAttempts()).toBe(0);
	// Backed off: another pass creates no job and calls no model.
	const calls = h.larmCalls.length;
	await h.world.pump();
	await pause(100);
	expect(h.jobs()).toHaveLength(1);
	expect(h.larmCalls).toHaveLength(calls);
});

test("A43 the 30 s stage budget (80 ms here) cancels the call and the job fails after one retry", async () => {
	let aborted = 0;
	const h = await boot(
		(_messages, signal) =>
			new Promise<string>((_resolve, reject) =>
				signal.addEventListener("abort", () => {
					aborted += 1;
					reject(new Error("aborted"));
				}),
			),
		{ stageBudgetMs: 80, confirmMs: 200 },
	);
	await h.register();
	await h.say("m1", TEXT);
	await h.world.pump();
	await until(() => h.jobs().some((j) => j.state === "failed"), 8000);
	expect(aborted).toBe(2);
	expect(h.jobs()[0]).toMatchObject({ errorCode: "extract_timeout" });
	expect(assertions(h)).toHaveLength(0);
	expect(events(h)[0]).toMatchObject({ state: "received", failures: 1 });
	expect(h.cloudRequests()).toBe(0);
	expect(h.cloudAttempts()).toBe(0);
});

test("no input, no job: an idle World creates no extraction job and no model call", async () => {
	const h = await boot(async () => "{}");
	await h.register();
	for (let i = 0; i < 3; i++) await h.world.pump({ full: true });
	await pause(100);
	expect(h.jobs()).toHaveLength(0);
	expect(h.larmCalls).toHaveLength(0);
	// An assistant-only turn is no input either.
	await h.conversation.append({
		id: "a1",
		conversationId: "c1",
		role: "assistant",
		text: "承知しました。",
		createdAt: "2026-10-09T00:00:00.000Z",
		runId: null,
	});
	await h.world.pump();
	await pause(100);
	expect(h.jobs()).toHaveLength(0);
	expect(h.larmCalls).toHaveLength(0);
});

test("protect mode registers no extraction handler: no job kind exists, input is never delivered", async () => {
	const h = await boot(async () => "{}", { mode: "protect" });
	expect(h.world.extraction).toBeUndefined();
	await h.say("m1", TEXT);
	await h.world.pump();
	await expect(
		h.queue.enqueue({
			scope: "world",
			kind: WORLD_EXTRACT_KIND,
			dedupeKey: "x",
			payload: {},
			lane: "background",
		}),
	).rejects.toThrow("invalid_unknown_job_kind");
	expect(h.q("SELECT 1 FROM world_inbox")).toHaveLength(0);
	expect(h.larmCalls).toHaveLength(0);
});

test("A42 a restart resumes the unapplied inbox: the input received before the stop is extracted after it", async () => {
	const first = await boot(async () => "{}", { runQueue: false });
	await first.register();
	await first.say("m1", TEXT);
	await first.world.pump();
	await until(() => first.jobs().length === 1);
	// Received and scheduled, but the process stops before anything ran.
	expect(events(first)).toEqual([{ state: "received", failures: 0 }]);
	expect(first.larmCalls).toHaveLength(0);
	expect(first.world.lifecycle.feedStages(SCOPE).source.applied).toMatchObject({
		cursor: null,
		pending: 1,
	});
	await first.close();

	const second = await boot(
		async (messages) => candidateFor(utteranceIdOf(messages)),
		{ dir: first.dir },
	);
	await until(() => second.jobs().some((j) => j.state === "completed"));
	expect(assertions(second)).toHaveLength(1);
	expect(events(second)).toEqual([{ state: "applied", failures: 0 }]);
	// Received once: the restart did not deliver the input again.
	expect(second.q("SELECT 1 FROM world_inbox")).toHaveLength(1);
	expect(second.cloudRequests()).toBe(0);
});
