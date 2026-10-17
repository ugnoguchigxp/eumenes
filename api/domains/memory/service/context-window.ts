import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { listAllState } from "./state-snapshot";
import type { Database } from "bun:sqlite";
import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import { latestMemoryChangeSeq } from "eumenes-memory/sqlite";
import type { ContinuityService } from "../../continuity";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import {
	activeTendencies,
	foreignImmediateSince,
	insertImmediate,
	maxImmediateSeq,
	purgeWindows,
	readSettings,
	readWindowKey,
	readWindowRow,
	tendencyRevision,
	writeWindowRow,
} from "../repository";
import {
	formatPeriod,
	longTermFromText,
	noteLines,
	renderLongTerm,
	renderShortTerm,
	shortTermFromText,
	type LayerSection,
	type StateLine,
	type TendencyLine,
} from "./context-render";
import { buildHistory, type WindowHistory } from "./context-history";

export type ImmediateKind =
	| "state_import"
	| "state_stop"
	| "state_retract"
	| "state_forget"
	| "settings"
	| "tendency_delete";

/** The versions of everything a window was built from. */
export type WindowInputs = {
	immediateSeq: number;
	stateChangeSeq: number;
	continuityRevision: number;
	tendencyRevision: number;
	policyRevision: string;
};
export type WindowPrefetch = {
	text: string;
	pins: { messageId: string; digest: string }[];
	/** Estimated tokens of `text`. */
	tokens: number;
};
export type WindowSnapshot = {
	conversationId: string;
	version: number;
	buildId: string;
	inputs: WindowInputs;
	longTerm: {
		/** The whole layer as the prompt carries it: `header`, then `sections`, written by one function (layerText). */
		text: string;
		/** The frame sentence that is the first line of `text`; "" when the layer is empty. */
		header: string;
		/** The lines of `text` after the header, grouped by heading; [] when the layer is empty. */
		sections: LayerSection[];
		manifest: { itemId: string; revision: string }[];
		/** Estimated tokens of `text`. */
		tokens: number;
	};
	shortTerm: {
		/** As `longTerm.text`: `header` and `sections` are the same layer in structure. */
		text: string;
		header: string;
		sections: LayerSection[];
		tokens: number;
		pendingAdditions: number;
		/** The State items behind "recently remembered": a usage receipt must name them too (forgetting purges by item). */
		recentItemIds?: string[];
	};
	/** L3 (the exchanges kept verbatim) and the summary, from the exchange ledger at the time of the build. */
	history: WindowHistory;
	prefetch: WindowPrefetch;
	notices: { id: string; text: string }[];
	/** The earliest validFrom/validUntil of an active State item after the build time: crossing it changes what is current. */
	nextBoundaryMs?: number | null;
	/** The earliest expiry of a short-term note shown in `shortTerm`: after it the text is out of date. */
	nextExpiryMs?: number | null;
};

const EMPTY_PREFETCH: WindowPrefetch = { text: "", pins: [], tokens: 0 };
const CONTRACT_VERSION = 1 as const;

/** The package's change counter for the shared profile: it moves whenever State there changes. */
function latestStateChange(db: Database, policyRevision: string): number {
	const changes = latestMemoryChangeSeq(db, {
		contractVersion: CONTRACT_VERSION,
		access: {
			principal: PRINCIPAL,
			scopeKeys: [PROFILE_SCOPE],
			purpose: "dialogue.read",
			policyRevision,
		},
		scopeKeys: [PROFILE_SCOPE],
	});
	if (changes.status !== "ok") throw new Error("memory_blocked");
	return changes.seq;
}

/** The current, valid State of the profile as long-term lines, and the next time validity changes. */
function currentState(db: Database, policyRevision: string, nowMs: number) {
	const listed = listAllState(db, {
		contractVersion: CONTRACT_VERSION,
		access: {
			principal: PRINCIPAL,
			scopeKeys: [PROFILE_SCOPE],
			purpose: "dialogue.read",
			policyRevision,
		},
		scopeKey: PROFILE_SCOPE,
	});
	if (listed.status !== "ok") throw new Error("memory_blocked");
	let nextBoundaryMs: number | null = null;
	for (const item of listed.items)
		for (const at of [item.validFromMs, item.validUntilMs])
			if (
				at !== null &&
				at > nowMs &&
				(nextBoundaryMs === null || at < nextBoundaryMs)
			)
				nextBoundaryMs = at;
	const lines = listed.items
		.filter((item) => {
			if (item.subject !== "self") return false;
			const validity = classifyValidity(
				periodFromStateMs(item.validFromMs, item.validUntilMs),
				nowMs,
			);
			return validity === "current" || validity === "unknown";
		})
		.map((item): StateLine => ({
			itemId: item.itemId,
			revision: item.revision,
			kind: item.kind,
			text: item.value.text,
			negated: item.value.polarity === "negated",
			period: formatPeriod(item),
			order: item.updatedSeq,
		}));
	return { lines, nextBoundaryMs };
}

/** The shown notices without the cleared ones, then the added ones, oldest first. */
function nextNotices(
	shown: WindowSnapshot["notices"],
	clearIds: readonly string[],
	added: WindowSnapshot["notices"],
): WindowSnapshot["notices"] {
	const cleared = new Set(clearIds);
	return [
		...shown.filter((notice) => !cleared.has(notice.id)),
		...added.map((notice) => ({ id: notice.id, text: notice.text })),
	];
}

/** A window built before the layers carried their structure or their token counts: both are read back from the stored text. */
function withLayerStructure(window: WindowSnapshot) {
	if (!window.longTerm.sections) {
		const { header, sections } = longTermFromText(window.longTerm.text);
		window.longTerm = { ...window.longTerm, header, sections };
	}
	if (!window.shortTerm.sections) {
		const { header, sections } = shortTermFromText(window.shortTerm.text);
		window.shortTerm = { ...window.shortTerm, header, sections };
	}
	window.longTerm.tokens ??= estimateTextTokens(window.longTerm.text);
	window.shortTerm.tokens ??= estimateTextTokens(window.shortTerm.text);
	window.prefetch.tokens ??= estimateTextTokens(window.prefetch.text);
}

export function createContextWindowStore(deps: {
	continuity: ContinuityService;
	clock: () => string;
	id: () => string;
}) {
	const { continuity, clock, id } = deps;
	/** A performance copy only: correctness is the (version, buildId) match against the database row. */
	const cache = new Map<string, WindowSnapshot>();

	function readInputs(db: Database, conversationId: string): WindowInputs {
		const policyRevision = String(readSettings(db).revision);
		return {
			immediateSeq: maxImmediateSeq(db),
			stateChangeSeq: latestStateChange(db, policyRevision),
			continuityRevision: continuity.revisionInTransaction(db, conversationId),
			tendencyRevision: tendencyRevision(db),
			policyRevision,
		};
	}

	/** The stored window: the in-process copy when it is exactly the committed row, else the row. */
	function current(
		db: Database,
		conversationId: string,
	): WindowSnapshot | null {
		const key = readWindowKey(db, conversationId);
		if (!key) return null;
		const cached = cache.get(conversationId);
		if (
			cached &&
			cached.version === key.version &&
			cached.buildId === key.buildId
		)
			return cached;
		const row = readWindowRow(db, conversationId);
		if (!row) return null;
		const parsed = JSON.parse(row.snapshot) as WindowSnapshot;
		// Built before the history was part of a window: the next read builds it again.
		if (!parsed.history) return null;
		withLayerStructure(parsed);
		cache.set(conversationId, parsed);
		return parsed;
	}

	function rebuildInTransaction(
		db: Database,
		conversationId: string,
		opts: {
			refreshLongTerm: boolean;
			prefetch?: WindowPrefetch;
			addNotices?: string[];
			clearNoticeIds?: string[];
		},
	): WindowSnapshot {
		const previous = current(db, conversationId);
		const refresh = opts.refreshLongTerm || !previous;
		const inputs = readInputs(db, conversationId);
		const now = clock();
		const { lines: states, nextBoundaryMs } = currentState(
			db,
			inputs.policyRevision,
			Date.parse(now),
		);
		let longTerm: WindowSnapshot["longTerm"];
		if (refresh || !previous) {
			const tendencies: TendencyLine[] = activeTendencies(db).map((row) => ({
				id: row.id,
				revision: row.revision,
				text: row.text,
				order: row.updatedAt,
			}));
			const rendered = renderLongTerm(states, tendencies);
			longTerm = {
				text: rendered.text,
				header: rendered.header,
				sections: rendered.sections,
				manifest: rendered.manifest,
				tokens: rendered.tokens,
			};
		} else longTerm = previous.longTerm;
		const known = new Map(
			longTerm.manifest.map((entry) => [entry.itemId, entry.revision]),
		);
		const recent = states.filter(
			(line) => known.get(line.itemId) !== String(line.revision),
		);
		const notes = continuity.snapshotInTransaction(db, conversationId).items;
		const shortTerm = renderShortTerm(recent, noteLines(notes));
		let nextExpiryMs: number | null = null;
		for (const note of notes) {
			const at = note.expiresAt === null ? null : Date.parse(note.expiresAt);
			if (at !== null && (nextExpiryMs === null || at < nextExpiryMs))
				nextExpiryMs = at;
		}
		const notices = nextNotices(
			previous?.notices ?? [],
			opts.clearNoticeIds ?? [],
			(opts.addNotices ?? []).map((text) => ({ id: id(), text })),
		);
		const snapshot: WindowSnapshot = {
			conversationId,
			version: (readWindowKey(db, conversationId)?.version ?? 0) + 1,
			buildId: id(),
			// L1 keeps the versions it was built from: a change not yet in it must stay visible to the next read.
			inputs:
				refresh || !previous
					? inputs
					: {
							...inputs,
							immediateSeq: previous.inputs.immediateSeq,
							policyRevision: previous.inputs.policyRevision,
						},
			longTerm,
			history: buildHistory(db, conversationId, previous?.history),
			shortTerm: {
				text: shortTerm.text,
				header: shortTerm.header,
				sections: shortTerm.sections,
				tokens: shortTerm.tokens,
				pendingAdditions: shortTerm.pendingAdditions,
				recentItemIds: recent.map((line) => line.itemId),
			},
			prefetch: opts.prefetch ?? previous?.prefetch ?? EMPTY_PREFETCH,
			notices,
			nextExpiryMs,
			// L1 is not re-rendered here, so its boundary stays the one it was built with.
			nextBoundaryMs:
				refresh || !previous
					? nextBoundaryMs
					: (previous.nextBoundaryMs ?? null),
		};
		writeWindowRow(
			db,
			conversationId,
			{
				version: snapshot.version,
				buildId: snapshot.buildId,
				snapshot: JSON.stringify(snapshot),
			},
			now,
		);
		// A rolled-back transaction leaves the row behind this copy; the next read notices by buildId.
		cache.set(conversationId, snapshot);
		return snapshot;
	}

	function boundaryCrossed(snapshot: WindowSnapshot): boolean {
		const boundary = snapshot.nextBoundaryMs ?? null;
		return boundary !== null && Date.parse(clock()) >= boundary;
	}

	return {
		/** The window last stored for the conversation, as it was built; never rebuilds (a read connection may call it). */
		storedInTransaction: current,
		/** Prepare-time read (write transaction). Rebuilds and stores when an input moved. */
		readForRunInTransaction(
			db: Database,
			conversationId: string,
		): WindowSnapshot {
			let snapshot = current(db, conversationId);
			if (!snapshot)
				return rebuildInTransaction(db, conversationId, {
					refreshLongTerm: true,
				});
			const inputs = readInputs(db, conversationId);
			const was = snapshot.inputs;
			let refreshed = false;
			if (
				inputs.immediateSeq !== was.immediateSeq ||
				inputs.policyRevision !== was.policyRevision
			) {
				snapshot = rebuildInTransaction(db, conversationId, {
					refreshLongTerm: true,
				});
				refreshed = true;
			} else if (
				inputs.stateChangeSeq !== was.stateChangeSeq ||
				inputs.continuityRevision !== was.continuityRevision ||
				inputs.tendencyRevision !== was.tendencyRevision
			)
				snapshot = rebuildInTransaction(db, conversationId, {
					refreshLongTerm: false,
				});
			// A note that has expired since the layer was rendered must leave it.
			const expiry = snapshot.nextExpiryMs ?? null;
			if (!refreshed && expiry !== null && Date.parse(clock()) >= expiry)
				snapshot = rebuildInTransaction(db, conversationId, {
					refreshLongTerm: false,
				});
			// Crossing the validity boundary changes what is current; the date changing or additions piling up do not.
			if (!refreshed && boundaryCrossed(snapshot))
				snapshot = rebuildInTransaction(db, conversationId, {
					refreshLongTerm: true,
				});
			return snapshot;
		},
		rebuildInTransaction,
		/**
		 * The steward's republish (section 2.4): history, summary, short-term and notices are built again from the
		 * ledger and State. L1 is rendered again only when `republishLongTerm` asks for it, there was no window, or
		 * the conditions of readForRunInTransaction apply (an immediate change, a policy change, a validity
		 * boundary crossed). It records no immediate change, so a run in flight is not expired by it.
		 */
		publishInTransaction(
			db: Database,
			conversationId: string,
			opts: {
				republishLongTerm?: boolean;
				prefetch?: WindowPrefetch;
				addNotices?: string[];
			},
		): WindowSnapshot {
			const previous = current(db, conversationId);
			let refresh = opts.republishLongTerm === true || !previous;
			if (previous && !refresh) {
				const inputs = readInputs(db, conversationId);
				refresh =
					inputs.immediateSeq !== previous.inputs.immediateSeq ||
					inputs.policyRevision !== previous.inputs.policyRevision ||
					boundaryCrossed(previous);
			}
			return rebuildInTransaction(db, conversationId, {
				refreshLongTerm: refresh,
				...(opts.prefetch ? { prefetch: opts.prefetch } : {}),
				...(opts.addNotices ? { addNotices: opts.addNotices } : {}),
			});
		},
		/**
		 * Drops shown notices without re-rendering anything (it runs after the answer is saved and must not fail
		 * on memory state). No stored window, or none of the ids present, is a no-op.
		 */
		clearNoticesInTransaction(
			db: Database,
			conversationId: string,
			noticeIds: readonly string[],
		) {
			const previous = current(db, conversationId);
			if (!previous) return;
			const cleared = new Set(noticeIds);
			const notices = previous.notices.filter(
				(notice) => !cleared.has(notice.id),
			);
			if (notices.length === previous.notices.length) return;
			const snapshot: WindowSnapshot = {
				...previous,
				version: (readWindowKey(db, conversationId)?.version ?? 0) + 1,
				buildId: id(),
				notices,
			};
			writeWindowRow(
				db,
				conversationId,
				{
					version: snapshot.version,
					buildId: snapshot.buildId,
					snapshot: JSON.stringify(snapshot),
				},
				clock(),
			);
			cache.set(conversationId, snapshot);
		},
		/**
		 * Removes every stored window (all conversations) and the in-process copies. Rendered memory text
		 * lives in them, so forgetting must not leave it behind; the next read builds again from State.
		 */
		purgeInTransaction(db: Database) {
			purgeWindows(db);
			cache.clear();
		},
		/** Same transaction as the change itself: a run in flight that predates it is expired. */
		recordImmediateInTransaction(
			db: Database,
			kind: ImmediateKind,
			sourceRunId: string | null,
		) {
			insertImmediate(db, kind, sourceRunId, clock());
		},
		/** True when something other than `runId` changed immediately after `seq`. */
		changedSinceInTransaction(db: Database, seq: number, runId: string) {
			return foreignImmediateSince(db, seq, runId);
		},
	};
}
export type ContextWindowStore = ReturnType<typeof createContextWindowStore>;
