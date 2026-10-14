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

/** What a screen shows for each character of a secret it must not echo. */
export const SECRET_MASK = "•";

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

/**
 * A structural operation staged in the draft (add or remove a connection, confirm a changed
 * origin): kept in order and sent before the field changes. Its input never holds a secret.
 */
export type StructuralEntry = {
	/** Local identity of the staged operation. */
	id: string;
	/** The adapter's registered `structure:` ref. */
	structure: string;
	input: Record<string, unknown>;
	/** The id the host made for the element this operation creates (targets of later edits). */
	created?: string;
	/** Shown in the change review. */
	label: string;
};

/** What a screen may read: confidential values are reduced to their identity. */
export type DraftView = {
	/** Increases with every change, so a stale event is recognizable. */
	version: number;
	entries: ReadonlyArray<DraftEntry>;
	/** Staged structural operations, in the order they were staged. */
	structural: ReadonlyArray<StructuralEntry>;
	/** Confidential entries by identity and length only (a screen masks them). */
	secrets: ReadonlyArray<{ fieldId: string; target?: string; length: number }>;
	/** An apply is in flight; edits made meanwhile are kept. */
	busy: boolean;
	message: string;
};

export type FrozenDraft = {
	entries: ReadonlyArray<DraftEntry>;
	structural: ReadonlyArray<StructuralEntry>;
};

export type DraftStore = ReturnType<typeof createDraftStore>;

export function createDraftStore() {
	const entries = new Map<string, DraftEntry>();
	let structural: StructuralEntry[] = [];
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
			structural: [...structural],
			secrets: all
				.filter((e) => e.confidential)
				.map(({ fieldId, target, change }) => ({
					fieldId,
					...(target ? { target } : {}),
					length: "value" in change ? String(change.value).length : 0,
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
		/**
		 * The secret held for a field, for the host to extend as the user types. It never
		 * reaches a view, a snapshot or storage.
		 */
		peekSecret(fieldId: string, target?: string): string {
			const entry = entries.get(entryKey(fieldId, target));
			return entry?.confidential && "value" in entry.change
				? String(entry.change.value)
				: "";
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
		/** Stages a structural operation after the ones already staged. */
		stage(entry: StructuralEntry) {
			structural = [...structural, entry];
			message = "";
			publish();
		},
		/** Takes a staged operation back, with the secrets and edits that targeted its new id. */
		unstage(id: string) {
			const taken = structural.find((entry) => entry.id === id);
			if (!taken) return;
			structural = structural.filter((entry) => entry.id !== id);
			const created = taken.created;
			if (created)
				for (const [key, entry] of entries)
					if (entry.target === created) entries.delete(key);
			publish();
		},
		discard() {
			if (busy) return false;
			entries.clear();
			structural = [];
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
			if (frozen.length === 0 && structural.length === 0) return null;
			busy = true;
			message = "";
			publish();
			return { entries: frozen, structural: [...structural] };
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
			if (outcome === "applied") {
				const sentIds = new Set(frozen.structural.map((entry) => entry.id));
				structural = structural.filter((entry) => !sentIds.has(entry.id));
			}
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
