import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAssertionTransition } from "eumenes-world-model";
import { createContinuityService } from "../domains/continuity";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createInference } from "../domains/inference";
import type { LarmPort } from "../domains/larm";
import { createMemoryService } from "../domains/memory";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createSettings } from "../domains/settings";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { openStore } from "../infrastructure/sqlite";
import { createApp } from "./app";
import { createChanges } from "./events";
import { migrations } from "./migrations";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
} from "./world";

export const WORLD_FIXTURE_TOKEN = "fixture-token-for-world-browser";
const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const NOW = Date.parse("2026-10-09T00:00:00Z");

export type WorldFixtureOptions = {
	/** Reuse (and keep) this directory: a second harness on it is a RESTART. */
	dir?: string;
	/** The first forget stops while it advances (a crash), leaving it pending. */
	stallForget?: boolean;
	/** Safety-net poll of the World assembly that resumes unfinished forgets. */
	pollMs?: number;
};

/**
 * A hermetic backend for the World screen: temp-file store, production
 * migrations, the REAL World assembly (mode on), the real HTTP app. Fixture
 * only: a stub LARM port (no model), no network, claims written explicitly.
 */
export async function worldHarness(options: WorldFixtureOptions = {}) {
	const owned = options.dir === undefined;
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "eumenes-world-ui-"));
	const dbPath = join(dir, "db.sqlite3");
	const fresh = !existsSync(dbPath);
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath });
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async () => "かしこまりました。",
	};
	const inference = createInference(store, settings, {
		larmFactory: () => model,
	});
	const queue = createQueue(store, {
		resources: { "inference.llm": 1, "web.fetch": 2 },
		pollMs: 5,
	});
	const memoryJournalPath = join(dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(store),
		{ journalPath: memoryJournalPath },
	);
	let stalled = options.stallForget === true;
	const world = createWorldAssembly({
		store,
		conversation,
		memory,
		mode: "on",
		journalPath: defaultWorldJournalPath(memoryJournalPath),
		cursorSecret: resolveWorldCursorSecret({ dbPath, env: {} }),
		pollMs: options.pollMs ?? 60_000,
		lifecycle: {
			hook: (point) => {
				if (stalled && point === "world_applied") {
					stalled = false;
					throw new Error("fixture_forget_stalled");
				}
			},
		},
	});
	const recovery = await memory.recover();
	await world.recover({
		feedResyncRequired: recovery.feedResyncRequired === true,
	});

	const apply = (key: string, operation: unknown) =>
		world.service.apply({
			access: manualAccess(),
			scope: SCOPE,
			operationKey: key,
			clock: NOW,
			operation: operation as never,
		});
	const ref = (id: string) => {
		const state = store.read((db) => conversation.sourceInTransaction(db, id));
		if (state.state !== "available") throw new Error(`no source ${id}`);
		return {
			namespace: "conversation",
			kind: "message",
			id,
			representation: "text",
			revision: state.revision,
			digest: state.digest,
		};
	};
	const claim = (
		id: string,
		source: ReturnType<typeof ref>,
		extra: Record<string, unknown>,
	) => ({
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
		recordedAt: NOW,
		freshnessPolicy: { maxAgeMs: 86_400_000 },
		condition: { kind: "unspecified" },
		supersedes: [],
		contradicts: [],
		interpretationVersion: "interp-1",
		lifecycle: "candidate",
		rootEvidenceIds: [`root-${id}`],
		...extra,
	});
	const adopt = (id: string) => {
		const planned = planAssertionTransition({
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
				adoption: { kind: "explicit", operationId: `op-${id}` },
				subjectConfirmedByHost: true,
			},
			registeredAdoptionRules: [],
		} as never);
		if (!planned.ok || planned.value.status !== "planned")
			throw new Error("adopt_plan_failed");
		return planned.value.plan;
	};
	if (fresh) {
		await world.service.markInitialSyncComplete();
		await world.service.setEnabled(true);
		for (const [id, text] of [
			["m1", "音声サービスは9月から利用できる。"],
			["m2", "いいえ、音声サービスは10月からです。"],
		] as const)
			await conversation.append({
				id,
				conversationId: "main",
				role: "user",
				text,
				createdAt: "2026-10-09T00:00:00.000Z",
				runId: null,
			});
		await apply("e", {
			kind: "entity.register",
			entity: {
				id: "svc-1",
				displayName: "音声サービス",
				aliases: [],
				externalRefs: [],
			},
		});
		const m1 = ref("m1");
		const measured = claim("claim-measured", m1, {
			origin: "runtime_observation",
			predicate: "latency",
			payload: {
				kind: "value",
				value: { kind: "number", value: 120, unit: "ms" },
			},
		});
		measured.evidence = measured.evidence.map((e) => ({
			...e,
			kind: "runtime_measurement",
		}));
		const seeds: [string, unknown, boolean][] = [
			["claim-report", claim("claim-report", m1, {}), true],
			[
				"claim-hyp",
				claim("claim-hyp", m1, {
					origin: "model_hypothesis",
					predicate: "launch_month",
					payload: { kind: "value", value: { kind: "string", value: "9月" } },
				}),
				true,
			],
			["claim-measured", measured, true],
			[
				"claim-cand",
				claim("claim-cand", m1, {
					predicate: "price",
					payload: { kind: "value", value: { kind: "string", value: "無料" } },
				}),
				false,
			],
		];
		for (const [id, assertion, adopted] of seeds) {
			await apply(`r-${id}`, { kind: "assertion.register", assertion });
			if (adopted)
				await apply(`a-${id}`, {
					kind: "assertion.transition",
					plan: adopt(id),
				});
		}
	}

	const changes = createChanges();
	const unsubscribe = store.onCommit(() => changes.publish());
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
		memory,
		worldContext: world.context,
	});
	const app = createApp({
		token: WORLD_FIXTURE_TOKEN,
		origin: process.env.EUMENES_ORIGIN ?? "http://localhost",
		changes,
		settings,
		conversation,
		dialogue,
		voice: createVoiceDialogue(store, dialogue, inference),
		larm: inference,
		queue,
		scheduler: createScheduler(store, queue),
		inference,
		memory,
		worldClaims: { claims: world.claims, context: world.claimsContext },
	});
	queue.start();
	world.start();
	return {
		app,
		world,
		store,
		dir,
		async close() {
			unsubscribe();
			changes.close();
			await world.close();
			await store.close().catch(() => {});
			if (owned) rmSync(dir, { recursive: true, force: true });
		},
	};
}
