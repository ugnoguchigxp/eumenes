import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../infrastructure/sqlite";
import { createConversationPrewarm } from "./conversation-prewarm";

function harness(latest: string | null) {
	const shown = new Set<() => void>();
	const calls: Array<{ messages: unknown; session: unknown; subject: string }> =
		[];
	const rejected: string[] = [];
	let subject = "";
	const store = {
		read: (fn: (db: Database) => unknown) => fn({} as Database),
		write: async (fn: (db: Database) => unknown) => fn({} as Database),
	} as unknown as SqliteStore;
	const prefix = {
		messages: [
			{ role: "system" as const, content: "会話の指示" },
			{ role: "user" as const, content: "## Memory\n- なし" },
		],
		tools: [],
	};
	const prewarm = createConversationPrewarm({
		store,
		inference: {
			captureMaintenanceControlInTransaction: (
				_db: Database,
				input: { subject: string; maxOutputTokens: number },
			) => {
				subject = input.subject;
				expect(input.maxOutputTokens).toBe(1);
				return "req-1";
			},
			executeControl: async (
				_id: string,
				messages: unknown,
				_signal: AbortSignal,
				_control: unknown,
				session: unknown,
			) => {
				calls.push({ messages, session, subject });
				return { requestId: "req-1", attemptId: "att-1", value: "{}" };
			},
			rejectControlInTransaction: (
				_db: Database,
				_receipt: unknown,
				code: string,
			) => {
				rejected.push(code);
			},
			screenPresent: () => true,
			onScreenShown: (listener: () => void) => {
				shown.add(listener);
				return () => shown.delete(listener);
			},
			onActivity: () => () => {},
		} as unknown as Parameters<
			typeof createConversationPrewarm
		>[0]["inference"],
		latestConversationIdInTransaction: () => latest,
		task: (_db, conversationId, task) =>
			conversationId === "main"
				? {
						messages: [...prefix.messages, { role: "user", content: task }],
						tools: prefix.tools,
					}
				: null,
	});
	return { prewarm, calls, rejected, shown, prefix };
}

test("the latest conversation's prefix is read by a one-token background call on its connection, and the answer is dropped", async () => {
	const h = harness("main");
	try {
		h.prewarm.start();
		await Bun.sleep(0);
		expect(h.calls).toHaveLength(1);
		const [call] = h.calls;
		expect((call!.messages as unknown[]).slice(0, 2)).toEqual(
			h.prefix.messages,
		);
		expect(call!.session).toMatchObject({
			sessionRole: "auxiliary",
			onConversation: true,
			toolChoice: "none",
		});
		// A background subject: it never counts as the user's foreground work.
		expect(call!.subject).toStartWith("background:prewarm:");
		expect(h.rejected).toEqual(["prewarm"]);
		// Showing the conversation screen reads it again.
		for (const listener of h.shown) listener();
		await Bun.sleep(0);
		expect(h.calls).toHaveLength(2);
	} finally {
		h.prewarm.close();
	}
});

test("without a conversation there is nothing to read", async () => {
	const h = harness(null);
	try {
		h.prewarm.start();
		await Bun.sleep(0);
		expect(h.calls).toEqual([]);
	} finally {
		h.prewarm.close();
	}
});
