import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { WebNoteDeps } from "./context";
import { noteSources, today } from "./note";
import policy from "./policy.json";

const log = getLogger("web-note");
const DEADLINE_MS = 55_000;

export function createConversationLookup(
	deps: Pick<WebNoteDeps, "turn" | "record">,
) {
	const { turn, record } = deps;
	if (!turn) return undefined;
	return async (query: string, parent: AbortSignal) => {
		const signal = AbortSignal.any([parent, AbortSignal.timeout(DEADLINE_MS)]);
		const started = Date.now();
		const subject = `lookup:${crypto.randomUUID()}`;
		let usage: Awaited<ReturnType<typeof turn>>["usage"] = null;
		let reason: string | null = null;
		try {
			const instruction = systemContext("web-note.contexts.lookup", {
				today: today(started),
			});
			const result = await turn({
				model: policy.model,
				reasoning: "low",
				webSearch: "live",
				prompt: `${instruction}\n\n検索条件:\n${JSON.stringify(query)}`,
				signal,
			});
			usage = result.usage;
			signal.throwIfAborted();
			if (result.searches < 1) throw new Error("lookup_no_search");
			const text = result.text.trim();
			if (!text || Buffer.byteLength(text) > policy.outputMaxBytes)
				throw new Error("lookup_output_invalid");
			const sources = noteSources(text, new Date().toISOString());
			if (!sources.length) throw new Error("lookup_no_sources");
			log.info("web_note.conversation_lookup", {
				count: result.searches,
				hitCount: sources.length,
				durationMs: Date.now() - started,
			});
			return {
				text,
				sources: sources.map(({ url, title }) => ({ url, title })),
			};
		} catch (error) {
			reason = signal.aborted
				? "lookup_cancelled"
				: error instanceof Error && /^lookup_[a-z_]+$/.test(error.message)
					? error.message
					: "lookup_failed";
			log.warn("web_note.conversation_lookup_failed", {
				reason,
				durationMs: Date.now() - started,
			});
			parent.throwIfAborted();
			throw new Error(reason);
		} finally {
			await record?.({
				subject,
				model: policy.model,
				started,
				ended: Date.now(),
				status: reason ? "failed" : "succeeded",
				reason,
				usage,
			}).catch(() => {});
		}
	};
}
