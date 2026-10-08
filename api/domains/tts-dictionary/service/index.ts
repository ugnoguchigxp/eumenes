import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DeleteInput, Entry, SaveInput } from "../contracts";
import { list, lookup, remove, upsert } from "../repository";
import { compile } from "./matcher";
export function createTtsDictionary(store: SqliteStore) {
	let apply: ((text: string) => string) | null = null;
	return {
		list: () => store.read(list),
		/** Replaces registered written forms with their readings for one speech request. */
		apply(text: string) {
			apply ??= compile(store.read(list));
			return apply(text);
		},
		save: (input: SaveInput): Promise<Entry[]> =>
			store.write((db) => {
				const { original, entry, expected } = input;
				const previous = original === null ? null : lookup(db, original);
				// An identical retry must not touch updated_at.
				if (original === entry.written && previous === entry.spoken)
					return list(db);
				if (previous !== expected.spoken) throw new Error("revision_conflict");
				if (original !== entry.written && lookup(db, entry.written) !== null)
					throw new Error("revision_conflict");
				if (original !== null && original !== entry.written)
					remove(db, original);
				upsert(db, entry, Date.now());
				apply = null;
				return list(db);
			}),
		delete: (input: DeleteInput): Promise<Entry[]> =>
			store.write((db) => {
				const previous = lookup(db, input.written);
				if (previous === null) return list(db);
				if (previous !== input.expected.spoken)
					throw new Error("revision_conflict");
				remove(db, input.written);
				apply = null;
				return list(db);
			}),
	};
}
export type TtsDictionaryService = ReturnType<typeof createTtsDictionary>;
