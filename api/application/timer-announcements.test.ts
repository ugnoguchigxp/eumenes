import { expect, test } from "bun:test";
import { conversationSchema } from "../domains/conversation/contracts";
import { harness } from "./toolchain.fixture";
import { createTimerAnnouncements } from "./timer-announcements";
import { createConversationService } from "../domains/conversation";

test("a three-minute tool request posts one assistant completion at the deadline and survives recovery", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const h = await harness({ timers: true, timerNow: () => now });
	const messages = async () =>
		conversationSchema.parse(
			await (await h.request("/api/conversations/main")).json(),
		).messages;
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		now = startedAt + 179999;
		await h.scheduler.tick();
		expect(
			(await messages()).some((message) =>
				message.text.includes("終了しました"),
			),
		).toBe(false);
		now = startedAt + 180000;
		await h.scheduler.tick();
		for (let i = 0; i < 40 && !h.timers!.notifications().items.length; i++) {
			await h.queue.tick();
			await Bun.sleep(25);
		}
		const completions = (await messages()).filter(
			(message) => message.text === "3分のタイマーが終了しました。",
		);
		expect(completions).toHaveLength(1);
		expect(completions[0]?.role).toBe("assistant");
		expect(h.timers!.list().items[0]?.state).toBe("elapsed");
		expect(h.timers!.notifications().items[0]?.message).toBe(
			completions[0]?.text,
		);
		await h.timers!.recover();
		await h.scheduler.tick();
		await h.queue.tick();
		expect(
			(await messages()).filter(
				(message) => message.text === completions[0]?.text,
			),
		).toHaveLength(1);
	} finally {
		await h.close();
	}
});

test("cancelling before the deadline creates neither an assistant completion nor an audible notice", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const h = await harness({ timers: true, timerNow: () => now });
	try {
		const receipt = (
			await h.timers!.start(
				{
					requestId: crypto.randomUUID(),
					issuedAt: new Date(now).toISOString(),
					durationSeconds: 180,
				},
				{ conversationId: "main" },
			)
		).receipt;
		if (receipt.action !== "started") throw new Error("expected_start");
		await h.timers!.cancel(receipt.timer.id, {
			requestId: crypto.randomUUID(),
			issuedAt: new Date(now).toISOString(),
			expectedRevision: receipt.timer.revision,
		});
		now += 180000;
		await h.scheduler.tick();
		await h.queue.tick();
		expect(h.timers!.notifications().items).toHaveLength(0);
		const conversation = conversationSchema.parse(
			await (await h.request("/api/conversations/main")).json(),
		);
		expect(conversation.messages).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("the announcement participates in the caller transaction and replays without a duplicate", async () => {
	const h = await harness({ timers: true });
	try {
		const conversation = createConversationService(h.store, {
			requireOutbox: true,
		});
		const announce = createTimerAnnouncements(conversation);
		const event = {
			notificationId: crypto.randomUUID(),
			timerId: crypto.randomUUID(),
			conversationId: "main",
			message: "3分のタイマーが終了しました。",
			at: new Date().toISOString(),
		};
		await expect(
			h.store.write((tx) => {
				announce(tx, event);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(conversation.get("main").messages).toHaveLength(0);
		await h.store.write((tx) => {
			announce(tx, event);
			announce(tx, event);
		});
		expect(conversation.get("main").messages).toHaveLength(1);
		await h.store.write((tx) =>
			announce(tx, { ...event, conversationId: null }),
		);
		expect(conversation.get("main").messages).toHaveLength(1);
	} finally {
		await h.close();
	}
});
