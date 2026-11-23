import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import { listAllState } from "./state-snapshot";
import { normalizeText, searchDocOf } from "./recall-score";
import type { Database } from "bun:sqlite";
import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import type { StateItem } from "eumenes-memory/sqlite";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import {
	activeTendencies,
	foreignImmediateSince,
	insertImmediate,
	maxImmediateSeq,
	purgeWindows,
	readInputBudget,
	readMarks,
	readSettings,
	readWindowKey,
	readWindowRow,
	tendencyRevision,
	writeWindowRow,
} from "../repository";
import {
	lastTokyoDay,
	profileItemFields,
	publishedOrder,
	tokyoDay,
	type ProfileItem,
} from "./profile";

export type ImmediateKind =
	| "state_import"
	| "state_stop"
	| "state_correct"
	| "state_retract"
	| "state_forget"
	| "state_exclude"
	| "state_suppress"
	| "settings"
	| "tendency_delete";

/** The versions of everything a window was built from. */
export type WindowInputs = {
	immediateSeq: number;
	stateChangeSeq: number;
	tendencyRevision: number;
	policyRevision: string;
	/** What the always-on section is built from (its size and range): a change republishes the profile. */
	budgetKey: string;
};
/**
 * The long-term memory a conversation's window shows (`profile`), what has changed since it was published
 * (`newMemories`). The profile is republished only by a
 * re-construction (`republishInTransaction`) or an immediate change; additions wait in `newMemories` meanwhile.
 */
export type WindowSnapshot = {
	/** How the items are drawn (`WINDOW_FORMAT`): a snapshot of another form is built again on its next read. */
	format: number;
	conversationId: string;
	version: number;
	buildId: string;
	inputs: WindowInputs;
	profile: {
		/** The items in their published order. */
		items: ProfileItem[];
		/** Estimated tokens of the items as JSON. */
		tokens: number;
	};
	/** Current items the published profile does not show (new, or at a newer revision). */
	newMemories: ProfileItem[];
	/** The steward asked for a republish: the next re-construction applies it. */
	republishRequested: boolean;
	/** The earliest validFrom/validUntil of an active State item after the build time: crossing it changes what is current. */
	nextBoundaryMs: number | null;
};

const CONTRACT_VERSION = 1 as const;
/** 2: a State item's source follows its origin (an inference is not the user's own words). 3: the items carry their marks (sensitive, about someone else). */
const WINDOW_FORMAT = 3;

/** The package's change counter for the shared profile: it moves whenever State there changes. */
function latestStateChange(db: Database, policyRevision: string): number {
	// Record captures (for example an Agency observation archive) do not change the user's State.
	// Include every live status; explicit forgets also move the host's immediate-change fence.
	const states = listAllState(db, {
		contractVersion: CONTRACT_VERSION,
		access: {
			principal: PRINCIPAL,
			scopeKeys: [PROFILE_SCOPE],
			purpose: "dialogue.read",
			policyRevision,
		},
		scopeKey: PROFILE_SCOPE,
		includeInactive: true,
		// The counter moves with every item, also an excluded one: it must never step back.
		includeExcluded: true,
	});
	if (states.status !== "ok") throw new Error("memory_blocked");
	return states.items.reduce((seq, item) => Math.max(seq, item.updatedSeq), 0);
}

interface PartialDateLike {
	precision: "year" | "month" | "day";
	year: number;
	month?: number;
	day?: number;
}
const two = (n: number) => String(n).padStart(2, "0");
/** A partial date as written (2026, 2026-09, 2026-09-01): absolute, never relative to now. */
function partialDay(date: PartialDateLike): string {
	if (date.precision === "year") return String(date.year);
	if (date.precision === "month") return `${date.year}-${two(date.month!)}`;
	return `${date.year}-${two(date.month!)}-${two(date.day!)}`;
}

/** The user's own record, valid now (or with no bounds). */
export function isCurrentSelf(item: StateItem, nowMs: number): boolean {
	if (item.subject !== "self") return false;
	const validity = classifyValidity(
		periodFromStateMs(item.validFromMs, item.validUntilMs),
		nowMs,
	);
	return validity === "current" || validity === "unknown";
}

/** The current, valid State of the profile and the tendencies as items, and the next time validity changes. */
function currentItems(
	db: Database,
	policyRevision: string,
	nowMs: number,
	suppressed: "mark" | "omit" = "mark",
) {
	const listed = listAllState(db, {
		contractVersion: CONTRACT_VERSION,
		access: {
			principal: PRINCIPAL,
			scopeKeys: [PROFILE_SCOPE],
			purpose: "dialogue.read",
			policyRevision,
		},
		scopeKey: PROFILE_SCOPE,
		suppressed,
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
	const marks = readMarks(db);
	const docs = new Map<string, string>();
	const states = listed.items
		.filter((item) => isCurrentSelf(item, nowMs))
		.map((item): ProfileItem => {
			const validity = (
				item as {
					validity?: { from?: PartialDateLike; until?: PartialDateLike };
				}
			).validity;
			const since = validity?.from
				? partialDay(validity.from)
				: item.validFromMs === null
					? undefined
					: tokyoDay(item.validFromMs);
			const until = validity?.until
				? partialDay(validity.until)
				: item.validUntilMs === null
					? undefined
					: lastTokyoDay(item.validUntilMs);
			const mark = marks.get(item.itemId);
			docs.set(item.itemId, searchDocOf(item));
			return {
				id: item.itemId,
				...(item.suppressed ? { suppressed: true as const } : {}),
				...(mark?.sensitive ? { sensitive: true as const } : {}),
				...(mark?.aboutOther ? { aboutOther: true as const } : {}),
				kind: item.kind,
				text: item.value.text.replace(/\s+/g, " ").trim(),
				negated: item.value.polarity === "negated",
				// What the user confirmed or edited is theirs; what the agent inferred is shown as an inference.
				source:
					item.origin === "user_confirmed" || item.origin === "user_edited"
						? "user_said"
						: "inferred",
				...(since ? { since } : {}),
				...(until ? { until } : {}),
				revision: item.revision,
				newness: item.updatedSeq,
				...(item.validUntilMs === null ? {} : { untilMs: item.validUntilMs }),
			};
		});
	const tendencies = activeTendencies(db).map((row): ProfileItem => {
		const id = `tendency:${row.id}`;
		docs.set(id, normalizeText(row.text));
		return {
			id,
			kind: "tendency",
			text: row.text.replace(/\s+/g, " ").trim(),
			negated: false,
			source: "observed",
			revision: row.revision,
			newness: Date.parse(row.updatedAt),
		};
	});
	return { items: [...states, ...tendencies], nextBoundaryMs, docs };
}

/** Tokens of the profile as the conversation reads it (the items' JSON). */
export function profileTokens(items: readonly ProfileItem[]): number {
	return estimateTextTokens(referenceJson(items.map(profileItemFields)));
}

export function createContextWindowStore(deps: {
	clock: () => string;
	id: () => string;
}) {
	const { clock, id } = deps;
	/** The tendencies a forget in flight holds back (set by the service once the sources are known). */
	let withheldTendencies: ((db: Database) => ReadonlySet<string>) | undefined;
	/** The current profile items; a tendency standing on an excluded item, candidate or message is left out. */
	const itemsNow = (
		db: Database,
		policyRevision: string,
		nowMs: number,
		suppressed: "mark" | "omit" = "mark",
	) => {
		const found = currentItems(db, policyRevision, nowMs, suppressed);
		const hidden = withheldTendencies?.(db);
		return !hidden || hidden.size === 0
			? found
			: {
					...found,
					items: found.items.filter(
						(item) =>
							!(
								item.kind === "tendency" &&
								hidden.has(item.id.slice("tendency:".length))
							),
					),
				};
	};
	/** A performance copy only: correctness is the (version, buildId) match against the database row. */
	const cache = new Map<string, WindowSnapshot>();

	function budgetKeyOf(db: Database): string {
		const { alwaysTokens, alwaysScope } = readInputBudget(db);
		return `${alwaysTokens}:${alwaysScope}`;
	}

	function readInputs(db: Database): WindowInputs {
		const policyRevision = String(readSettings(db).revision);
		return {
			immediateSeq: maxImmediateSeq(db),
			stateChangeSeq: latestStateChange(db, policyRevision),
			tendencyRevision: tendencyRevision(db),
			policyRevision,
			budgetKey: budgetKeyOf(db),
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
		// Built before the profile carried its items, or drawn in another form: the next read builds it again.
		if (!parsed.profile || parsed.format !== WINDOW_FORMAT) return null;
		cache.set(conversationId, parsed);
		return parsed;
	}

	function store(db: Database, snapshot: WindowSnapshot) {
		writeWindowRow(
			db,
			snapshot.conversationId,
			{
				version: snapshot.version,
				buildId: snapshot.buildId,
				snapshot: JSON.stringify(snapshot),
			},
			clock(),
		);
		// A rolled-back transaction leaves the row behind this copy; the next read notices by buildId.
		cache.set(snapshot.conversationId, snapshot);
	}

	/**
	 * Builds the window again from State. `republish` publishes the profile anew (keeping the previous order and
	 * appending new items); otherwise the published profile stays and the changes go to `newMemories`.
	 */
	function rebuildInTransaction(
		db: Database,
		conversationId: string,
		opts: {
			republish: boolean;
			requestRepublish?: boolean;
		},
	): WindowSnapshot {
		const previous = current(db, conversationId);
		const republish = opts.republish || !previous;
		const inputs = readInputs(db);
		// The `## Memory` material: a suppressed item is not brought up.
		const { items, nextBoundaryMs } = itemsNow(
			db,
			inputs.policyRevision,
			Date.parse(clock()),
			"omit",
		);
		let shown: ProfileItem[];
		if (republish) {
			shown = publishedOrder(
				items,
				previous?.profile.items.map((item) => item.id) ?? [],
			);
		} else {
			// The published items stay as they were, except those no longer current (stopped, expired, forgotten)
			// and those at an older revision: the old text must not stand beside its new version in `newMemories`.
			const live = new Map(items.map((item) => [item.id, item.revision]));
			shown = previous!.profile.items.filter(
				(item) => live.get(item.id) === item.revision,
			);
		}
		const published = new Map(shown.map((item) => [item.id, item.revision]));
		const newMemories = items.filter(
			(item) => published.get(item.id) !== item.revision,
		);
		const snapshot: WindowSnapshot = {
			format: WINDOW_FORMAT,
			conversationId,
			version: (readWindowKey(db, conversationId)?.version ?? 0) + 1,
			buildId: id(),
			// The profile keeps the versions it was published from: a change not yet in it stays visible next time.
			inputs:
				republish || !previous
					? inputs
					: {
							...inputs,
							immediateSeq: previous.inputs.immediateSeq,
							policyRevision: previous.inputs.policyRevision,
							budgetKey: previous.inputs.budgetKey,
						},
			profile: { items: shown, tokens: profileTokens(shown) },
			newMemories,
			republishRequested: republish
				? false
				: (opts.requestRepublish ?? false) || previous!.republishRequested,
			// The published profile keeps the boundary it was built with.
			nextBoundaryMs:
				republish || !previous
					? nextBoundaryMs
					: (previous.nextBoundaryMs ?? null),
		};
		store(db, snapshot);
		return snapshot;
	}

	function boundaryCrossed(snapshot: WindowSnapshot): boolean {
		const boundary = snapshot.nextBoundaryMs ?? null;
		return boundary !== null && Date.parse(clock()) >= boundary;
	}

	/** An immediate change, a policy change or a validity boundary must reach the profile at once. */
	function mustRepublish(db: Database, snapshot: WindowSnapshot): boolean {
		const inputs = readInputs(db);
		return (
			inputs.immediateSeq !== snapshot.inputs.immediateSeq ||
			inputs.policyRevision !== snapshot.inputs.policyRevision ||
			inputs.budgetKey !== snapshot.inputs.budgetKey ||
			boundaryCrossed(snapshot)
		);
	}

	return {
		/**
		 * Which tendencies a forget in flight holds back from what the conversation reads (the exclusion is only
		 * known to the service). A held-back tendency is left out of the profile, `read_memory` and the additions.
		 */
		setWithheldTendencies(next: (db: Database) => ReadonlySet<string>) {
			withheldTendencies = next;
		},
		/** The window last stored for the conversation, as it was built; never rebuilds (a read connection may call it). */
		storedInTransaction: current,
		/**
		 * Prepare-time read (write transaction). An immediate change, a policy change or a crossed validity boundary
		 * republishes the profile now; other State changes only refresh `newMemories`.
		 */
		readForRunInTransaction(
			db: Database,
			conversationId: string,
		): WindowSnapshot {
			const snapshot = current(db, conversationId);
			if (!snapshot)
				return rebuildInTransaction(db, conversationId, { republish: true });
			if (mustRepublish(db, snapshot))
				return rebuildInTransaction(db, conversationId, { republish: true });
			const inputs = readInputs(db);
			if (
				inputs.stateChangeSeq !== snapshot.inputs.stateChangeSeq ||
				inputs.tendencyRevision !== snapshot.inputs.tendencyRevision
			)
				return rebuildInTransaction(db, conversationId, { republish: false });
			return snapshot;
		},
		rebuildInTransaction,
		/**
		 * The steward's changes to the window: a requested republish waits for the next re-construction
		 * (`republishInTransaction`) unless an immediate change requires it already.
		 */
		publishInTransaction(
			db: Database,
			conversationId: string,
			opts: { requestRepublish?: boolean },
		): WindowSnapshot {
			const previous = current(db, conversationId);
			return rebuildInTransaction(db, conversationId, {
				republish: !previous || mustRepublish(db, previous),
				...(opts.requestRepublish ? { requestRepublish: true } : {}),
			});
		},
		/** A re-construction republishes the profile: the waiting additions join it, in the order rule. */
		republishInTransaction(
			db: Database,
			conversationId: string,
		): WindowSnapshot {
			return rebuildInTransaction(db, conversationId, { republish: true });
		},
		/**
		 * Removes every stored window (all conversations) and the in-process copies. Memory text lives in them, so
		 * forgetting must not leave it behind; the next read builds again from State.
		 */
		purgeInTransaction(db: Database) {
			purgeWindows(db);
			cache.clear();
		},
		/**
		 * The current State items and tendencies as profile items (suppressed ones marked), with what each is searched
		 * by. The material of `recall`: nothing is added, strengthened or reordered by reading.
		 */
		currentItemsInTransaction(db: Database) {
			return itemsNow(
				db,
				String(readSettings(db).revision),
				Date.parse(clock()),
			);
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
