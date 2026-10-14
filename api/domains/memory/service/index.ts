import type { Database } from "bun:sqlite";
import {
	CONTRACT_VERSIONS,
	classifyValidity,
	periodFromStateMs,
	sliceUtf8Range,
	verifyForgetJournal,
} from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import {
	assertMemorySchema,
	assertUserState,
	deactivateState,
	listState,
	reactivateState,
	reconcileForgetJournal,
	retractState,
} from "eumenes-memory/sqlite";
import type { HostSourceState, StateItem } from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	type MemoryEmbed,
	type MemoryItemDto,
	type MemoryStatus,
	PRINCIPAL,
	PROFILE_SCOPE,
	type PreparedWindow,
	type Remember,
	type SettleResult,
	type TurnRecall,
} from "../contracts";
import {
	deleteTendenciesByStateEvidence,
	excludeMessage,
	getUsage,
	insertUsage,
	provenanceOf,
	putProvenance,
	pruneUsage,
	readSettings,
	writeSettings,
} from "../repository";
import { createMemoryAgent } from "./agent";
import { SHORT_TERM_BYTES, noteLines, renderShortTerm } from "./context-render";
import {
	createContextWindowStore,
	type WindowSnapshot,
} from "./context-window";
import { STATE_ID, forgetChecked } from "./forget";
import { readJournal } from "./journal";
import { createAgentOperations } from "./operation";
import { recallTurns, type RecallInput } from "./turn-recall";
import { dropVectorsOnRetract } from "./retract-vectors";
import { createMemoryViews } from "./views";
import type { AgentInferencePort, AgentQueuePort } from "./ports";
import { validityOf } from "./validity";
import pkg from "eumenes-memory/package.json";
import { MemoryContractError } from "eumenes-memory";

const VERSION = 1 as const;
const PACKAGE_VERSION = pkg.version;
/** Active State items kept in the shared profile. Keeps the fixed view inside its byte budget. */
const MAX_ACTIVE_ITEMS = 100;
const sha = (text: string) => sha256Hex(text);

/** The words an item stands on, cut out of the messages by their recorded byte ranges. */
function evidenceOf(
	conversation: ConversationService,
	db: Database,
	item: StateItem,
): MemoryItemDto["evidence"] {
	return item.evidence
		.filter((ref) => ref.namespace === "conversation")
		.map((ref) => {
			const found = conversation.messageInTransaction(db, ref.id);
			const slice =
				found && ref.range
					? sliceUtf8Range(found.message.text, ref.range)
					: undefined;
			return {
				messageId: ref.id,
				quote: slice?.status === "ok" ? slice.text : null,
			};
		});
}

function itemDto(
	conversation: ConversationService,
	db: Database,
	item: StateItem,
): MemoryItemDto {
	return {
		id: item.itemId,
		kind: item.kind,
		semanticKey: item.semanticKey,
		text: item.value.text,
		polarity: item.value.polarity,
		status: item.status,
		origin: item.origin,
		revision: item.revision,
		sourceMessageIds: item.evidence
			.filter((ref) => ref.namespace === "conversation")
			.map((ref) => ref.id),
		validFromMs: item.validFromMs,
		validUntilMs: item.validUntilMs,
		evidence: evidenceOf(conversation, db, item),
		validity: validityOf(item),
		capturedBy: provenanceOf(db, item.itemId),
	};
}

export function createMemoryService(
	store: SqliteStore,
	conversation: ConversationService,
	continuity: ContinuityService,
	options: {
		journalPath: string;
		clock?: () => string;
		id?: () => string;
		/** Without both of these the memory agent never runs (memory then only changes through the API). */
		queue?: AgentQueuePort;
		inference?: AgentInferencePort;
		/** Embedding for the turn vectors; looked up at each use, so the application may create it after memory. */
		embed?: () => MemoryEmbed | undefined;
	},
) {
	const clock = options.clock ?? (() => new Date().toISOString());
	let healthy = false;
	/** Set by a failed recovery, cleared by the next good one. */
	let wasUnhealthy = false;
	/**
	 * The policy revision access() puts into every AccessContext. Other domains
	 * (World) that must present the SAME revision to Memory read it here, never
	 * from the settings table.
	 */
	const policyRevisionInTransaction = (db: Database): string =>
		String(readSettings(db).revision);
	const access = (db: Database, purpose: string): AccessContext => ({
		principal: PRINCIPAL,
		scopeKeys: [PROFILE_SCOPE],
		purpose,
		policyRevision: policyRevisionInTransaction(db),
	});
	const scoped = (db: Database, purpose: string) => ({
		contractVersion: VERSION,
		access: access(db, purpose),
		scopeKey: PROFILE_SCOPE,
	});
	const atMs = () => Date.parse(clock());
	const windows = createContextWindowStore({
		continuity,
		clock,
		id: options.id ?? (() => crypto.randomUUID()),
	});

	function hostMessageSource(
		found: NonNullable<ReturnType<ConversationService["messageInTransaction"]>>,
	): HostSourceState {
		const digest = sha(found.message.text);
		return {
			namespace: "conversation",
			kind: "message",
			id: found.message.id,
			representation: "text",
			revision: `sha256:${digest}`,
			digest,
			principal: PRINCIPAL,
			scopeKey: PROFILE_SCOPE,
			status: "available",
			content: found.message.text,
			ordinal: found.ordinal,
		};
	}

	const toDto = (db: Database, item: StateItem) =>
		itemDto(conversation, db, item);

	/** The profile's State as the library lists it; a refusal is an error, never an empty profile. */
	function stateItems(
		db: Database,
		includeInactive: boolean,
	): readonly StateItem[] {
		const result = listState(db, {
			...scoped(db, "memory.agent"),
			includeInactive,
		});
		if (result.status !== "ok") throw new Error("memory_blocked");
		return result.items;
	}

	function reject(code: string): never {
		throw new Error(code);
	}

	/**
	 * `sourceRunId`: set when the memory agent writes from a conversation turn, so that run is not expired by its own change.
	 * `origin`: `agent_inferred` for what the agent concluded without being asked; it gets none of the protections of
	 * what the user said or asked for, and a later explicit request for the same key replaces it.
	 */
	function rememberInTransaction(
		db: Database,
		input: Remember,
		sourceRunId: string | null = null,
		origin: "user_confirmed" | "agent_inferred" = "user_confirmed",
	): { item: MemoryItemDto; changed: boolean } {
		// One listing serves both the item limit and the "replaces the active fact" lookup.
		const listed = listState(db, scoped(db, "memory.write"));
		const items = listed.status === "ok" ? listed.items : [];
		const active = items.find(
			(item) =>
				item.kind === input.kind &&
				item.subject === "self" &&
				item.semanticKey === input.semanticKey &&
				item.status === "active",
		);
		// An expired item no longer occupies the profile, whatever its status says.
		const now = atMs();
		const counted = items.filter(
			(item) =>
				classifyValidity(
					periodFromStateMs(item.validFromMs, item.validUntilMs),
					now,
				) !== "past",
		).length;
		if (counted >= MAX_ACTIVE_ITEMS && !active) reject("invalid_memory_limit");
		const found = conversation.messageInTransaction(db, input.messageId);
		if (
			!found ||
			found.message.conversationId !== input.conversationId ||
			found.message.role !== "user"
		)
			return reject("invalid_memory_source");
		const source = hostMessageSource(found);
		const at = source.content.indexOf(input.quote);
		if (at < 0) reject("invalid_memory_quote");
		const startByte = Buffer.byteLength(source.content.slice(0, at), "utf8");
		const { ordinal: _o, content: _c, ...ref } = source;
		void _o;
		void _c;
		const result = assertUserState(db, {
			...scoped(db, "memory.write"),
			clock: { atMs: now },
			kind: input.kind,
			subject: "self",
			semanticKey: input.semanticKey,
			value: { text: input.text, polarity: input.polarity },
			evidence: [
				{
					source: {
						namespace: ref.namespace,
						kind: ref.kind,
						id: ref.id,
						representation: "text",
						revision: ref.revision,
						digest: ref.digest,
						range: {
							startByte,
							endByte: startByte + Buffer.byteLength(input.quote, "utf8"),
						},
					},
					quote: input.quote,
				},
			],
			sources: [source],
			origin,
			...(input.validity === undefined ? {} : { validity: input.validity }),
			...(input.validFromMs === undefined
				? {}
				: { validFromMs: input.validFromMs }),
			...(input.validUntilMs === undefined
				? {}
				: { validUntilMs: input.validUntilMs }),
			...(active
				? { replaces: { itemId: active.itemId, revision: active.revision } }
				: {}),
		});
		if (result.status !== "applied" && result.status !== "unchanged")
			reject("invalid_memory_write");
		// A replaced value or a denial overrides what the published long-term layer says: it cannot wait for the next republish.
		if (result.status === "applied" && (active || input.polarity === "negated"))
			windows.recordImmediateInTransaction(db, "state_replace", sourceRunId);
		return {
			item: toDto(db, result.item),
			changed: result.status === "applied",
		};
	}

	const TRANSITIONS = {
		stop: deactivateState,
		resume: reactivateState,
		retract: retractState,
	} as const;
	function transitionInTransaction(
		db: Database,
		action: keyof typeof TRANSITIONS,
		itemId: string,
		expectedRevision: number,
		sourceRunId: string | null = null,
	): MemoryItemDto {
		if (!healthy) reject("memory_unavailable");
		let result: ReturnType<(typeof TRANSITIONS)[typeof action]>;
		try {
			result = TRANSITIONS[action](db, {
				...scoped(db, "memory.write"),
				clock: { atMs: atMs() },
				itemId,
				expectedRevision,
			});
		} catch (error) {
			if (error instanceof MemoryContractError) reject("invalid_memory_input");
			throw error;
		}
		if (result.status === "applied" || result.status === "unchanged") {
			// Stopping and retracting remove a value from the published layer at once; resuming is an addition.
			if (result.status === "applied" && action !== "resume")
				windows.recordImmediateInTransaction(
					db,
					action === "stop" ? "state_stop" : "state_retract",
					sourceRunId,
				);
			return toDto(db, result.item);
		}
		if (result.status !== "rejected") return reject("invalid_memory_item");
		// Only a stale revision is a conflict; other rejections (e.g. another active item of the same fact) are invalid requests.
		return reject(
			result.reasonCode === "STALE_REVISION"
				? "revision_conflict"
				: "invalid_memory_transition",
		);
	}
	function transitionItemInTransaction(
		db: Database,
		action: keyof typeof TRANSITIONS,
		itemId: string,
		expectedRevision: number,
	): MemoryItemDto {
		if (!STATE_ID.test(itemId)) return reject("invalid_memory_item");
		return transitionInTransaction(db, action, itemId, expectedRevision);
	}

	/** Removes receipts that reference any of the given items, in one pass over the (pruned, bounded) table. */
	function purgeUsageFor(db: Database, itemIds: Iterable<string>) {
		const targets = new Set(itemIds);
		if (targets.size === 0) return;
		const rows = db
			.query("SELECT run_id, item_ids FROM memory_usage")
			.all() as Array<{ run_id: string; item_ids: string }>;
		const remove = db.query("DELETE FROM memory_usage WHERE run_id = ?");
		for (const row of rows) {
			const ids = JSON.parse(row.item_ids) as string[];
			if (ids.some((id) => targets.has(id))) remove.run(row.run_id);
		}
	}

	/** A transient failure (busy queue, closing) must not leave memory off until the next restart. */
	async function recoverWithRetry() {
		let result = await recover();
		for (
			let attempt = 0;
			attempt < 3 && result.reason === "recover_failed";
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
			result = await recover();
		}
		return result;
	}

	// Continuity additions are checked against the short-term layer's byte budget in their own transaction.
	continuity.setGuard((db, conversationId) => {
		const { fullBytes } = renderShortTerm(
			[],
			noteLines(continuity.snapshotInTransaction(db, conversationId).items),
		);
		if (fullBytes > SHORT_TERM_BYTES) reject("invalid_continuity_limit");
	});
	// The user closing an item takes effect for runs in flight; additions do not (they reach the short-term layer).
	continuity.setUserChangeHook((db) =>
		windows.recordImmediateInTransaction(db, "continuity_close", null),
	);

	conversation.setRetractHook(dropVectorsOnRetract(conversation));

	const operations = createAgentOperations({
		conversation,
		continuity,
		clock,
		id: options.id ?? (() => crypto.randomUUID()),
		listState: stateItems,
		remember: rememberInTransaction,
		transition: transitionInTransaction,
	});
	const forgetDeps = {
		journalPath: options.journalPath,
		access,
		atMs,
		windows,
		purgeUsageFor,
		ready: () => healthy,
	};
	const views = createMemoryViews({
		store,
		continuity,
		windows,
		healthy: () => healthy,
	});
	const agent = createMemoryAgent({
		store,
		conversation,
		continuity,
		windows,
		operations,
		ready: (db) => healthy && readSettings(db).enabled,
		listState: stateItems,
		atMs,
		embed: options.embed,
		recall: (db, input) => recallTurns(db, conversation, input),
		queue: options.queue,
		inference: options.inference,
	});

	function setEnabledInTransaction(
		db: Database,
		enabled: boolean,
	): MemoryStatus {
		// Toggling to the same value must not invalidate runs in flight.
		if (readSettings(db).enabled !== enabled) {
			writeSettings(db, enabled);
			windows.recordImmediateInTransaction(db, "settings", null);
			// What was said while memory was off is never learned.
			if (enabled) agent.skipUnreadInTransaction(db);
		}
		return { enabled, healthy };
	}

	async function recover(): Promise<{
		healthy: boolean;
		reapplied: number;
		reason?: string;
		/** The database was older than the journal: change-feed subscribers must drop their cursors. */
		feedResyncRequired?: true;
	}> {
		const fail = (reason: string) => {
			healthy = false;
			wasUnhealthy = true;
			return { healthy, reapplied: 0, reason };
		};
		try {
			return await store.write((db) => {
				try {
					// A newer or tampered schema disables memory instead of being read.
					assertMemorySchema(db);
				} catch {
					return fail("schema_mismatch");
				}
				let entries: ReturnType<typeof readJournal>;
				try {
					entries = readJournal(options.journalPath);
				} catch {
					return fail("journal_unreadable");
				}
				const verified = verifyForgetJournal(entries);
				if (verified.status !== "ok") return fail("journal_chain_broken");
				const result = reconcileForgetJournal(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					entries,
					clock: { atMs: atMs() },
				});
				if (result.status !== "ok") return fail(result.reasonCode);
				// Re-applied forgets removed values the published layer may still hold.
				if (result.reapplied > 0) {
					windows.recordImmediateInTransaction(db, "state_forget", null);
					windows.purgeInTransaction(db);
				}
				// Receipts of every journaled forget are purged here too: a forget that was only re-applied
				// (rolled-back commit, crash, restored old database) never ran the purge in its own transaction.
				const forgottenIds = entries.flatMap((entry) =>
					entry.targets
						.filter((target) => target.type === "state_item")
						.map((target) => target.id),
				);
				purgeUsageFor(db, forgottenIds);
				// The same holds for tendencies derived from a re-applied forget's items.
				if (deleteTendenciesByStateEvidence(db, forgottenIds) > 0) {
					windows.recordImmediateInTransaction(db, "tendency_delete", null);
					windows.purgeInTransaction(db);
				}
				healthy = true;
				// Coming back from an unhealthy spell: what was said meanwhile is not learned.
				if (wasUnhealthy) {
					agent.skipUnreadInTransaction(db);
					wasUnhealthy = false;
				}
				return {
					healthy,
					reapplied: result.reapplied,
					...(result.feedResyncRequired === true
						? { feedResyncRequired: true as const }
						: {}),
				};
			});
		} catch {
			return fail("recover_failed");
		}
	}

	return {
		policyRevisionInTransaction,
		windows,
		status(): MemoryStatus {
			return { enabled: store.read((db) => readSettings(db).enabled), healthy };
		},
		setEnabled(enabled: boolean): Promise<MemoryStatus> {
			return store.write((db) => setEnabledInTransaction(db, enabled));
		},
		setEnabledInTransaction,
		/**
		 * Must complete before workers start. A broken journal makes memory unusable (fail closed).
		 * The journal is read inside the writer queue, so it can never be older than the database head.
		 */
		recover: recoverWithRetry,
		list(includeInactive = false): MemoryItemDto[] {
			// Fail closed: with an inconsistent journal a forgotten value may still be in this database.
			if (!healthy) return [];
			return store.read((db) => {
				const result = listState(db, {
					...scoped(db, "memory.list"),
					includeInactive,
				});
				return result.status === "ok"
					? result.items.map((item) => toDto(db, item))
					: [];
			});
		},
		remember(input: Remember): Promise<MemoryItemDto> {
			return store.write((db) => {
				if (!healthy) reject("memory_unavailable");
				try {
					const { item, changed } = rememberInTransaction(db, input);
					if (changed) putProvenance(db, item.id, null, "manual", clock());
					return changed ? { ...item, capturedBy: "manual" } : item;
				} catch (error) {
					// Library contract violations (impossible dates, mixed bounds...) are caller errors.
					if (error instanceof MemoryContractError)
						reject("invalid_memory_input");
					throw error;
				}
			});
		},
		/** Reversible stop (not forgetting). */
		stop: (itemId: string, expectedRevision: number) =>
			store.write((db) =>
				transitionItemInTransaction(db, "stop", itemId, expectedRevision),
			),
		resume: (itemId: string, expectedRevision: number) =>
			store.write((db) =>
				transitionItemInTransaction(db, "resume", itemId, expectedRevision),
			),
		/** Terminal "this is wrong" (kept as history; value stays). */
		retract: (itemId: string, expectedRevision: number) =>
			store.write((db) =>
				transitionItemInTransaction(db, "retract", itemId, expectedRevision),
			),
		transitionItemInTransaction,
		/** Plan -> journal (fsync) -> apply, serialized in the single writer. Works even when memory is off. */
		forget(itemId: string): Promise<{ forgetId: string; completed: boolean }> {
			let journaled = false;
			return store
				.write((db) =>
					forgetChecked(forgetDeps, db, itemId, () => {
						journaled = true;
					}),
				)
				.catch(async (error: unknown) => {
					// Only when an entry may have reached the journal ahead of the rolled-back database: reconcile
					// before anything else runs. Rejections before the journal (validation, queue full) change nothing.
					if (journaled) {
						healthy = false;
						await recoverWithRetry();
						// The journal carries the forget to completion; the caller must not assume it finished.
						throw new Error("memory_forget_incomplete");
					}
					throw error;
				});
		},
		/**
		 * The same forget inside a writer transaction the caller owns. The journal is reconciled once that
		 * transaction is over (it may roll back after the entry was written); a failure closes memory first.
		 */
		forgetInTransaction(db: Database, itemId: string) {
			let journaled = false;
			try {
				const forgotten = forgetChecked(forgetDeps, db, itemId, () => {
					journaled = true;
				});
				void recoverWithRetry();
				return forgotten;
			} catch (error) {
				if (!journaled) throw error;
				healthy = false;
				void recoverWithRetry();
				throw new Error("memory_forget_incomplete");
			}
		},
		/**
		 * Queues the memory agent when the conversation has messages it has not read (same transaction as the
		 * message or answer that made them). Does nothing when memory is off, unhealthy, or not wired; never throws.
		 */
		scheduleAgentInTransaction(db: Database, conversationId: string) {
			agent.scheduleInTransaction(db, conversationId);
		},
		/** Marks a message the agent must never learn from (a scheduled prompt stored as a user message). */
		excludeMessageInTransaction(db: Database, messageId: string) {
			excludeMessage(db, messageId);
		},
		/** The queue handler of the memory agent (`memory.agent.v1`); the application registers it. */
		agentHandler: () => agent.handler,
		/** One agent operation, all or nothing (exposed for the agent's settle and for tests). */
		applyAgentOpInTransaction: operations.applyInTransaction,
		...views,
		/**
		 * Prepare-time read of the run's ContextWindow (write transaction). null when memory is off or unhealthy:
		 * the run then proceeds without memory. A library refusal throws `memory_blocked` instead of being hidden.
		 */
		windowForRunInTransaction(
			db: Database,
			conversationId: string,
		): WindowSnapshot | null {
			if (!healthy || !readSettings(db).enabled) return null;
			const window = windows.readForRunInTransaction(db, conversationId);
			// Prefetched exchanges whose messages changed since are dropped now: they would expire every run until replaced.
			if (
				window.prefetch.pins.some((pin) => {
					const found = conversation.messageInTransaction(db, pin.messageId);
					return !found || sha(found.message.text) !== pin.digest;
				})
			)
				return windows.rebuildInTransaction(db, conversationId, {
					refreshLongTerm: false,
					prefetch: { text: "", pins: [], bytes: 0 },
				});
			return window;
		},
		/**
		 * Earlier exchanges that resemble `vector`, from before the verbatim window (read-only, no tool call).
		 * null when memory is off or unhealthy, or nothing qualifies.
		 */
		recallTurnsInRead(db: Database, input: RecallInput): TurnRecall | null {
			if (!healthy || !readSettings(db).enabled) return null;
			return recallTurns(db, conversation, input);
		},
		/**
		 * Adoption-time check in the writer transaction. Additions never expire a run; immediate changes by
		 * anyone but the run's own memory step, a settings change, or a changed pinned message do.
		 */
		validateWindowInTransaction(
			db: Database,
			runId: string,
			window: PreparedWindow,
			extraPins: ReadonlyArray<{ messageId: string; digest: string }> = [],
		): SettleResult {
			if (!healthy || !readSettings(db).enabled)
				return { ok: false, reason: "memory_unavailable" };
			if (String(readSettings(db).revision) !== window.policyRevision)
				return { ok: false, reason: "memory_stale" };
			if (windows.changedSinceInTransaction(db, window.immediateSeq, runId))
				return { ok: false, reason: "memory_stale" };
			for (const pin of [...window.pins, ...extraPins]) {
				const found = conversation.messageInTransaction(db, pin.messageId);
				if (!found || sha(found.message.text) !== pin.digest)
					return { ok: false, reason: "memory_stale" };
			}
			return { ok: true };
		},
		/** What a run keeps of a window for the adoption check (the texts stay in its prompt). */
		preparedWindow(
			window: WindowSnapshot,
			windowStartOrdinal = 0,
		): PreparedWindow {
			return {
				conversationId: window.conversationId,
				version: window.version,
				buildId: window.buildId,
				immediateSeq: window.inputs.immediateSeq,
				policyRevision: window.inputs.policyRevision,
				manifest: [
					...window.longTerm.manifest.map((entry) => entry.itemId),
					...(window.shortTerm.recentItemIds ?? []),
				],
				pins: window.prefetch.pins,
				prefetchBytes: window.prefetch.bytes,
				noticeIds: window.notices.map((notice) => notice.id),
				windowStartOrdinal,
			};
		},
		/** The usage receipt of an adopted run: which window version it read. */
		recordUsageInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
			window: PreparedWindow,
		) {
			insertUsage(db, {
				runId,
				conversationId,
				viewDigest: `window:${window.version}:${window.buildId}`,
				stateRevision: String(window.immediateSeq),
				packageVersion: PACKAGE_VERSION,
				viewSchema: 3,
				itemIds: window.manifest,
				createdAt: clock(),
			});
			pruneUsage(db);
		},
		/** Notices are shown once: dropped when the answer that carried them is stored. */
		clearNoticesInTransaction(
			db: Database,
			conversationId: string,
			noticeIds: readonly string[],
		) {
			if (noticeIds.length === 0) return;
			windows.clearNoticesInTransaction(db, conversationId, noticeIds);
		},
		/** The adoption failed after the receipt was written: no answer exists, so no receipt may either. */
		discardUsageInTransaction(db: Database, runId: string) {
			db.query("DELETE FROM memory_usage WHERE run_id = ?").run(runId);
		},
		usage(runId: string) {
			return store.read((db) => getUsage(db, runId));
		},
	};
}
export type MemoryService = ReturnType<typeof createMemoryService>;
