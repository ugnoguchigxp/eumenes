/**
 * The shared draft of one adapter-owned document (e.g. the settings document), spec §2.3.
 * One store per (client.identity, document), shared by every artifact that shows a field of
 * that document: the workspace edits one draft, reviews it in one place and applies it as one
 * operation. Confidential values live in this memory only (§2.4): the view never carries them.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type FieldChange = { value: JsonValue } | { unset: true };

export type DraftEntry = {
	fieldId: string;
	/** The array element the field is applied to (stable id), when the field has a target. */
	target?: string;
	change: FieldChange;
	/** A secret: kept in memory, sent only through the action's confidential fields. */
	confidential?: boolean;
};

/** `fieldId` or `fieldId~target`: the id a screen shows and an edit event names. */
export const entryKey = (fieldId: string, target?: string) =>
	target ? `${fieldId}~${target}` : fieldId;
export function splitEntryKey(key: string): {
	fieldId: string;
	target?: string;
} {
	const at = key.indexOf("~");
	return at < 0
		? { fieldId: key }
		: { fieldId: key.slice(0, at), target: key.slice(at + 1) };
}

export const sameChange = (a: FieldChange, b: FieldChange) =>
	JSON.stringify(a) === JSON.stringify(b);

/** What a screen may read: confidential values are reduced to their identity. */
export type DraftView = {
	/** Increases with every change, so a stale event is recognizable. */
	version: number;
	entries: ReadonlyArray<DraftEntry>;
	/** Confidential entries by identity only. */
	secrets: ReadonlyArray<{ fieldId: string; target?: string }>;
	/** An apply is in flight; edits made meanwhile are kept. */
	busy: boolean;
	message: string;
};

export type FrozenDraft = { entries: ReadonlyArray<DraftEntry> };

export type DraftStore = ReturnType<typeof createDraftStore>;

export function createDraftStore() {
	const entries = new Map<string, DraftEntry>();
	let version = 0;
	let busy = false;
	let message = "";
	const listeners = new Set<() => void>();
	let view: DraftView = build();
	function build(): DraftView {
		const all = [...entries.values()];
		return {
			version,
			entries: all.filter((e) => !e.confidential),
			secrets: all
				.filter((e) => e.confidential)
				.map(({ fieldId, target }) => ({
					fieldId,
					...(target ? { target } : {}),
				})),
			busy,
			message,
		};
	}
	function publish() {
		version++;
		view = build();
		for (const listener of listeners) listener();
	}
	return {
		getView: () => view,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Adds or replaces the entry of this field (and target). */
		set(entry: DraftEntry) {
			entries.set(entryKey(entry.fieldId, entry.target), entry);
			message = "";
			publish();
		},
		remove(fieldId: string, target?: string) {
			if (entries.delete(entryKey(fieldId, target))) publish();
		},
		/** Drops entries (e.g. ones equal to the saved value) without touching the message. */
		prune(keep: (entry: DraftEntry) => boolean) {
			let changed = false;
			for (const [key, entry] of entries)
				if (!keep(entry)) {
					entries.delete(key);
					changed = true;
				}
			if (changed) publish();
		},
		discard() {
			if (busy) return false;
			entries.clear();
			message = "";
			publish();
			return true;
		},
		setMessage(text: string) {
			if (message === text) return;
			message = text;
			publish();
		},
		/**
		 * Freezes the entries to send. Edits made while saving go on in the same store and stay
		 * after the apply settles. Null when there is nothing to send or an apply is running.
		 */
		freeze(include: (entry: DraftEntry) => boolean): FrozenDraft | null {
			if (busy) return null;
			const frozen = [...entries.values()].filter(include);
			if (frozen.length === 0) return null;
			busy = true;
			message = "";
			publish();
			return { entries: frozen };
		},
		/**
		 * The apply is over. `applied` removes exactly what was sent (an entry edited meanwhile
		 * is a different change and stays); `kept` leaves the draft whole, as after a conflict.
		 * `dropSecrets` also forgets the confidential values sent, which cannot be resent.
		 */
		settle(
			frozen: FrozenDraft,
			outcome: "applied" | "kept",
			options: { dropSecrets?: boolean } = {},
		) {
			busy = false;
			for (const sent of frozen.entries) {
				const key = entryKey(sent.fieldId, sent.target);
				const current = entries.get(key);
				if (!current) continue;
				if (
					(outcome === "applied" && sameChange(current.change, sent.change)) ||
					(options.dropSecrets && sent.confidential && current === sent)
				)
					entries.delete(key);
			}
			publish();
		},
	};
}

const stores = new Map<string, DraftStore>();
/** The one draft of a document in this workspace, per API identity. */
export function draftStoreFor(identity: string, document: string): DraftStore {
	const key = `${identity}|${document}`;
	let store = stores.get(key);
	if (!store) {
		store = createDraftStore();
		stores.set(key, store);
	}
	return store;
}
