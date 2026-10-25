import { afterEach, expect, test } from "bun:test";
import { createContinuityService } from "../../domains/continuity";
import { createDotsMessages } from "./dots-messages";
import { dotsFixture } from "./dots-fixture";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0)) await f();
});
async function setup() {
	let at = Date.now();
	const f = await dotsFixture(() => at);
	clean.push(f.close);
	const continuity = createContinuityService(f.store),
		messages = createDotsMessages({
			store: f.store,
			conversation: f.conversation,
			continuity,
			commands: f.dots.commands,
			events: f.events,
			now: () => at,
		});
	await messages.configure("dots", { enabled: true, expectedRevision: 0 });
	await f.events.subscribe("dots", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 4).toString("base64"),
		},
	});
	const thread = await messages.open({
		requestId: crypto.randomUUID(),
		connectionRef: "dots",
		conversationId: "message-chat",
	});
	async function send(text = "依頼文") {
		return messages.send(thread.id, { requestId: crypto.randomUUID(), text });
	}
	async function answer(id: string) {
		const view = messages.view(thread.id).items.find((x) => x.id === id)!;
		const command = messages.getCommand("dots", view.commandId);
		const leaseId = crypto.randomUUID();
		await messages.claim("dots", { commandId: command.commandId, leaseId });
		return {
			replyId: crypto.randomUUID(),
			messageId: id,
			commandId: command.commandId,
			leaseId,
			epoch: command.authorityEpoch,
			outcome: "answered" as const,
			replyText: "返答です",
			summary: "今回の要約です",
			coveredMessageIds: [String(command.snapshot.sourceMessageId)],
			limitations: [],
		};
	}
	return {
		...f,
		messages,
		thread,
		continuity,
		send,
		answer,
		advance: (ms: number) => {
			at += ms;
		},
	};
}
test("messages need no task, project or session; replies and summaries save once with external attribution", async () => {
	const f = await setup();
	await f.store.write((db) => db.query("DELETE FROM dots_projects").run());
	const request = { requestId: crypto.randomUUID(), text: "相談です" };
	const a = await f.messages.send(f.thread.id, request),
		again = await f.messages.send(f.thread.id, request);
	expect(again.id).toBe(a.id);
	expect(f.messages.getCommand("dots", a.commandId).taskId).toBeUndefined();
	await expect(
		f.messages.send(f.thread.id, { ...request, text: "違う内容" }),
	).rejects.toThrow("dots_conflict");
	const r = await f.answer(a.id),
		receipt = await f.messages.reply("dots", r);
	expect(
		await f.messages.reply(
			"dots",
			Object.fromEntries(Object.entries(r).reverse()),
		),
	).toEqual(receipt);
	const view = f.messages.view(f.thread.id);
	expect(view.items[0]?.reply?.summary).toBe(r.summary);
	expect(view.setting.verifiedAt).not.toBeNull();
	const saved = f.store.readSnapshot((db) =>
		f.conversation.messageInTransaction(db, receipt.replyMessageId),
	);
	expect(saved?.message.attribution?.namespace).toBe("dots");
	expect(
		f.store
			.readSnapshot((db) =>
				f.continuity.events.logInTransaction(db, "message-chat"),
			)
			.map((x) => x.by),
	).toEqual(["user", "specialist", "specialist"]);
	const b = await f.send("続きをお願いします"),
		c = f.messages.getCommand("dots", b.commandId);
	expect(c.snapshot.context).toMatchObject({
		previousSummary: r.summary,
		basedOnReplyId: r.replyId,
	});
});
test("wrong owner, lease, coverage, duplicate final reply and cancelled generations are rejected", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	expect(() => f.messages.getCommand("other", a.commandId)).toThrow(
		"dots_permission_denied",
	);
	await expect(
		f.messages.reply("dots", { ...r, leaseId: crypto.randomUUID() }),
	).rejects.toThrow("dots_stale");
	for (const id of ["foreign-message", a.id]) {
		await expect(
			f.messages.reply("dots", { ...r, coveredMessageIds: [id] }),
		).rejects.toThrow("dots_permission_denied");
		expect(f.messages.view(f.thread.id).items[0]?.reply).toBeNull();
	}
	await f.messages.reply("dots", r);
	await expect(
		f.messages.reply("dots", { ...r, replyId: crypto.randomUUID() }),
	).rejects.toThrow("dots_stale");
	const b = await f.send(),
		later = await f.answer(b.id),
		m = f.messages.view(f.thread.id).items.find((x) => x.id === b.id)!;
	await f.messages.cancel(b.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: m.revision,
	});
	await expect(f.messages.reply("dots", later)).rejects.toThrow("dots_stale");
});
test("message disable preserves task settings and rejects pending replies; receipt replay survives redaction", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	const receipt = await f.messages.reply("dots", r);
	const rev = f.connection.connection.revision;
	await f.messages.configure("dots", { expectedRevision: 1, enabled: false });
	expect(
		f.dots.config.list().connections.find((x) => x.id === "dots")?.revision,
	).toBe(rev);
	await f.conversation.retract({ messageId: receipt.replyMessageId });
	expect(f.messages.view(f.thread.id).items[0]?.reply?.replyText).toBeNull();
	expect(await f.messages.reply("dots", r)).toEqual(receipt);
});
test("expiry and retention remove all derived text, preserve bounded receipts, then reclaim records", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	await f.messages.reply("dots", r);
	f.advance(7 * 86400000 + 1);
	await f.messages.maintenance();
	expect(f.messages.view(f.thread.id).items[0]?.text).toBeNull();
	expect(f.messages.view(f.thread.id).items[0]?.reply?.summary).toBeNull();
	expect(await f.messages.reply("dots", r)).toMatchObject({ messageId: a.id });
	f.advance(23 * 86400000);
	await f.messages.maintenance();
	expect(f.messages.view(f.thread.id).items).toHaveLength(0);
});

test("reply adoption rolls back together with conversation persistence and can be retried", async () => {
	const f = await setup(),
		m = await f.send(),
		r = await f.answer(m.id);
	const failing = createDotsMessages({
		store: f.store,
		conversation: {
			...f.conversation,
			appendInTransaction() {
				throw new Error("fixture_write_failure");
			},
		},
		continuity: f.continuity,
		commands: f.dots.commands,
		events: f.events,
	});
	await expect(failing.reply("dots", r)).rejects.toThrow(
		"fixture_write_failure",
	);
	expect(f.messages.view(f.thread.id).items[0]?.reply).toBeNull();
	expect(f.messages.getCommand("dots", m.commandId).state).toBe("claimed");
	expect(await f.messages.reply("dots", r)).toMatchObject({
		state: "answered",
	});
});
test("durable command and receipt survive service recreation without creating another message", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	const restored = createDotsMessages({
		store: f.store,
		conversation: f.conversation,
		continuity: f.continuity,
		commands: f.dots.commands,
		events: f.events,
	});
	expect(restored.getCommand("dots", a.commandId).leaseId).toBe(r.leaseId);
	const receipt = await restored.reply("dots", r);
	expect(await f.messages.reply("dots", r)).toEqual(receipt);
	expect(restored.view(f.thread.id).items).toHaveLength(1);
	expect(
		restored.getCommand("dots", a.commandId).snapshot.text,
	).toBeUndefined();
});
test("expired and unsubscribed sends are rejected, but subscription loss does not revoke an existing claim", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	await f.events.unsubscribe("dots", "https://receiver.example/callback");
	expect(await f.messages.reply("dots", r)).toMatchObject({
		state: "answered",
	});
	await expect(f.send()).rejects.toThrow("dots_not_subscribed");
	await f.events.subscribe("dots", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 4).toString("base64"),
		},
	});
	const b = await f.send(),
		later = await f.answer(b.id);
	f.advance(600001);
	await expect(f.messages.reply("dots", later)).rejects.toThrow("dots_stale");
	await f.messages.maintenance();
	expect(f.messages.view(f.thread.id).items[1]?.state).toBe("expired");
});
test("source deletion removes descendant snapshots and summaries without reviving them on replay", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id),
		receipt = await f.messages.reply("dots", r),
		b = await f.send();
	await f.conversation.retract({ messageId: a.userMessageId });
	const view = f.messages.view(f.thread.id);
	expect(view.items.every((m) => m.redacted)).toBe(true);
	expect(view.items[1]?.state).toBe("cancelled");
	expect(view.items[0]?.reply?.summary).toBeNull();
	expect(
		f.store
			.readSnapshot((db) =>
				f.continuity.events.logInTransaction(db, "message-chat"),
			)
			.every((e) => e.forgotten),
	).toBe(true);
	expect(() => f.messages.getCommand("dots", b.commandId)).toThrow(
		"dots_stale",
	);
	expect(await f.messages.reply("dots", r)).toEqual(receipt);
	expect(
		f.messages.getCommand("dots", a.commandId).snapshot,
	).not.toHaveProperty("context");
});
test("normal storage accounts for conversation bodies, enforces the stop reserve and reclaims bytes", async () => {
	const f = await setup();
	const bytes = () =>
		f.store.readSnapshot(
			(db) =>
				(
					db.query("SELECT bytes FROM dots_storage WHERE id=1").get() as {
						bytes: number;
					}
				).bytes,
		);
	const a = await f.send("利用者の本文"),
		r = await f.answer(a.id),
		before = bytes();
	await f.store.write((db) =>
		db.query("UPDATE dots_storage SET bytes=? WHERE id=1").run(58720256 - 10),
	);
	await expect(f.messages.reply("dots", r)).rejects.toThrow("dots_capacity");
	expect(f.messages.view(f.thread.id).items[0]?.reply).toBeNull();
	await f.store.write((db) =>
		db.query("UPDATE dots_storage SET bytes=? WHERE id=1").run(before),
	);
	const receipt = await f.messages.reply("dots", r);
	expect(bytes() - before).toBeGreaterThan(
		Buffer.byteLength(r.replyText + r.summary),
	);
	const full = bytes();
	await f.conversation.retract({ messageId: receipt.replyMessageId });
	expect(bytes()).toBeLessThan(full);
});
test("pagination stays stable across a new arrival, and external attribution reaches history and dialogue projection", async () => {
	const f = await setup();
	for (let i = 0; i < 3; i++) {
		const m = await f.send(`本文${i}`);
		await f.messages.reply("dots", await f.answer(m.id));
	}
	const first = f.messages.view(f.thread.id, 0, 2);
	expect(first.nextCursor).toBe(2);
	await f.send("次の本文");
	expect(
		f.messages
			.view(f.thread.id, first.nextCursor!, 2)
			.items.map((m) => m.sequence),
	).toEqual([3, 4]);
	const owner = {
		key: "fixture",
		conversationId: "message-chat",
		deadline: Date.now() + 60000,
	};
	const history = f.store.readSnapshot((db) =>
		f.conversation.historySearchInTransaction(db, owner, {
			query: "返答です",
			limit: 10,
		}),
	);
	expect(
		history.candidates.every(
			(m) => m.attribution?.displayName === "dots の返答",
		),
	).toBe(true);
	expect(history.candidates).toHaveLength(3);
});

test("disable and connection revision fences reject a claimed reply, and another conversation receives no summary", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	await f.messages.configure("dots", { expectedRevision: 1, enabled: false });
	await expect(f.messages.reply("dots", r)).rejects.toThrow("dots_stale");
	await f.messages.configure("dots", { expectedRevision: 2, enabled: true });
	const b = await f.send(),
		later = await f.answer(b.id);
	const { revision, ...connection } = f.connection.connection;
	await f.dots.config.configure({
		...connection,
		expectedRevision: revision,
		title: "更新した接続",
	});
	await expect(f.messages.reply("dots", later)).rejects.toThrow("dots_stale");
	await f.messages.maintenance();
	const other = await f.messages.open({
		requestId: crypto.randomUUID(),
		connectionRef: "dots",
		conversationId: "other-chat",
	});
	const next = await f.messages.send(other.id, {
		requestId: crypto.randomUUID(),
		text: "別の会話",
	});
	expect(
		f.messages.getCommand("dots", next.commandId).snapshot.context,
	).toMatchObject({
		previousSummary: null,
		exchanges: [],
		coveredMessageIds: [],
	});
});
test("an unsummarized failed exchange is carried after the last accepted summary", async () => {
	const f = await setup(),
		a = await f.send(),
		r = await f.answer(a.id);
	await f.messages.reply("dots", r);
	const b = await f.send("未解決の相談"),
		failed = await f.answer(b.id);
	await f.messages.reply("dots", {
		...failed,
		outcome: "failed",
		summary: null,
		replyText: "情報が不足しています",
	});
	const c = await f.send("不足した情報です"),
		context = f.messages.getCommand("dots", c.commandId).snapshot.context;
	expect(context).toMatchObject({
		previousSummary: r.summary,
		exchanges: [
			{
				messageId: b.userMessageId,
				text: "未解決の相談",
				replyText: "情報が不足しています",
				state: "failed",
			},
		],
	});
});
