import { withLanguageControl } from "../domains/voice-dialogue/test/control-fixture";
/**
 * P3-09 first product connection, accepted on the REAL assembly: a temp-file
 * store with the production migrations, the real Writer and queue, the real
 * conversation/Memory/Goal/dialogue/voice services, and the World assembly
 * from `./world` (the code `server.ts` runs).
 *
 * Fixture-grade, stated plainly:
 *   - the model is a fixture inference port (no real provider run);
 *   - TTS is a spy (no real audio);
 *   - claims are explicit structured claims (no automatic extraction, P4);
 *   - "forget a message" is composed in the test (conversation retraction +
 *     Memory host-source forget): the product has no entry point for it yet.
 *
 * This file lives in api/application because it wires dialogue, voice and
 * queue together with World; the world domain may not depend on them.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import {
	applyForget,
	getForgetReceipt,
	planForget,
} from "eumenes-memory/sqlite";
import { planAssertionTransition } from "eumenes-world-model";
import { createContinuityService } from "../domains/continuity";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createGoalsService } from "../domains/goals";
import type { InferencePort, Receipt } from "../domains/inference";
import { createMemoryService } from "../domains/memory";
import { createQueue } from "../domains/queue";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { sourceKeyOf } from "../domains/world";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
	type WorldAssembly,
	type WorldAssemblyOptions,
} from "./world";

const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const wav = (() => {
	const b = new Uint8Array(44);
	b.set(new TextEncoder().encode("RIFF"), 0);
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
})();
const QUESTION = "音声サービスはいつから使えますか？";
const UNKNOWN = "分かりません。";

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
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-p3-"));
	dirs.push(dir);
	return dir;
};

type BootOptions = {
	dir: string;
	mode: "on" | "protect";
	/** The model is down: it must never be called. The queue is not even started. */
	modelStopped?: boolean;
	/** Passed to the lifecycle (a Memory port that refuses, a clock...). */
	lifecycle?: WorldAssemblyOptions["lifecycle"];
	cursorSecret?: string;
	/** Start the queue and the World consumers (default true). */
	run?: boolean;
};

/** The production startup order of server.ts, on a store in `dir`. */
async function boot(options: BootOptions) {
	const dbPath = join(options.dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const continuity = createContinuityService(store);
	const memoryJournalPath = join(options.dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: memoryJournalPath,
	});
	const goals = createGoalsService(store);
	const world: WorldAssembly = createWorldAssembly({
		store,
		conversation,
		memory,
		mode: options.mode,
		journalPath: defaultWorldJournalPath(memoryJournalPath),
		cursorSecret:
			options.cursorSecret ?? resolveWorldCursorSecret({ dbPath, env: {} }),
		debounceMs: 20,
		pollMs: 60_000,
		...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
	});

	// --- fixture inference + TTS spy ------------------------------------
	const seen: { role: string; content: string }[][] = [];
	const spoken: string[] = [];
	let sends = 0;
	const larm: InferencePort = withLanguageControl({
		status: () =>
			options.modelStopped
				? { state: "failed", capabilities: [], error: "model_stopped" }
				: { state: "ready", capabilities: ["llm", "asr", "tts"] },
		connect: async () => {},
		answer: async () => {
			throw new Error("fixture answers through executeStream");
		},
		transcribe: async () => QUESTION,
		speak: async (text: string) => {
			spoken.push(text);
			return wav;
		},
		close: async () => {},
		requestFor: (_db, subject, purpose) =>
			purpose === "llm" ? `req-${subject}` : null,
		validRequest: () => true,
		executeStream: async (requestId, messages, _signal, onDelta) => {
			if (options.modelStopped) throw new Error("model_stopped");
			sends += 1;
			seen.push(messages.map((m) => ({ ...m })));
			const answer = UNKNOWN;
			onDelta(answer);
			const receipt: Receipt = {
				requestId,
				attemptId: `att-${sends}`,
				value: answer,
			};
			return receipt;
		},
		executeRequest: async () => {
			throw new Error("fixture streams");
		},
		acceptInTransaction: () => true,
	});

	// Startup order: memory.recover -> world.recover -> queue.recover/start -> world.start.
	const memoryRecovery = await memory.recover();
	const worldRecovery = await world.recover({
		feedResyncRequired: memoryRecovery.feedResyncRequired === true,
	});
	const queue = createQueue(store);
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
		worldContext: world.context,
	});
	const voice = createVoiceDialogue(store, dialogue, larm);
	await dialogue.recover();
	await voice.recover();
	await queue.recover();
	const sessionId = crypto.randomUUID();
	if (options.run !== false && !options.modelStopped) {
		queue.start();
		voice.start(sessionId, 1);
	}
	if (options.run !== false) world.start();

	let sequence = 1;
	const h = {
		...options,
		dbPath,
		store,
		conversation,
		memory,
		goals,
		world,
		queue,
		dialogue,
		voice,
		seen,
		spoken,
		memoryRecovery,
		worldRecovery,
		sends: () => sends,
		async close() {
			await world.close();
			await voice.close().catch(() => {});
			await queue.close(100).catch(() => {});
			await dialogue.close().catch(() => {});
			await store.close().catch(() => {});
		},

		// --- explicit registration (what a person/host states) -------------
		async say(id: string, text: string) {
			await conversation.append({
				id,
				conversationId: "facts",
				role: "user",
				text,
				createdAt: new Date().toISOString(),
				runId: null,
			});
		},
		sourceRef(id: string) {
			const state = store.read((db) =>
				conversation.sourceInTransaction(db, id),
			);
			if (state.state !== "available") throw new Error("no source");
			return {
				namespace: "conversation",
				kind: "message",
				id,
				representation: "text",
				revision: state.revision,
				digest: state.digest,
			};
		},
		apply: (key: string, operation: unknown) =>
			world.service.apply({
				access: manualAccess(SCOPE),
				scope: SCOPE,
				operationKey: key,
				clock: Date.now(),
				operation: operation as never,
			}),
		async mustApply(key: string, operation: unknown) {
			const result = await h.apply(key, operation);
			if (result.status !== "applied") throw new Error(JSON.stringify(result));
			return result;
		},
		async registerTarget() {
			await h.mustApply("e-1", {
				kind: "entity.register",
				entity: {
					id: "svc-1",
					displayName: "音声サービス",
					aliases: ["音声"],
					externalRefs: [],
				},
			});
		},
		async registerClaim(id: string, source: string, value: string) {
			const ref = h.sourceRef(source);
			await h.mustApply(`c-${id}`, {
				kind: "assertion.register",
				assertion: claimOf(id, ref, value),
			});
			await h.mustApply(`ad-${id}`, {
				kind: "assertion.transition",
				plan: adoptPlanOf(id),
			});
		},

		// --- questions -------------------------------------------------------
		async ask() {
			return dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: QUESTION,
			});
		},
		async speak() {
			const utteranceId = crypto.randomUUID();
			await voice.accept(sessionId, 1, sequence++, utteranceId, wav);
			await until(() => !!voice.get(utteranceId)?.runId);
			return { utteranceId, runId: voice.get(utteranceId)!.runId! };
		},
		async finish(runId: string) {
			await until(() =>
				["completed", "failed", "cancelled", "interrupted"].includes(
					dialogue.get(runId)?.status ?? "",
				),
			);
			// Let any (wrongly) late speech or event show up before the caller counts it.
			await pause(150);
			return dialogue.get(runId)!;
		},
		answers: () =>
			conversation
				.get("main")
				.messages.filter((m) => m.role === "assistant")
				.map((m) => m.text),

		// --- forgetting ------------------------------------------------------
		/**
		 * "Forget this message" as a host would do it: retract it in the
		 * conversation and forget its Memory host source, in one writer
		 * transaction. Returns Memory's forgetId.
		 */
		forgetMessage(id: string): Promise<string> {
			return store.write((db) => {
				conversation.retractInTransaction(db, { messageId: id });
				const access = {
					principal: SCOPE.principal,
					scopeKeys: [SCOPE.scopeKey],
					purpose: "world.test",
					policyRevision: memory.policyRevisionInTransaction(db),
				};
				const planned = planForget(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access,
					target: {
						type: "host_source",
						sourceKey: sourceKeyOf({
							namespace: "conversation",
							kind: "message",
							id,
							representation: "text",
						}),
						scopeKey: SCOPE.scopeKey,
					},
					clock: { atMs: Date.now() },
				});
				if (planned.status !== "planned") throw new Error("plan failed");
				applyForget(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					entry: planned.plan.entry,
					clock: { atMs: Date.now() },
				});
				return planned.plan.entry.forgetId;
			});
		},
		/** The eumenes-world external deletions of one Memory forget, as Memory shows them. */
		externals(forgetId: string) {
			const found = store.read((db) =>
				getForgetReceipt(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access: {
						principal: SCOPE.principal,
						scopeKeys: [SCOPE.scopeKey],
						purpose: "world.test",
						policyRevision: memory.policyRevisionInTransaction(db),
					},
					forgetId,
				}),
			);
			if (found.status !== "found") return [];
			return found.receipt.externalDeletions
				.filter((item) => item.providerRef === "eumenes-world")
				.map((item) => item.state);
		},
		intakes: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT forget_id, state, origin FROM world_host_forget_intake ORDER BY rowid",
						)
						.all() as { forget_id: string; state: string; origin: string }[],
			),
		count: (table: string) =>
			(
				store.read((db) =>
					db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
				) as { n: number }
			).n,
		lifecycleOf: (id: string) =>
			(
				store.read((db) =>
					db
						.query(
							"SELECT lifecycle FROM world_assertion WHERE id = ? ORDER BY revision DESC LIMIT 1",
						)
						.get(id),
				) as { lifecycle: string } | null
			)?.lifecycle ?? null,
	};
	closers.push(() => h.close());
	return h;
}
type Booted = Awaited<ReturnType<typeof boot>>;

function claimOf(id: string, source: unknown, value: string) {
	return {
		id,
		revision: 1,
		scope: SCOPE,
		subjectId: "svc-1",
		predicate: "available_from",
		payload: { kind: "value", value: { kind: "string", value } },
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

const WORLD_TABLES = [
	"world_entity",
	"world_assertion",
	"world_assertion_head",
	"world_transition",
	"world_evidence",
	"world_assertion_input",
	"world_current",
	"world_edge",
	"world_scope_epoch",
	"world_operation",
	"world_tombstone",
	"world_host_usage",
	"world_host_dependent",
];
/** Every World table as text: nothing of a forgotten message may be in it. */
function worldText(h: Booted): string {
	return h.store.read((db) =>
		WORLD_TABLES.map((table) =>
			JSON.stringify(db.query(`SELECT * FROM ${table}`).all()),
		).join("\n"),
	);
}

// ---------------------------------------------------------------------------

test("the conversation gets only the names of the known targets the wording names: no claim text, no ids; nothing otherwise", async () => {
	const dir = tempDir();
	const h = await boot({ dir, mode: "on" });
	await h.say("m1", "音声サービスは9月から利用できる。");
	await h.registerTarget();
	await h.registerClaim("claim-1", "m1", "9月から");
	const run = await h.ask();
	expect((await h.finish(run.id)).status).toBe("completed");
	const input = h.seen.at(-1)!;
	expect(
		input.filter((m) => m.content.startsWith("Worldに記録がある対象")),
	).toEqual([
		{
			role: "system",
			content:
				"Worldに記録がある対象: 「音声サービス」（引用した名前のみ。詳しい内容は World の調査で確かめられる）",
		},
	]);
	const text = JSON.stringify(input);
	expect(text).not.toContain("9月から");
	expect(text).not.toContain("svc-1");
	expect(text).not.toContain("claim-1");

	// A turn that names no known target gets no hint.
	const other = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "other",
		text: "今日の天気は？",
	});
	expect((await h.finish(other.id)).status).toBe("completed");
	expect(JSON.stringify(h.seen.at(-1)).includes("Worldに記録がある対象")).toBe(
		false,
	);
});

test("A34 (host side) the host consumes only the vendored World tgz: package.json points at it", () => {
	const pkg = JSON.parse(
		readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
	) as { dependencies: Record<string, string> };
	expect(pkg.dependencies["eumenes-world-model"]).toMatch(
		/^file:vendor\/world\/eumenes-world-model-.+\.tgz$/,
	);
});

test("A34-A41 World OFF (protect) + Memory OFF + model stopped: a forget is still processed and completes", async () => {
	const dir = tempDir();
	// Content exists from an earlier ON session.
	let h = await boot({ dir, mode: "on" });
	await h.say("m1", "音声サービスは9月から利用できる。");
	await h.registerTarget();
	await h.registerClaim("claim-1", "m1", "9月から");
	expect(h.count("world_assertion")).toBeGreaterThan(0);
	await h.close();
	closers.length = 0;

	// World OFF (protect forces it), Memory OFF, a broken Memory journal (host Memory unhealthy),
	// and the model stopped: no queue, no inference, no consumer other than World's own.
	writeFileSync(join(dir, "memory-forget-journal.jsonl"), "not a journal\n");
	h = await boot({ dir, mode: "protect", modelStopped: true });
	await h.memory.setEnabled(false);
	expect(h.memoryRecovery.healthy).toBe(false);
	expect(h.world.status().world.enabled).toBe(false);
	expect(h.world.status().world.usable).toBe(false);
	expect(h.count("world_assertion")).toBeGreaterThan(0);

	const forgetId = await h.forgetMessage("m1");
	expect(h.externals(forgetId).every((s) => s === "pending")).toBe(true);
	await until(() => h.count("world_assertion") === 0);
	await until(() => h.externals(forgetId).every((s) => s === "confirmed"));
	await until(() => h.intakes().every((i) => i.state === "complete"));
	// Nothing needed the model, the queue or World ON.
	expect(h.sends()).toBe(0);
	expect(h.world.status().world.enabled).toBe(false);
	expect(worldText(h)).not.toContain("9月");
});

test("A38 Memory unavailable: World content is deleted at once, the forget stays pending (never complete) and finishes when Memory is back", async () => {
	const dir = tempDir();
	let h = await boot({ dir, mode: "on" });
	await h.say("m1", "音声サービスは9月から利用できる。");
	await h.registerTarget();
	await h.registerClaim("claim-1", "m1", "9月から");
	await h.close();
	closers.length = 0;

	h = await boot({
		dir,
		mode: "on",
		lifecycle: { memory: { record: () => "not_permitted" } },
	});
	const forgetId = await h.forgetMessage("m1");
	await until(() => h.count("world_assertion") === 0);
	await pause(300);
	// World side done, Memory side not confirmed: the intake is NOT complete.
	expect(h.intakes().some((i) => i.state !== "complete")).toBe(true);
	expect(h.externals(forgetId).every((s) => s === "pending")).toBe(true);
	// ... and the Scope stays closed to World reads while confirmations are owed.
	const blocked = await h.world.service.read({
		access: manualAccess(SCOPE),
		scope: SCOPE,
		asOf: Date.now(),
	});
	expect(blocked.status).toBe("blocked");

	// Memory is back (the real port): the same forget completes.
	await h.close();
	closers.length = 0;
	h = await boot({ dir, mode: "on" });
	await until(() => h.intakes().every((i) => i.state === "complete"));
	await until(() => h.externals(forgetId).every((s) => s === "confirmed"));
});
