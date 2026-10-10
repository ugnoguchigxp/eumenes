import { withLanguageControl } from "./control-fixture";
/**
 * P3-08 / A41: a World-backed answer's body and speech are released only by
 * adoption. The real dialogue handler, queue runner, Writer, World Broker and
 * voice service run on a temp-file store with the production migrations; the
 * test observes BOTH what a browser would receive (the run's SSE bytes through
 * the real controller, the voice turn) and a TTS call spy:
 *   before adoption  : 0 body events, 0 TTS calls (also across reconnects)
 *   invalidation     : 0 and 0 forever, including after reconnect
 *   adoption         : the complete body once; speech once; a reconnect or
 *                      resubscribe repeats the body snapshot but never speaks
 *   blocked World    : a failure reporting worldUsed + worldBlocked
 *   general chat     : unchanged (live partial text, speech after completion)
 *
 * Fixture-grade: explicit structured claims, a fixture inference port that
 * gates its own output and a fixture TTS spy. No real provider, no real
 * browser, no real audio device.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { planAssertionTransition } from "eumenes-world-model";
import { migrations } from "../../../application/migrations";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../../conversation";
import {
	createDialogueService,
	registerDialogue,
	type WorldContextPort,
} from "../../dialogue";
import type { RunProgress } from "../../dialogue/contracts";
import { createGoalsService, type Goal } from "../../goals";
import type { InferencePort, Receipt } from "../../inference";
import { createQueue } from "../../queue";
import {
	createConversationSourceAdapter,
	createWorldContextBroker,
	createWorldHostGate,
	createWorldLifecycle,
	createWorldService,
	sourceKeyOf,
	type PreparedWorldContext,
} from "../../world";
import { createVoiceDialogue, registerVoiceDialogue } from "..";

const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const PURPOSE = "dialogue.read";
const ANSWER = "九月から利用できます。ご案内します。";
const wav = (() => {
	const b = new Uint8Array(44);
	b.set(new TextEncoder().encode("RIFF"), 0);
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
})();

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 4000) {
	for (let i = 0; i < ms / 10; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});

type Cause = "correction" | "forget" | "policy" | "goal";
type Hooks = {
	/** The fixture model: first delta produced, the rest not yet. */
	duringGeneration?: (runId: string) => Promise<void>;
	/** The fixture model: the text is complete, the receipt not yet returned. */
	beforeSettle?: (runId: string) => Promise<void>;
};

const memoryPolicyRevision = (db: import("bun:sqlite").Database): string =>
	String(
		(
			db
				.query("SELECT revision FROM memory_host_settings WHERE id = 1")
				.get() as { revision: number }
		).revision,
	);

function claimOf(id: string, source: unknown) {
	return {
		id,
		revision: 1,
		scope: SCOPE,
		subjectId: "svc-1",
		predicate: "available",
		payload: { kind: "value", value: { kind: "boolean", value: true } },
		evidence: [
			{
				evidenceId: `ev-${id}`,
				kind: "user_statement",
				stance: "supports",
				source,
				rootEvidenceId: `root-${id}`,
			},
		],
		inputManifest: [source],
		origin: "user_report",
		recordedAt: Date.now() - 1000,
		freshnessPolicy: { maxAgeMs: 86_400_000 },
		condition: { kind: "unspecified" },
		supersedes: [],
		contradicts: [],
		interpretationVersion: "interp-1",
		lifecycle: "candidate",
		rootEvidenceIds: [`root-${id}`],
	};
}
function adoptPlanOf(id: string) {
	const result = planAssertionTransition({
		contractVersion: 1,
		scope: SCOPE,
		current: {
			id,
			revision: 1,
			scope: SCOPE,
			lifecycle: "candidate",
			origin: "user_report",
		},
		expectedRevision: 1,
		request: {
			action: "adopt",
			adoption: { kind: "explicit", operationId: `op-adopt-${id}` },
			subjectConfirmedByHost: true,
		},
		registeredAdoptionRules: [],
	} as never);
	if (!result.ok || result.value.status !== "planned")
		throw new Error("plan failed");
	return result.value.plan;
}

/** What a browser holds for one run stream: every frame, per connection. */
function watchRun(app: Hono, runId: string) {
	const frames: RunProgress[] = [];
	const controller = new AbortController();
	const done = (async () => {
		const response = await app.request(
			new Request(`http://local/api/runs/${runId}/stream`, {
				signal: controller.signal,
			}),
		);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let end: number;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const raw = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (raw.startsWith("data:"))
						frames.push(JSON.parse(raw.slice(5).trimStart()));
				}
			}
		} catch {
			/* aborted: a disconnect */
		}
	})();
	return {
		frames,
		bodies: () => frames.filter((f) => f.text !== ""),
		async disconnect() {
			controller.abort();
			await done;
		},
		done,
	};
}

async function setup(
	options: { world?: boolean; totalBytes?: number; goal?: boolean } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-voice-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const gate = createWorldHostGate("closed");
	const adapter = createConversationSourceAdapter(conversation, {
		allowedPurposes: [PURPOSE],
		cursorSecret: "voice-test-cursor-secret",
	});
	const world = createWorldService({
		store,
		policyRevision: memoryPolicyRevision,
		sources: [adapter],
		gate,
	});
	const lifecycle = createWorldLifecycle({
		store,
		world,
		journalPath: join(dir, "world-journal.jsonl"),
		gate,
		purpose: PURPOSE,
		sources: [adapter],
		scopes: [SCOPE],
	});
	await lifecycle.recoverWorld();
	const goals = createGoalsService(store);
	if (options.world !== false) {
		await world.markInitialSyncComplete();
		await world.setEnabled(true);
	}
	await conversation.append({
		id: "m1",
		conversationId: "facts",
		role: "user",
		text: "音声サービスは9月から利用できる。",
		createdAt: new Date().toISOString(),
		runId: null,
	});
	const sourceRef = () => {
		const state = store.read((db) =>
			conversation.sourceInTransaction(db, "m1"),
		);
		if (state.state !== "available") throw new Error("no source");
		return {
			namespace: "conversation",
			kind: "message",
			id: "m1",
			representation: "text",
			revision: state.revision,
			digest: state.digest,
		};
	};
	const must = async (key: string, operation: unknown) => {
		const result = await world.apply({
			access: {
				principal: SCOPE.principal,
				scopeKeys: [SCOPE.scopeKey],
				purpose: PURPOSE,
			},
			scope: SCOPE,
			operationKey: key,
			clock: Date.now(),
			operation: operation as never,
		});
		if (result.status !== "applied") throw new Error(JSON.stringify(result));
	};
	if (options.world !== false) {
		await must("e-1", {
			kind: "entity.register",
			entity: {
				id: "svc-1",
				displayName: "音声サービス",
				aliases: ["音声"],
				externalRefs: [],
			},
		});
		await must("c-1", {
			kind: "assertion.register",
			assertion: claimOf("claim-1", sourceRef()),
		});
		await must("ad-1", {
			kind: "assertion.transition",
			plan: adoptPlanOf("claim-1"),
		});
	}
	const access = { principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] };
	let goal: Goal | undefined;
	if (options.goal)
		goal = await goals.adopt(access, {
			scopeKey: SCOPE.scopeKey,
			desiredState: "来週までに音声機能を公開する",
			source: { namespace: "conversation", kind: "message", id: "m1" },
		});

	// --- fixture inference + TTS spy -------------------------------------
	const hooks: Hooks = {};
	const spoken: string[] = [];
	let sends = 0;
	let lastRun = "";
	const larm: InferencePort = withLanguageControl({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: async () => {
			throw new Error("fixture answers through executeStream");
		},
		transcribe: async () => "音声サービスはいつから使えますか？",
		speak: async (text: string) => {
			spoken.push(text);
			return wav;
		},
		close: async () => {},
		requestFor: (_db, subject, purpose) =>
			purpose === "llm" ? `req-${subject}` : null,
		validRequest: () => true,
		executeStream: async (requestId, _messages, _signal, onDelta) => {
			sends += 1;
			onDelta(ANSWER.slice(0, 4));
			if (hooks.duringGeneration) await hooks.duringGeneration(lastRun);
			onDelta(ANSWER.slice(4));
			if (hooks.beforeSettle) await hooks.beforeSettle(lastRun);
			const receipt: Receipt = {
				requestId,
				attemptId: `att-${sends}`,
				value: ANSWER,
			};
			return receipt;
		},
		executeRequest: async () => {
			throw new Error("fixture streams");
		},
		acceptInTransaction: () => true,
	});
	const queue = createQueue(store);
	queue.start();
	let worldContext: WorldContextPort | undefined;
	const broker = createWorldContextBroker({
		store,
		world,
		purpose: PURPOSE,
		...(options.totalBytes === undefined
			? {}
			: { totalBytes: options.totalBytes }),
	});
	worldContext = {
		prepareInTransaction(db, input) {
			lastRun = input.runId;
			return broker.prepareInTransaction(db, input);
		},
		checkBeforeSend: (context) =>
			broker.checkBeforeSend(context as PreparedWorldContext),
		validateInTransaction: (db, input, context) =>
			broker.validateInTransaction(db, input, context as PreparedWorldContext),
		recordUsageInTransaction: (db, input, context) =>
			broker.recordUsageInTransaction(
				db,
				input,
				context as PreparedWorldContext,
			),
		releaseInTransaction: (db, runId, conversationId) =>
			broker.releaseInTransaction(db, runId, conversationId),
	};
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		worldContext,
	});
	const voice = createVoiceDialogue(store, dialogue, larm);
	const app = new Hono();
	registerDialogue(app, dialogue);
	registerVoiceDialogue(app, voice);
	const sessionId = crypto.randomUUID();
	voice.start(sessionId, 1);

	const h = {
		store,
		conversation,
		lifecycle,
		goals,
		goal,
		dialogue,
		voice,
		app,
		queue,
		hooks,
		spoken,
		sends: () => sends,
		/** One spoken question through the real voice path; resolves with the turn id. */
		async speak() {
			const utteranceId = crypto.randomUUID();
			await voice.accept(sessionId, 1, h.sequence++, utteranceId, wav);
			await until(() => !!voice.get(utteranceId)?.runId);
			return { utteranceId, runId: voice.get(utteranceId)!.runId! };
		},
		sequence: 1,
		turn: (id: string) => voice.get(id)!,
		answers: () =>
			conversation
				.get("main")
				.messages.filter((m) => m.role === "assistant")
				.map((m) => m.text),
		usageRows: () =>
			store.read(
				(db) =>
					db.query("SELECT run_id FROM world_host_usage").all() as {
						run_id: string;
					}[],
			),
		mutate(cause: Cause): Promise<unknown> {
			switch (cause) {
				case "correction":
					return conversation.correct({
						messageId: "m1",
						text: "10月から利用できる。",
					});
				case "forget":
					return lifecycle.acceptForget({
						forgetId: `forget-${crypto.randomUUID()}`,
						scope: SCOPE,
						reasonCode: "FORGET_REQUESTED",
						roots: [
							{
								kind: "source",
								id: sourceKeyOf({
									namespace: "conversation",
									kind: "message",
									id: "m1",
									representation: "text",
								}),
							},
						],
					});
				case "policy":
					return store.write((db) => {
						db.query(
							"UPDATE memory_host_settings SET revision = revision + 1 WHERE id = 1",
						).run();
					});
				case "goal":
					return goals.withdraw(access, goal!.id, {
						expectedRevision: goal!.revision,
						source: { namespace: "conversation", kind: "message", id: "m1" },
					});
			}
		},
		async terminal(utteranceId: string) {
			await until(() =>
				["failed", "ready", "played", "completed", "cancelled"].includes(
					voice.get(utteranceId)?.status ?? "",
				),
			);
			// Let any (wrongly) late speech show up before the caller counts it.
			await pause(150);
			return voice.get(utteranceId)!;
		},
	};
	open.push(async () => {
		await voice.close().catch(() => {});
		await queue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	return h;
}
const CAUSES: Cause[] = ["correction", "forget", "policy", "goal"];

for (const cause of CAUSES) {
	test(`A41 invalidation by ${cause} mid-generation: 0 body events, 0 TTS calls, also after reconnect`, async () => {
		const h = await setup({ goal: cause === "goal" });
		let watch: ReturnType<typeof watchRun> | undefined;
		let midFrames = 0;
		let midSpoken = 0;
		h.hooks.duringGeneration = async (runId) => {
			// First delta exists; a browser is attached and sees nothing of it.
			watch = watchRun(h.app, runId);
			await pause(60);
			midFrames = watch.bodies().length;
			midSpoken = h.spoken.length;
			await h.mutate(cause);
		};
		const { utteranceId, runId } = await h.speak();
		const turn = await h.terminal(utteranceId);
		await watch!.done;
		expect(h.sends()).toBe(1);
		// Before invalidation: nothing public, nothing spoken.
		expect([midFrames, midSpoken]).toEqual([0, 0]);
		// The run failed, World was used, and it is NOT a plain success.
		const run = h.dialogue.get(runId)!;
		expect(run.status).toBe("failed");
		expect(run.worldUsed).toBe(true);
		expect(turn.status).toBe("failed");
		expect(turn.worldUsed).toBe(true);
		// Not one body event on the first connection; the end state is a failure.
		expect(watch!.bodies()).toEqual([]);
		expect(watch!.frames.at(-1)).toMatchObject({
			status: "failed",
			text: "",
			worldUsed: true,
		});
		// Nothing spoken, no answer stored, no receipt.
		expect(h.spoken).toEqual([]);
		expect(h.answers()).toEqual([]);
		expect(h.usageRows()).toEqual([]);
		expect(turn.audioChunks ?? []).toEqual([]);
		// Reconnect and resubscribe: still nothing, forever.
		const again = watchRun(h.app, runId);
		await again.done;
		expect(again.frames).toHaveLength(1);
		expect(again.bodies()).toEqual([]);
		await pause(150);
		expect(h.spoken).toEqual([]);
		expect(h.answers()).toEqual([]);
	});
}

test("A41 cancel mid-generation drops the unpublished body: 0 body events, 0 TTS calls", async () => {
	const h = await setup();
	let watch: ReturnType<typeof watchRun> | undefined;
	h.hooks.duringGeneration = async (runId) => {
		watch = watchRun(h.app, runId);
		await pause(40);
		await h.dialogue.cancel(runId);
	};
	const { utteranceId, runId } = await h.speak();
	await until(() => h.dialogue.get(runId)?.status === "cancelled");
	await h.voice.cancel(utteranceId);
	await pause(200);
	expect(watch!.bodies()).toEqual([]);
	expect(h.spoken).toEqual([]);
	expect(h.answers()).toEqual([]);
	const again = watchRun(h.app, runId);
	await again.done;
	expect(again.bodies()).toEqual([]);
	expect(again.frames.at(-1)).toMatchObject({ status: "cancelled", text: "" });
});

test("A41 adoption: nothing before it, the complete body once after it, speech once, reconnect repeats no speech", async () => {
	const h = await setup({ goal: true });
	let watch: ReturnType<typeof watchRun> | undefined;
	let reconnect: ReturnType<typeof watchRun> | undefined;
	const before = {
		midBodies: -1,
		midSpoken: -1,
		lateBodies: -1,
		lateSpoken: -1,
		reconnectBodies: -1,
		midProgress: "?",
	};
	h.hooks.duringGeneration = async (runId) => {
		watch = watchRun(h.app, runId);
		await pause(60);
		before.midBodies = watch.bodies().length;
		before.midSpoken = h.spoken.length;
		before.midProgress = h.dialogue.progress(runId)?.text ?? "?";
	};
	h.hooks.beforeSettle = async (runId) => {
		// The whole text exists; the browser disconnects and reconnects before adoption.
		await watch!.disconnect();
		reconnect = watchRun(h.app, runId);
		await pause(60);
		before.lateBodies = watch!.bodies().length;
		before.reconnectBodies = reconnect.bodies().length;
		before.lateSpoken = h.spoken.length;
	};
	const { utteranceId, runId } = await h.speak();
	const turn = await h.terminal(utteranceId);
	await reconnect!.done;
	// Before adoption: 0 body events (both connections), 0 TTS calls, no progress text.
	expect(before).toEqual({
		midBodies: 0,
		midSpoken: 0,
		lateBodies: 0,
		lateSpoken: 0,
		reconnectBodies: 0,
		midProgress: "",
	});
	// After adoption: exactly one complete answer, exactly once on the stream.
	expect(h.answers()).toEqual([ANSWER]);
	expect(h.dialogue.get(runId)).toMatchObject({
		status: "completed",
		worldUsed: true,
		worldBlocked: false,
	});
	expect(reconnect!.bodies()).toHaveLength(1);
	expect(reconnect!.bodies()[0]).toMatchObject({
		status: "completed",
		text: ANSWER,
		worldUsed: true,
	});
	expect(h.usageRows()).toHaveLength(1);
	// Speech happened only after adoption, and covers the complete answer once.
	expect(["ready", "played", "completed"]).toContain(turn.status);
	expect(turn.worldUsed).toBe(true);
	expect(h.spoken.join("")).toBe(ANSWER);
	const spokenOnce = h.spoken.length;
	expect(spokenOnce).toBeGreaterThan(0);
	// Reconnect / resubscribe after adoption: the body snapshot again, no new speech.
	for (let i = 0; i < 2; i++) {
		const late = watchRun(h.app, runId);
		await late.done;
		expect(late.frames).toHaveLength(1);
		expect(late.frames[0]).toMatchObject({ status: "completed", text: ANSWER });
		const unsubscribed: RunProgress[] = [];
		const stop = h.dialogue.subscribeProgress(runId, (p) =>
			unsubscribed.push(p),
		);
		stop();
		expect(unsubscribed).toHaveLength(1);
		expect(unsubscribed[0]!.text).toBe(ANSWER);
	}
	await pause(150);
	expect(h.spoken).toHaveLength(spokenOnce);
	expect(h.answers()).toEqual([ANSWER]);
});

test("A41 a blocked World run is reported as blocked (worldUsed), never as a World-less success", async () => {
	const h = await setup({ totalBytes: 2048 });
	const { utteranceId, runId } = await h.speak();
	const turn = await h.terminal(utteranceId);
	const run = h.dialogue.get(runId)!;
	expect(run.status).toBe("failed");
	expect(run.worldUsed).toBe(true);
	expect(run.worldBlocked).toBe(true);
	expect(run.error).toMatch(/^world_/);
	expect(turn.status).toBe("failed");
	expect(turn.worldUsed).toBe(true);
	expect(turn.worldBlocked).toBe(true);
	expect(turn.error).toBe(run.error);
	// The model was never called, nothing was said or stored.
	expect(h.sends()).toBe(0);
	expect(h.spoken).toEqual([]);
	expect(h.answers()).toEqual([]);
	const stream = watchRun(h.app, runId);
	await stream.done;
	expect(stream.bodies()).toEqual([]);
	expect(stream.frames.at(-1)).toMatchObject({
		status: "failed",
		worldUsed: true,
		worldBlocked: true,
		error: run.error,
	});
});

test("general conversation is unchanged: live partial text, speech only after completion, worldUsed false", async () => {
	const h = await setup({ world: false });
	let watch: ReturnType<typeof watchRun> | undefined;
	let midBodies: string[] = [];
	let midSpoken = -1;
	h.hooks.duringGeneration = async (runId) => {
		watch = watchRun(h.app, runId);
		await pause(60);
		midBodies = watch.bodies().map((f) => f.text);
		midSpoken = h.spoken.length;
	};
	const { utteranceId, runId } = await h.speak();
	const turn = await h.terminal(utteranceId);
	await watch!.done;
	expect(midBodies).toEqual([ANSWER.slice(0, 4)]);
	expect(midSpoken).toBe(0);
	expect(h.dialogue.get(runId)).toMatchObject({
		status: "completed",
		worldUsed: false,
		worldBlocked: false,
	});
	expect(turn.worldUsed).toBe(false);
	expect(watch!.frames.at(-1)).toMatchObject({
		status: "completed",
		text: ANSWER,
		worldUsed: false,
	});
	expect(h.spoken.join("")).toBe(ANSWER);
	expect(h.answers()).toEqual([ANSWER]);
});
