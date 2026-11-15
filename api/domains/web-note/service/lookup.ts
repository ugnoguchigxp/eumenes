import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { WebNoteDeps } from "./context";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities } from "../../capabilities";
import { toErrorCode } from "../../../infrastructure/error-code";
import { noteSources, today } from "./note";
import policy from "./policy.json";

const log = getLogger("web-note");
const DEADLINE_MS = 55_000;
const SOURCE_DEADLINE_MS = 150_000;

export function createConversationSourceLookup(
	deps: Pick<WebNoteDeps, "inspectSource" | "record">,
	store: SqliteStore,
	capabilities: Capabilities,
) {
	const { inspectSource, record } = deps;
	if (!inspectSource) return undefined;
	return async (query: string, parent: AbortSignal) => {
		const started = Date.now();
		const signal = AbortSignal.any([
			parent,
			AbortSignal.timeout(SOURCE_DEADLINE_MS),
		]);
		let usage: import("../contracts").WebNoteAttempt["usage"] = null;
		let reason: string | null = null;
		try {
			const instructions = store.read((db) => {
				const active = capabilities
					.toolchainsInTransaction(db)
					.find(({ id }) => id === "inspect.source");
				if (!active) throw new Error("inspect_source_unavailable");
				const set = capabilities.toolchainSetInTransaction(
					db,
					active.revisionId,
				);
				return [set.profile, ...set.skills].join("\n");
			});
			const commit = await inspectSource.resolveCommit(signal);
			const inspection = await inspectSource.inspect({
				commit,
				prompt: `${instructions}\n\n依頼:\n${query}`,
				signal,
			});
			usage = inspection.usage;
			signal.throwIfAborted();
			return {
				text: inspection.result.summary,
				displayText: inspection.result.displayAnswer,
			};
		} catch (error) {
			const code = toErrorCode(error, "");
			reason = code.startsWith("inspect_source_")
				? code
				: "inspect_source_turn_interrupted";
			parent.throwIfAborted();
			const text = "今回は表示できる抜粋がありません。";
			return { text, displayText: `**一部抜粋**\n\n${text}` };
		} finally {
			await record?.({
				subject: `inspect-source:${crypto.randomUUID()}`,
				model: null,
				started,
				ended: Date.now(),
				status: reason ? "failed" : "succeeded",
				reason,
				usage,
			}).catch(() => {});
		}
	};
}

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
