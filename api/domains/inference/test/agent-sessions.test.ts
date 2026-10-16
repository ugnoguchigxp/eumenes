import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	migrations as inferenceMigrations,
} from "..";
import type { CloudAgentCall, CloudAgents } from "../adapters/cloud-agents";
import type { Receipt } from "../contracts";
import { createAgentSweeper } from "../service/agent-sweep";
import {
	acquireAgentSession,
	releaseTaskSessions,
	sweepTaskSessions,
	TASK_SESSION_TTL_MS,
} from "../service/agent-session";
import { waitFor } from "../../../infrastructure/wait-for";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hi" },
	{ role: "assistant" as const, content: "hello" },
	{ role: "user" as const, content: "now" },
];
const context = { instructionCount: 1, historyCount: 2 };

/** A real store and settings with one Claude Agent SDK connection serving the conversation (cloud only). */
async function setup(run: CloudAgents["run"]) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-agent-sessions-"));
	const store = openStore(join(dir, "test.db"), [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		...inferenceMigrations.slice(4).map((m) => m.sql),
	]);
	const settings = await createSettings(store, {
		dbPath: join(dir, "test.db"),
		env: {},
	});
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	s.connections.push({
		id: connectionId,
		name: "Agent",
		kind: "claude-agent-sdk",
		auth: "api-key",
		baseUrl: "https://api.anthropic.com",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	s.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: "fixture-model",
		contextWindow: 100_000,
		voice: null,
	});
	s.routes.llm.mode = "cloud-only";
	s.routes.llm.cloudAllowed = true;
	s.routes.llm.fallbackId = resourceId;
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId, value: "fixture-key" }],
	});
	const inference = createInference(store, settings, {
		cloudAgents: { run },
	});
	cleanup.push(async () => {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const request = () =>
		store.write((db) =>
			inference.captureInTransaction(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 60_000,
			),
		);
	return { store, inference, connectionId, request };
}
const stream = (
	h: Awaited<ReturnType<typeof setup>>,
	id: string,
	signal: AbortSignal,
	session: Parameters<
		NonNullable<Awaited<ReturnType<typeof setup>>["inference"]["executeStream"]>
	>[6],
) =>
	h.inference.executeStream(
		id,
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		session,
	);

test("a main call uses the ledger's one session id per connection, auth and model, and records what it stood on", async () => {
	const seen: CloudAgentCall[] = [];
	const h = await setup(async (call) => {
		seen.push(call);
		return { text: "answer", contextWindow: 200_000 };
	});
	const signal = new AbortController().signal;
	const refs = { messageIds: ["m1", "m2"], itemIds: ["i1"] };
	await stream(h, await h.request(), signal, {
		sessionRole: "main",
		context,
		refs,
	});
	await stream(h, await h.request(), signal, {
		sessionRole: "main",
		context,
	});
	expect(seen).toHaveLength(2);
	expect(seen[0]!.session).toMatchObject({ role: "main", context });
	expect(seen[0]!.connectionId).toBe(h.connectionId);
	expect(seen[1]!.session!.id).toBe(seen[0]!.session!.id);
	expect(seen[0]!.session!.id).toMatch(/^[0-9a-f-]{36}$/);
	const rows = h.store.read((db) => ({
		sessions: db
			.query(
				"SELECT id,role,task_id,connection_id,auth,model,learned_context_window FROM inference_agent_sessions",
			)
			.all(),
		attempts: db
			.query(
				"SELECT agent_session_id,refs,session_role FROM inference_attempts ORDER BY started,rowid",
			)
			.all(),
	}));
	expect(rows.sessions).toEqual([
		{
			id: seen[0]!.session!.id,
			role: "main",
			task_id: null,
			connection_id: h.connectionId,
			auth: "api-key",
			model: "fixture-model",
			learned_context_window: 200_000,
		},
	]);
	expect(rows.attempts).toEqual([
		{
			agent_session_id: seen[0]!.session!.id,
			refs: JSON.stringify(refs),
			session_role: "main",
		},
		{
			agent_session_id: seen[0]!.session!.id,
			refs: null,
			session_role: "main",
		},
	]);
});

test("a one-shot call has no session; the context and references are validated", async () => {
	const seen: CloudAgentCall[] = [];
	const h = await setup(async (call) => {
		seen.push(call);
		return { text: "answer" };
	});
	const signal = new AbortController().signal;
	await stream(h, await h.request(), signal, { sessionRole: "auxiliary" });
	await stream(h, await h.request(), signal, undefined);
	expect(seen.map((c) => c.session)).toEqual([undefined, undefined]);
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM inference_agent_sessions").get(),
		),
	).toEqual({ n: 0 });
	for (const session of [
		{ sessionRole: "auxiliary" as const, context },
		{ sessionRole: "main" as const, context: { ...context, historyCount: -1 } },
		{
			sessionRole: "main" as const,
			refs: { messageIds: [""], itemIds: [] },
		},
	])
		await expect(stream(h, await h.request(), signal, session)).rejects.toThrow(
			/invalid_session_(context|refs)/,
		);
	expect(seen).toHaveLength(2);
});

test("a sub-agent call keeps one session per task; releasing the task, or the TTL, removes it", async () => {
	const seen: CloudAgentCall[] = [];
	const h = await setup(async (call) => {
		seen.push(call);
		return { text: "answer" };
	});
	const signal = new AbortController().signal;
	for (const taskId of ["task-a", "task-a", "task-b"])
		await stream(h, await h.request(), signal, {
			sessionRole: "subagent",
			taskId,
		});
	expect(seen.map((c) => c.session!.role)).toEqual([
		"subagent",
		"subagent",
		"subagent",
	]);
	expect(seen[1]!.session!.id).toBe(seen[0]!.session!.id);
	expect(seen[2]!.session!.id).not.toBe(seen[0]!.session!.id);
	// A sub-agent never resumes a history: the host sends no context for it.
	expect(seen[0]!.session!.context).toBeUndefined();
	const count = () =>
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT COUNT(*) AS n FROM inference_agent_sessions")
						.get() as { n: number }
				).n,
		);
	expect(count()).toBe(2);
	await h.inference.releaseTaskSession("task-a");
	expect(count()).toBe(1);
	// Unreleased sessions expire; a main session never does.
	await acquireAgentSession(h.store, {
		role: "main",
		connectionId: h.connectionId,
		auth: "api-key",
		model: "m",
	});
	expect(await sweepTaskSessions(h.store, Date.now() + 1000)).toBe(0);
	expect(
		await sweepTaskSessions(h.store, Date.now() + TASK_SESSION_TTL_MS + 1000),
	).toBe(1);
	expect(count()).toBe(1);
	await releaseTaskSessions(h.store, "task-b");
	expect(count()).toBe(1);
});

test("the SDK's own delete drops the ledger row (the ledger holds no history)", async () => {
	let dropped: (() => Promise<void>) | undefined;
	const h = await setup(async (call) => {
		dropped = call.session!.drop;
		return { text: "answer" };
	});
	await stream(h, await h.request(), new AbortController().signal, {
		sessionRole: "main",
		context,
	});
	await dropped!();
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM inference_agent_sessions").get(),
		),
	).toEqual({ n: 0 });
});

const forget = (
	h: Awaited<ReturnType<typeof setup>>,
	input: {
		messageIds: string[];
		itemIds: string[];
		deletedSummaryConversationIds?: string[];
	},
) =>
	h.store.write((db) =>
		h.inference.revokeAgentAttemptsInTransaction(db, {
			deletedSummaryConversationIds: [],
			...input,
		}),
	);

test("forgetting what a running agent call stood on aborts it, and its attempt is never adopted", async () => {
	let aborted = false;
	let started!: () => void;
	const running = new Promise<void>((resolve) => (started = resolve));
	const h = await setup(
		(call) =>
			new Promise((_, reject) => {
				started();
				call.signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			}),
	);
	const id = await h.request();
	const call = stream(h, id, new AbortController().signal, {
		sessionRole: "main",
		context,
		refs: { messageIds: ["m1"], itemIds: ["i1"] },
	});
	const settled = call.then(
		() => "resolved",
		(error: Error) => error.message,
	);
	await running;
	// Another reference leaves it running.
	await forget(h, { messageIds: ["other"], itemIds: ["other"] });
	expect(aborted).toBe(false);
	await forget(h, { messageIds: [], itemIds: ["i1"] });
	expect(await settled).not.toBe("resolved");
	expect(aborted).toBe(true);
	expect(
		h.store.read((db) =>
			db.query("SELECT status,reason,accepted FROM inference_attempts").all(),
		),
	).toEqual([{ status: "revoked", reason: "memory_forgotten", accepted: 0 }]);
	// Replaying the purge (startup) finds nothing left to revoke.
	await forget(h, { messageIds: ["m1"], itemIds: ["i1"] });
	expect(
		h.store.read((db) =>
			db.query("SELECT status FROM inference_attempts").all(),
		),
	).toEqual([{ status: "revoked" }]);
});

test("an answer that finished before the forget is revoked too: its receipt is refused at adoption", async () => {
	const h = await setup(async () => ({ text: "answer" }));
	const receipt: Receipt = await stream(
		h,
		await h.request(),
		new AbortController().signal,
		{
			sessionRole: "main",
			context,
			refs: { messageIds: ["m1"], itemIds: [] },
		},
	);
	const valid = () =>
		h.store.read((db) => h.inference.validateReceiptInTransaction(db, receipt));
	expect(valid()).toBe(true);
	await forget(h, { messageIds: ["m1"], itemIds: [] });
	expect(valid()).toBe(false);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
});

test("deleting a conversation's summary revokes the running and the finished-but-unadopted calls of that conversation only", async () => {
	const h = await setup(async () => ({ text: "answer" }));
	const mine = await stream(
		h,
		await h.request(),
		new AbortController().signal,
		{
			sessionRole: "main",
			context,
			refs: { messageIds: [], itemIds: [], conversationId: "conv-1" },
		},
	);
	const other = await stream(
		h,
		await h.request(),
		new AbortController().signal,
		{
			sessionRole: "main",
			context,
			refs: { messageIds: [], itemIds: [], conversationId: "conv-2" },
		},
	);
	const valid = (receipt: Receipt) =>
		h.store.read((db) => h.inference.validateReceiptInTransaction(db, receipt));
	await forget(h, {
		messageIds: [],
		itemIds: [],
		deletedSummaryConversationIds: ["conv-1"],
	});
	expect(valid(mine)).toBe(false);
	expect(valid(other)).toBe(true);
});

test("the sweeper reclaims an expired task row that was written back after the release, on its timer and not only at start", async () => {
	const h = await setup(async () => ({ text: "answer" }));
	const sweeper = createAgentSweeper(h.store, 10);
	const rows = () =>
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT COUNT(*) AS n FROM inference_agent_sessions")
						.get() as { n: number }
				).n,
		);
	await sweeper.start();
	// An attempt that outlived its task wrote its row again, untouched since long ago.
	await acquireAgentSession(
		h.store,
		{
			role: "subagent",
			taskId: "task-late",
			connectionId: h.connectionId,
			auth: "api-key",
			model: "fixture-model",
		},
		0,
	);
	expect(rows()).toBe(1);
	await waitFor(() => rows() === 0);
	expect(rows()).toBe(0);
	sweeper.stop();
	await acquireAgentSession(
		h.store,
		{
			role: "subagent",
			taskId: "task-after-stop",
			connectionId: h.connectionId,
			auth: "api-key",
			model: "fixture-model",
		},
		0,
	);
	await Bun.sleep(60);
	expect(rows()).toBe(1);
});
