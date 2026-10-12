import { createHash } from "node:crypto";
import { SpeechLanguageError } from "../../delivery";
import {
	sentenceLanguageDecisionSchema,
	type SentenceLanguageDecision,
} from "../../larm";

type Entry = {
	controller: AbortController;
	promise: Promise<SentenceLanguageDecision>;
	users: number;
	done: boolean;
	expires: number;
};

/** Bounded backend-only memo; subscribers own cancellation, not the first caller. */
export function createSpeechLanguageCache(maxEntries = 64, ttlMs = 600_000) {
	const entries = new Map<string, Entry>();
	const drop = (key: string, entry: Entry) => {
		if (entries.get(key) === entry) entries.delete(key);
		if (!entry.done) entry.controller.abort();
	};
	return {
		clear() {
			for (const [key, entry] of entries) drop(key, entry);
		},
		async select(
			identity: string,
			text: string,
			signal: AbortSignal,
			classify: (signal: AbortSignal) => Promise<unknown>,
		) {
			signal.throwIfAborted();
			if (!text.trim() || text.length > 65536)
				throw new SpeechLanguageError("speech_language_invalid");
			const key = createHash("sha256")
				.update(identity)
				.update("\0")
				.update(text)
				.digest("hex");
			for (const [oldKey, entry] of entries)
				if (entry.expires <= Date.now() && !entry.users) drop(oldKey, entry);
			let entry = entries.get(key);
			if (!entry) {
				if (entries.size >= maxEntries) {
					const victim = [...entries].find(
						([, value]) => value.done && !value.users,
					);
					if (!victim)
						throw new SpeechLanguageError("speech_language_capacity");
					drop(...victim);
				}
				const controller = new AbortController();
				const next: Entry = {
					controller,
					promise: Promise.resolve(undefined as never),
					users: 0,
					done: false,
					expires: Date.now() + ttlMs,
				};
				next.promise = Promise.resolve()
					.then(() => classify(controller.signal))
					.then((raw) => {
						controller.signal.throwIfAborted();
						const parsed = sentenceLanguageDecisionSchema.safeParse(raw);
						if (!parsed.success)
							throw new SpeechLanguageError("speech_language_invalid");
						next.done = true;
						next.expires = Date.now() + ttlMs;
						return parsed.data;
					})
					.catch((error) => {
						drop(key, next);
						throw error;
					});
				entries.set(key, next);
				entry = next;
			}
			entry.users++;
			let abort = () => {};
			try {
				const value = await Promise.race([
					entry.promise,
					new Promise<never>((_, reject) => {
						abort = () => reject(signal.reason);
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) abort();
					}),
				]);
				signal.throwIfAborted();
				return value;
			} finally {
				signal.removeEventListener("abort", abort);
				entry.users--;
				if (!entry.done && !entry.users) drop(key, entry);
			}
		},
	};
}
