import { createRequestOperations } from "./request-operations";
import { connectionAccess } from "./connection-access";
import { createProbes } from "./probes";
import { createRequestValidity } from "./request-validity";
import { createUsageReader } from "./usage";
import { createVoiceAccess } from "./voice-access";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LarmPort } from "../../larm";
import { createGenerationLanes } from "../../larm";
import {
	createConfiguredLarm,
	sharesLarmClient,
	stableLarmClient,
} from "./configured-larm";
import { createScreenPresence, screenOperations } from "./screen-presence";
import type { SettingsService, Settings } from "../../settings";
import type { AgentAttemptRevocation, InferencePort } from "../contracts";
import { get } from "../repository";
import { snapshotPort } from "./snapshot-port";
import type {
	CollectionAdoption,
	Env,
	InferenceOptions,
	Running,
} from "./execute-types";
import { createAgentSweeper } from "./agent-sweep";
import { releaseTaskSessions } from "./agent-session";
import { revokeAgentAttempts } from "./agent-revoke";
import { createJudges } from "./judges";
import { createSpeechLane } from "./speech-lane";

/** Subjects of requests that do not serve the user right now (World extraction, background controls, probes). */
const BACKGROUND_SUBJECT = /^(world-extract|background|probe):/;

function taskSessionRelease(store: SqliteStore, ports: Map<string, LarmPort>) {
	return async (taskId: string) => {
		await Promise.all([
			releaseTaskSessions(store, taskId),
			...[...ports.values()].map((p) => p.releaseTaskSession?.(taskId)),
		]);
	};
}

export function createInference(
	store: SqliteStore,
	settings: SettingsService,
	options: InferenceOptions = {},
) {
	const ports = new Map<string, LarmPort>();
	const larmLanes = createGenerationLanes();
	const collectionAdoptions = new Map<string, CollectionAdoption>();
	const unsubscribeCollection = options.attitudeDataset
		? store.onCommit(() => {
				for (const [id, entry] of collectionAdoptions) {
					const state = store.read((db) => get(db, id))?.status;
					if (state === "accepted") {
						collectionAdoptions.delete(id);
						options.attitudeDataset!.adopt(
							entry.identity,
							entry.delivery,
							entry.voice,
						);
					} else if (state && state !== "pending")
						collectionAdoptions.delete(id);
				}
			})
		: () => {};
	const listeners = new Set<() => void>();
	/** Told when a request starts or ends running (see foregroundBusy). */
	const activityListeners = new Set<() => void>();
	const statusSubscriptions = new Map<string, () => void>();
	const active = new Map<string, Running>();
	const cooldown = new Map<string, number>();
	const closingPorts = new Set<Promise<void>>();
	const judges = createJudges({ settings, options });
	const screen = createScreenPresence(
		() => port(settings.get()),
		(changed) => settings.onChange(changed),
		() => listeners.forEach((listener) => listener()),
	);
	function prune() {
		const keep = new Set([
			JSON.stringify(settings.get().larm),
			...[...active.values()].map((a) => JSON.stringify(a.row.snapshot.larm)),
		]);
		for (const [name, p] of ports)
			if (!keep.has(name)) {
				ports.delete(name);
				statusSubscriptions.get(name)?.();
				statusSubscriptions.delete(name);
				// Ports differing only in voice settings share one connection (one client): it stays for the others.
				const shared =
					options.keepLarmConnection &&
					sharesLarmClient(settings.derivedKey("larm.client"), name, [
						settings.get().larm,
						...[...ports.keys()].map((o) => JSON.parse(o) as Settings["larm"]),
					]);
				const done = p.close(shared ? { keepConnection: true } : undefined);
				closingPorts.add(done);
				void done.finally(() => closingPorts.delete(done)).catch(() => {});
			}
	}
	let closed = false;
	function port(s: Settings) {
		const key = JSON.stringify(s.larm);
		let p = ports.get(key);
		if (!p) {
			p =
				options.larmFactory?.(s) ??
				createConfiguredLarm(
					s,
					options,
					stableLarmClient(settings.derivedKey("larm.client"), s.larm),
					larmLanes,
				);
			ports.set(key, p);
			const unsubscribeStatus = p.onChange?.(() => {
				if (key !== JSON.stringify(settings.get().larm)) return;
				for (const listener of listeners) listener();
			});
			if (unsubscribeStatus) statusSubscriptions.set(key, unsubscribeStatus);
		}
		return p;
	}
	const { resolve, allowed, valid, usable } = createRequestValidity({
		settings,
		active,
	});
	const unsubscribe = settings.onChange(() => {
		prune();
		for (const a of active.values())
			if (!store.read((db) => allowed(db, a.row, a.connection)))
				a.controller.abort();
	});
	let commitGeneration = 0;
	/** Requests whose running agent call a forget revoked; aborted once that transaction has committed. */
	const revokedRequests = new Set<string>();
	const sweeper = createAgentSweeper(store);
	const stopCommits = store.onCommit(() => {
		commitGeneration++;
		for (const requestId of revokedRequests) {
			const revoked = store.read((db) =>
				db
					.query(
						"SELECT 1 FROM inference_attempts WHERE request_id=? AND status='revoked'",
					)
					.get(requestId),
			);
			if (revoked) active.get(requestId)?.controller.abort();
		}
		revokedRequests.clear();
	});
	const env: Env = {
		store,
		settings,
		options,
		active,
		cooldown,
		speechLane: createSpeechLane(),
		collectionAdoptions,
		port,
		resolve,
		allowed,
		prune,
		isClosed: () => closed,
		commitGeneration: () => commitGeneration,
		touch: () => {
			for (const listener of activityListeners) {
				try {
					listener();
				} catch {
					// a listener never disturbs a request
				}
			}
		},
	};
	const { capture, executeRequest, accept, standaloneReceipt, operations } =
		createRequestOperations(env, { valid, usable });
	const probes = createProbes({
		store,
		settings,
		port,
		capture,
		executeRequest,
		accept,
	});
	const service = {
		...operations,
		...snapshotPort(settings, port),
		revokeAgentAttemptsInTransaction(
			db: Database,
			input: AgentAttemptRevocation,
		) {
			for (const requestId of revokeAgentAttempts(db, input, () =>
				options.cloudAgents?.forget?.(),
			))
				revokedRequests.add(requestId);
		},
		releaseTaskSession: taskSessionRelease(store, ports),
		async recordExternalCodexAttempt(input: {
			subject: string;
			model: string | null;
			started: number;
			ended: number;
			status: "succeeded" | "failed";
			reason: string | null;
			usage: {
				input: number;
				cachedInput: number;
				output: number;
				reasoning: number;
			} | null;
		}) {
			await store.write((db) => {
				const requestId = capture(
					db,
					input.subject,
					"llm",
					input.ended,
					settings.inTransaction(db),
				);
				db.query("UPDATE inference_requests SET status=? WHERE id=?").run(
					input.status === "succeeded" ? "accepted" : "failed",
					requestId,
				);
				db.query(
					"INSERT INTO inference_attempts(id,request_id,source,model,status,reason,started,ended,accepted,input_tokens,output_tokens,cache_read_tokens,reasoning_tokens,usage_model,usage_observed,session_role,billing_path,connection_name,connection_kind) VALUES(?,?,'cloud',?,?,?,?,?,?,?,?,?,?,?,?,'auxiliary','codex','Codex SDK','codex-sdk')",
				).run(
					crypto.randomUUID(),
					requestId,
					input.model,
					input.status,
					input.reason,
					input.started,
					input.ended,
					input.status === "succeeded" ? 1 : 0,
					input.usage?.input ?? null,
					input.usage?.output ?? null,
					input.usage?.cachedInput ?? null,
					input.usage?.reasoning ?? null,
					input.usage ? input.model : null,
					input.usage ? 1 : 0,
				);
			});
		},
		...connectionAccess(settings, port, options.connectionModels),
		...screenOperations(screen),
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * True while a request that serves the user right now is running:
		 * conversation answers, ASR and TTS. Background work (World extraction,
		 * background controls) and probes never count. Read-only, in memory.
		 */
		foregroundBusy: () =>
			[...active.values()].some((a) => !BACKGROUND_SUBJECT.test(a.row.subject)),
		/** Told after a request started or ended running. Returns the unsubscribe function. */
		onActivity(listener: () => void) {
			activityListeners.add(listener);
			return () => {
				activityListeners.delete(listener);
			};
		},
		inspect: () =>
			port(settings.get()).inspect?.() ?? {
				profile: settings.get().larm.profile ?? "",
				providers: [],
			},
		larmProfiles: async (signal: AbortSignal) =>
			(await port(settings.get()).conversationProfiles?.(signal)) ?? [],
		...createVoiceAccess({ settings, port, standaloneReceipt }),
		...createUsageReader(store),
		...probes,
		async recover() {
			await store.write((db) => {
				db.query(
					"UPDATE inference_requests SET status='interrupted' WHERE status='pending' AND EXISTS(SELECT 1 FROM inference_attempts WHERE request_id=inference_requests.id)",
				).run();
				db.query(
					"UPDATE inference_attempts SET status='interrupted',ended=? WHERE status='running'",
				).run(Date.now());
				db.query(
					"UPDATE inference_probes SET status='interrupted' WHERE status IN ('running','cancelling')",
				).run();
			});
			// Task sessions nobody released and a crashed host's temporary directories, now and then hourly.
			await sweeper.start();
		},
		/** The router's reranker on its own port (spec router-package-integration 2026-11-04 §1 #4). */
		...judges.ports,
		/** After the HTTP server listens: the saved router's connection is made ahead of the first utterance. */
		startRouter: () => judges.start(),
		async close() {
			screen.close();
			unsubscribeCollection();
			collectionAdoptions.clear();
			closed = true;
			unsubscribe();
			stopCommits();
			sweeper.stop();
			for (const stop of statusSubscriptions.values()) stop();
			statusSubscriptions.clear();
			listeners.clear();
			const pending = [...active.values()];
			for (const a of pending) a.controller.abort();
			probes.abortAll();
			await Promise.all(pending.map((a) => a.done));
			await probes.settled();
			// A restarted host gets its connections back with their input cache (see `keepLarmConnection`).
			await Promise.all(
				[...ports.values()].map((p) =>
					p.close(
						options.keepLarmConnection ? { keepConnection: true } : undefined,
					),
				),
			);
			await Promise.allSettled(closingPorts);
			await judges.close();
			await options.cloudAgents?.close?.();
		},
	} satisfies InferencePort & Record<string, unknown>;
	return service;
}
export type InferenceService = ReturnType<typeof createInference>;
