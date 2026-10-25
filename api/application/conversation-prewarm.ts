import type { Database } from "bun:sqlite";
import type { NativeTool } from "../infrastructure/chat-stream";
import { getLogger } from "../infrastructure/logger";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { InferenceService } from "../domains/inference";

const log = getLogger("dialogue");

/** In front of LARM's prompt keeping (5 minutes idle by default): a shown conversation is read again before it lapses. */
export const PREWARM_IDLE_MS = 4 * 60 * 1000;
const PREWARM_DEADLINE_MS = 120_000;
/** The fixed last message of a prewarm: it reads the prefix and asks for nothing. */
const PREWARM_TAIL =
	'<task name="prewarm">\n資料を読むだけです。何も出力しません。\n</task>';

type Prefix = {
	messages: Array<{ role: "system" | "user"; content: string }>;
	tools: NativeTool[];
};

/**
 * The cold-start prewarm (the ContextWindow layout specification, section 8.3): the latest conversation's prefix
 * is read on its connection by a one-token call, so its first answer does not wait for it. It runs when the
 * conversation screen is shown and when the screen has stayed shown for `PREWARM_IDLE_MS` without a call; after the
 * conversation's own calls (and the background work on its prompt) nothing is needed. The call yields to the
 * conversation and its output is discarded; the conversation and its log are never touched.
 */
export function createConversationPrewarm(deps: {
	store: SqliteStore;
	inference: Pick<
		InferenceService,
		| "captureMaintenanceControlInTransaction"
		| "executeControl"
		| "rejectControlInTransaction"
		| "screenPresent"
		| "onScreenShown"
		| "onActivity"
	>;
	latestConversationIdInTransaction(db: Database): string | null;
	prefix(db: Database, conversationId: string): Prefix | null;
}) {
	const { store, inference } = deps;
	let running = false;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function prewarm(reason: "shown" | "idle" | "started") {
		if (running || closed) return;
		running = true;
		try {
			const prepared = store.read((db) => {
				const conversationId = deps.latestConversationIdInTransaction(db);
				return conversationId ? deps.prefix(db, conversationId) : null;
			});
			if (!prepared) return;
			const requestId = await store.write((db) =>
				inference.captureMaintenanceControlInTransaction(db, {
					subject: `background:prewarm:${Date.now()}`,
					deadline: Date.now() + PREWARM_DEADLINE_MS,
					maxOutputTokens: 1,
				}),
			);
			const started = Date.now();
			const receipt = await inference.executeControl(
				requestId,
				[...prepared.messages, { role: "user", content: PREWARM_TAIL }],
				AbortSignal.timeout(PREWARM_DEADLINE_MS),
				{ instructions: "", outputSchema: { type: "object" } },
				{
					sessionRole: "auxiliary",
					onConversation: true,
					prefixTools: prepared.tools,
					toolChoice: "none",
				},
			);
			await store
				.write((db) =>
					inference.rejectControlInTransaction(db, receipt, "prewarm"),
				)
				.catch(() => undefined);
			log.info("dialogue.prewarm", {
				reason,
				durationMs: Date.now() - started,
			});
		} catch (error) {
			// A prewarm is an aid: the conversation reads its prompt itself when it does not happen.
			log.info("dialogue.prewarm_skipped", {
				reason:
					error instanceof Error && /^[a-z_]+$/.test(error.message)
						? error.message
						: "failed",
			});
		} finally {
			running = false;
			schedule();
		}
	}

	/** The idle timer starts again after every call: a shown screen is read again before LARM lets it go. */
	function schedule() {
		clearTimeout(timer);
		if (closed) return;
		timer = setTimeout(() => {
			if (inference.screenPresent()) void prewarm("idle");
		}, PREWARM_IDLE_MS);
		timer.unref?.();
	}

	const unsubscribe = [
		inference.onScreenShown(() => void prewarm("shown")),
		inference.onActivity(() => {
			if (!running) schedule();
		}),
	];
	return {
		/** After the server started: the connection is new, so the latest conversation is read once. */
		start: () => void prewarm("started"),
		close() {
			closed = true;
			clearTimeout(timer);
			for (const stop of unsubscribe) stop();
		},
	};
}
