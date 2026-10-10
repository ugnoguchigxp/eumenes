import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ScopeRef } from "eumenes-world-model";
import { parseWorldMode, type WorldMode } from "../infrastructure/config";
import { getLogger } from "../infrastructure/logger";
import type { SqliteStore } from "../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	type ConversationService,
} from "../domains/conversation";
import type { WorldContextPort } from "../domains/dialogue";
import type { MemoryService } from "../domains/memory";
import {
	SourceCursorError,
	createConversationSourceAdapter,
	conversationReasonSource,
	createWorldClaims,
	createWorldContextBroker,
	createWorldExtraction,
	createWorldHostGate,
	createWorldLifecycle,
	createWorldService,
	type ConsumeReport,
	type ContextBroker,
	type ExtractionHandler,
	type ExtractionInference,
	type ExtractionQueue,
	type ForegroundSignal,
	type LifecycleOptions,
	type PreparedWorldContext,
	type RecoverReport,
	type WorldClaims,
	type WorldClaimsContext,
	type WorldExtraction,
	type WorldHostGate,
	type WorldLifecycle,
	type WorldService,
	type WorldStatus,
	WORLD_EXTRACT_PURPOSE,
} from "../domains/world";

/**
 * Host assembly of World (P3-09). The product has three states, chosen by the
 * environment variable `EUMENES_WORLD`:
 *
 *   off (default / unset)  Nothing is assembled. The application behaves
 *                          exactly as it did before World existed.
 *   protect                Lifecycle only: startup recovery, forget intake,
 *                          change-feed consumers, release sweeps. World is
 *                          forced OFF at startup, so it never reads or writes
 *                          content on its own.
 *   on                     protect, plus: the first full feed pass
 *                          (`initialSync`) and then World is turned ON.
 *
 * Any other value fails startup (`world_mode_invalid`): a typo must never be
 * read as "no forgetting".
 */
export const WORLD_ENV = "EUMENES_WORLD";
export type { WorldMode };

export function worldModeFromEnv(
	env: Record<string, string | undefined>,
): WorldMode {
	return parseWorldMode(env[WORLD_ENV]);
}

/** AccessContext purposes the conversation SourceAdapter allows (deny by default). */
export const WORLD_BROKER_PURPOSE = "dialogue.read";
export const WORLD_LIFECYCLE_PURPOSE = "world.lifecycle";
/** Explicit registration of targets and structured claims (no extraction yet). */
export const WORLD_MANUAL_PURPOSE = "world.manual";

export const WORLD_DEFAULT_SCOPE: ScopeRef = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};

/** The AccessContext request part for an explicit registration in `scope`. */
export const manualAccess = (scope: ScopeRef = WORLD_DEFAULT_SCOPE) => ({
	principal: scope.principal,
	scopeKeys: [scope.scopeKey],
	purpose: WORLD_MANUAL_PURPOSE,
});

const MIN_SECRET_CHARS = 32;
/**
 * The stable host-owned secret that masks and authenticates the conversation
 * change cursor. It is NOT derived from any product database content:
 *   1. `EUMENES_WORLD_CURSOR_SECRET` (at least 32 characters), if set;
 *   2. else the file `world-cursor.key` in `EUMENES_KEY_DIR` (`keyDir`), or
 *      `<db dir>/keys` when that is unset (hex text of 32 random bytes,
 *      directory 0700, file 0600), created once with the exclusive-create
 *      flag. A short or damaged file fails startup instead of being replaced:
 *      a new secret invalidates every stored cursor. When `keyDir` is set and
 *      holds no key yet, an existing `<db dir>/keys/world-cursor.key` is copied
 *      there (the old file is kept) so stored cursors stay valid.
 * Nothing here is ever logged.
 */
export function resolveWorldCursorSecret(options: {
	dbPath: string;
	/** `EUMENES_KEY_DIR`; blank falls back to `<db dir>/keys`. */
	keyDir?: string;
	env?: Record<string, string | undefined>;
}): string {
	const fromEnv = options.env?.["EUMENES_WORLD_CURSOR_SECRET"];
	if (fromEnv !== undefined && fromEnv !== "") {
		if (fromEnv.length < MIN_SECRET_CHARS)
			throw new Error("world_cursor_secret_invalid");
		return fromEnv;
	}
	const legacy = join(dirname(options.dbPath), "keys", "world-cursor.key");
	const path = options.keyDir?.trim()
		? join(options.keyDir.trim(), "world-cursor.key")
		: legacy;
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		chmodSync(dirname(path), 0o700);
		try {
			// Moving the key directory must not void stored cursors: copy the old key.
			if (path !== legacy && existsSync(legacy)) {
				copyFileSync(legacy, path, constants.COPYFILE_EXCL);
				chmodSync(path, 0o600);
			} else
				writeFileSync(path, randomBytes(32).toString("hex"), {
					mode: 0o600,
					flag: "wx",
				});
		} catch (error) {
			// A concurrent creator won the race: read what it wrote.
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
	if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
	const secret = readFileSync(path, "utf8").trim();
	if (secret.length < MIN_SECRET_CHARS)
		throw new Error("world_cursor_secret_invalid");
	return secret;
}

/** The World journal lives next to the Memory forget journal. */
export const defaultWorldJournalPath = (memoryJournalPath: string): string =>
	join(dirname(memoryJournalPath), "world-forget-journal.jsonl");

/** Pages one feed may be drained for in a single initial sync (bounded). */
const SYNC_MAX_PAGES = 2000;
/** Pages one pump drains per feed before it yields. */
const PUMP_MAX_PAGES = 20;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_DEBOUNCE_MS = 250;

export type WorldAssemblyOptions = {
	store: SqliteStore;
	conversation: ConversationService;
	/** Only its policy revision is used: World must see the value Memory sees. */
	memory: Pick<MemoryService, "policyRevisionInTransaction">;
	mode: Exclude<WorldMode, "off">;
	/** Absolute path of the World journal (see defaultWorldJournalPath). */
	journalPath: string;
	/** See resolveWorldCursorSecret. */
	cursorSecret: string;
	scope?: ScopeRef;
	/** Safety-net poll (also retries recovery, stuck forgets and release sweeps). */
	pollMs?: number;
	/** Delay between a commit notification and the feed pass it triggers. */
	debounceMs?: number;
	/**
	 * Local extraction (P4-02). Only with mode `on`: the queue handler is
	 * registered and a job is scheduled after a feed pass that left unsettled
	 * input. Without it (or in `protect`) no extraction job ever exists.
	 */
	extraction?: {
		queue: ExtractionQueue & {
			registerHandler(definition: ExtractionHandler): void;
		};
		inference: ExtractionInference;
		/** Entities World knows (the package offers no listing; default none). */
		entities?: (db: Database, scope: ScopeRef) => readonly unknown[];
		/** Test seams: the model-call budget (30 s) and the cancel confirmation (5 s). */
		stageBudgetMs?: number;
		confirmMs?: number;
		/**
		 * Foreground priority (P4-03): conversation, ASR and TTS. While it is
		 * active no extraction is scheduled, a claimed job is held un-run and a
		 * running model call is cancelled. When it ends (or a cancelled call
		 * finally ends) the held input is picked up again by a feed pass.
		 */
		foreground?: ForegroundSignal;
	};
	/** Test seams for the lifecycle (Memory port, clock, crash hooks). */
	lifecycle?: Partial<
		Pick<LifecycleOptions, "memory" | "clock" | "hook" | "dependentPageSize">
	>;
};

export type InitialSyncReport =
	| { complete: true }
	| { complete: false; reason: string };

export type PumpReport =
	| { status: "skipped"; reason: string }
	| {
			status: "ran";
			sourceChanges: number;
			memoryChanges: number;
			/** Forgets that were not complete after this pass (full passes only). */
			pendingForgets: number;
	  };

export type WorldAssembly = {
	readonly mode: Exclude<WorldMode, "off">;
	readonly service: WorldService;
	readonly lifecycle: WorldLifecycle;
	readonly gate: WorldHostGate;
	readonly broker: ContextBroker;
	/** Present only in mode `on` with an `extraction` option. */
	readonly extraction: WorldExtraction | undefined;
	/** The port dialogue consumes. World OFF makes it answer `disabled`. */
	readonly context: WorldContextPort;
	/** The owner's claim list and explicit corrections (P5-02). */
	readonly claims: WorldClaims;
	/** Who the HTTP surface acts for: bound by the host, never by a request. */
	readonly claimsContext: () => WorldClaimsContext;
	/**
	 * Startup step, AFTER `memory.recover()` and BEFORE the queue starts. Never
	 * throws: a failed recovery leaves the gate closed (World fails closed) and
	 * is reported; forgets keep being retried by the pump.
	 */
	recover(memory?: { feedResyncRequired?: boolean }): Promise<RecoverReport>;
	/** First full pass over both change feeds; marks the host flag when drained. */
	initialSync(): Promise<InitialSyncReport>;
	/** Explicit switch. ON runs `initialSync` first and is refused if it cannot finish. */
	setEnabled(enabled: boolean): Promise<void>;
	status(): {
		mode: Exclude<WorldMode, "off">;
		gate: { open: boolean; reason: string | null };
		world: WorldStatus;
		initialSyncComplete: boolean;
	};
	/** One feed/forget pass (single flight). `full` also resumes stuck forgets and sweeps releases. */
	pump(options?: { full?: boolean }): Promise<PumpReport>;
	/** Starts the commit-notification and poll triggers. Never creates inference jobs. */
	start(): void;
	/** Stops the triggers and waits for the pass in flight. Call before `store.close()`. */
	close(): Promise<void>;
};

/** Adapts the Broker (typed context) to the opaque port dialogue consumes. */
export function worldContextPort(broker: ContextBroker): WorldContextPort {
	return {
		prepareInTransaction: (db, input) => broker.prepareInTransaction(db, input),
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
}

export function createWorldAssembly(
	options: WorldAssemblyOptions,
): WorldAssembly {
	const { store } = options;
	const log = getLogger("world");
	const scope = options.scope ?? WORLD_DEFAULT_SCOPE;
	const gate = createWorldHostGate("closed");
	const adapter = createConversationSourceAdapter(options.conversation, {
		allowedPurposes: [
			WORLD_BROKER_PURPOSE,
			WORLD_LIFECYCLE_PURPOSE,
			WORLD_MANUAL_PURPOSE,
			WORLD_EXTRACT_PURPOSE,
		],
		cursorSecret: options.cursorSecret,
	});
	const service = createWorldService({
		store,
		sources: [adapter],
		// The same value the memory service's access() carries.
		policyRevision: (db) => options.memory.policyRevisionInTransaction(db),
		gate,
	});
	const lifecycle = createWorldLifecycle({
		store,
		world: service,
		journalPath: options.journalPath,
		gate,
		purpose: WORLD_LIFECYCLE_PURPOSE,
		sources: [adapter],
		scopes: [scope],
		...options.lifecycle,
	});
	const claims = createWorldClaims({
		store,
		world: service,
		lifecycle,
		state: () => ({ mode: options.mode, gateOpen: gate.isOpen() }),
		reasonSource: conversationReasonSource(options.conversation, scope),
		readPurpose: WORLD_BROKER_PURPOSE,
		writePurpose: WORLD_MANUAL_PURPOSE,
		onForgetAdvanceFailed: (error) =>
			log.warn("world.forget_advance_failed", { reason: "advance" }, error),
	});
	const broker = createWorldContextBroker({
		store,
		world: service,
		purpose: WORLD_BROKER_PURPOSE,
		scopeOf: () => scope,
	});

	// The handler exists only while World is configured ON; it is inert (and
	// creates nothing) whenever World is switched OFF or its gate is closed.
	const extraction =
		options.mode === "on" && options.extraction
			? createWorldExtraction({
					store,
					world: service,
					sources: [adapter],
					queue: options.extraction.queue,
					inference: options.extraction.inference,
					gate,
					purpose: WORLD_EXTRACT_PURPOSE,
					...(options.extraction.foreground
						? { foreground: options.extraction.foreground }
						: {}),
					...(options.extraction.entities
						? { entities: options.extraction.entities }
						: {}),
					...(options.extraction.stageBudgetMs === undefined
						? {}
						: { stageBudgetMs: options.extraction.stageBudgetMs }),
					...(options.extraction.confirmMs === undefined
						? {}
						: { confirmMs: options.extraction.confirmMs }),
				})
			: undefined;
	if (extraction) options.extraction?.queue.registerHandler(extraction.handler);

	let closed = false;
	let unsubscribe: (() => void) | undefined;
	const unsubscribeResume: Array<() => void> = [];
	let resume: ReturnType<typeof setTimeout> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	/** Drains one feed page by page (bounded). Null when drained, else why not. */
	async function drain(
		consume: () => Promise<ConsumeReport>,
		maxPages: number,
		seen: { changes: number },
	): Promise<string | null> {
		for (let page = 0; page < maxPages; page++) {
			if (closed) return "CLOSED";
			const report = await consume();
			seen.changes += report.changes;
			if (report.blocked !== null) return report.blocked;
			if (!report.hasMore) return null;
		}
		return "PAGE_LIMIT";
	}

	/** A cursor the secret no longer authenticates is an unusable cursor: re-sync everything. */
	async function consumeSource(): Promise<ConsumeReport> {
		try {
			return await lifecycle.consumeSourceChanges(scope);
		} catch (error) {
			if (!(error instanceof SourceCursorError)) throw error;
			log.warn("world.cursor_reset", { reason: "source_cursor_invalid" });
			await lifecycle.startRestore();
			return lifecycle.consumeSourceChanges(scope);
		}
	}

	async function initialSync(): Promise<InitialSyncReport> {
		if (service.initialSyncComplete()) return { complete: true };
		if (!gate.isOpen())
			return { complete: false, reason: gate.reason() ?? "RECOVERY_REQUIRED" };
		const seen = { changes: 0 };
		for (const consume of [
			consumeSource,
			() => lifecycle.consumeMemoryChanges(scope),
		]) {
			const why = await drain(consume, SYNC_MAX_PAGES, seen);
			if (why !== null) return { complete: false, reason: why };
		}
		await service.markInitialSyncComplete();
		return { complete: true };
	}

	/** Applies the mode to the persistent ON/OFF flag once the gate is open. */
	async function applyMode(): Promise<void> {
		if (!gate.isOpen()) return;
		const enabled = service.status().enabled;
		if (options.mode === "protect") {
			if (enabled) await service.setEnabled(false);
			return;
		}
		if (enabled) return;
		const synced = await initialSync();
		if (synced.complete) await service.setEnabled(true);
		else log.warn("world.initial_sync_incomplete", { reason: synced.reason });
	}

	async function recover(memory?: {
		feedResyncRequired?: boolean;
	}): Promise<RecoverReport> {
		let report: RecoverReport;
		try {
			report = await lifecycle.recoverWorld({
				memoryFeedResyncRequired: memory?.feedResyncRequired === true,
			});
		} catch (error) {
			log.error("world.recovery_failed", { reason: "recovery_failed" }, error);
			return { status: "closed", reason: "RECOVERY_FAILED" };
		}
		if (report.status === "closed") {
			log.warn("world.unavailable", { reason: report.reason });
			return report;
		}
		try {
			await applyMode();
		} catch (error) {
			log.error("world.mode_failed", { reason: "mode_failed" }, error);
		}
		return report;
	}

	let running: Promise<PumpReport> | null = null;
	let again: { full: boolean } | null = null;

	async function pass(full: boolean): Promise<PumpReport> {
		if (!gate.isOpen()) {
			// Only the poll retries a failed or interrupted recovery.
			if (full) {
				const report = await recover();
				if (report.status === "closed")
					return { status: "skipped", reason: report.reason };
			} else return { status: "skipped", reason: gate.reason() ?? "closed" };
		}
		const source = { changes: 0 };
		const memory = { changes: 0 };
		const sourceWhy = await drain(consumeSource, PUMP_MAX_PAGES, source);
		const memoryWhy = await drain(
			() => lifecycle.consumeMemoryChanges(scope),
			PUMP_MAX_PAGES,
			memory,
		);
		for (const why of [sourceWhy, memoryWhy])
			if (why !== null && why !== "CLOSED" && why !== "PAGE_LIMIT")
				log.warn("world.feed_blocked", { reason: why.toLowerCase() });
		// Unsettled input becomes ONE background job; no input, no job, no model call.
		if (extraction && !closed)
			try {
				await extraction.schedule(scope);
			} catch (error) {
				log.warn(
					"world.extraction_schedule_failed",
					{ reason: "schedule" },
					error,
				);
			}
		let pendingForgets = 0;
		if (full && !closed) {
			const reports = await lifecycle.resumeForgets();
			pendingForgets = reports.filter((r) => !r.complete).length;
			await lifecycle.sweepPendingReleases();
		}
		return {
			status: "ran",
			sourceChanges: source.changes,
			memoryChanges: memory.changes,
			pendingForgets,
		};
	}

	function pump(settings: { full?: boolean } = {}): Promise<PumpReport> {
		const full = settings.full === true;
		if (closed) return Promise.resolve({ status: "skipped", reason: "closed" });
		if (running) {
			// One more pass after the current one, as thorough as the strictest request.
			again = { full: full || again?.full === true };
			return running;
		}
		running = (async () => {
			let report: PumpReport = { status: "skipped", reason: "idle" };
			let next: { full: boolean } | null = { full };
			while (next && !closed) {
				again = null;
				try {
					report = await pass(next.full);
				} catch (error) {
					log.warn("world.pump_failed", { reason: "pump_failed" }, error);
					report = { status: "skipped", reason: "pump_failed" };
				}
				next = again;
			}
			return report;
		})().finally(() => {
			running = null;
		});
		return running;
	}

	return {
		mode: options.mode,
		service,
		lifecycle,
		gate,
		broker,
		extraction,
		context: worldContextPort(broker),
		claims,
		claimsContext: () => ({
			principal: scope.principal,
			scopeKeys: [scope.scopeKey],
		}),
		recover,
		initialSync,
		async setEnabled(enabled) {
			if (enabled) await initialSync();
			await service.setEnabled(enabled);
		},
		status: () => ({
			mode: options.mode,
			gate: { open: gate.isOpen(), reason: gate.reason() },
			world: service.status(),
			initialSyncComplete: service.initialSyncComplete(),
		}),
		pump,
		start() {
			if (closed || unsubscribe) return;
			// Commit notification: a retraction or a Memory forget reaches World
			// promptly. A feed pass writes only when it found something (the
			// cursor save is a no-op otherwise), so this cannot loop.
			unsubscribe = store.onCommit(() => {
				if (closed || debounce) return;
				debounce = setTimeout(() => {
					debounce = undefined;
					void pump();
				}, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
				debounce.unref();
			});
			// Held input resumes when the foreground ends or a cancelled call finally
			// ended. This only asks for a feed pass; the pass schedules a job only if
			// unsettled input exists, so an idle system still makes no model request.
			const resumePass = () => {
				if (closed || resume) return;
				if (options.extraction?.foreground?.active()) return;
				resume = setTimeout(() => {
					resume = undefined;
					void pump();
				}, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
				resume.unref();
			};
			const foreground = options.extraction?.foreground;
			if (extraction && foreground?.subscribe)
				unsubscribeResume.push(foreground.subscribe(resumePass));
			if (extraction) unsubscribeResume.push(extraction.onSlotFree(resumePass));
			const pollMs = options.pollMs;
			poll = setInterval(
				() => {
					void pump({ full: true });
				},
				pollMs !== undefined && Number.isFinite(pollMs) && pollMs >= 100
					? pollMs
					: DEFAULT_POLL_MS,
			);
			poll.unref();
			void pump({ full: true });
		},
		async close() {
			closed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			for (const stop of unsubscribeResume.splice(0)) stop();
			if (poll) clearInterval(poll);
			if (debounce) clearTimeout(debounce);
			if (resume) clearTimeout(resume);
			poll = undefined;
			debounce = undefined;
			resume = undefined;
			await running?.catch(() => {});
		},
	};
}
