import { afterEach, expect, test } from "bun:test";
import { setup, until } from "./live.fixture";
let h: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});
const transcript = (
	speaker: "user" | "assistant",
	delta: string,
	start = 0,
	end = 100,
) => ({
	type:
		speaker === "user"
			? "session.input_transcript.delta"
			: "session.output_transcript.delta",
	delta,
	start_ms: start,
	end_ms: end,
});

test("the server sends stored model and client delegation without exposing the encrypted credential", async () => {
	h = await setup();
	const id = await h.start();
	expect(h.stopped()).toBe(1);
	expect(h.peer.sent[0]).toMatchObject({
		type: "session.start",
		session: {
			model: "fixture-voice",
			delegation: { type: "client" },
			store: false,
		},
	});
	expect(JSON.stringify(h.service.state(id))).not.toContain("fixture-secret");
	const row = h.store.read((db) =>
		db.query("SELECT encrypted FROM settings_credentials").get(),
	) as { encrypted: string };
	expect(row.encrypted).not.toContain("fixture-secret");
});
test("overlapping transcripts preserve spaces, repetition and raw deltas without publishing drafts", async () => {
	h = await setup();
	const id = await h.start();
	h.peer.event(transcript("user", "  はい、"));
	h.peer.event(transcript("assistant", "はい。", 30, 120));
	h.peer.event(transcript("user", "はい  ", 100, 180));
	await until(
		() =>
			h!.service.state(id)!.segments.length === 2 &&
			h!.service.state(id)!.segments[0]!.text === "  はい、はい  ",
	);
	expect(h.conversation.get("main").messages).toHaveLength(0);
	h.peer.event({ type: "session.closed", usage: { duration: 1 } });
	await until(() => h!.service.state(id)?.status === "closed");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"  はい、はい  ",
		"はい。",
	]);
	expect(h.service.state(id)?.usageConfirmed).toBe(true);
});
test("delegations arriving before any transcript wait; duplicate delegation ids reuse one run", async () => {
	h = await setup();
	const id = await h.start();
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "d1" },
		offset_ms: 100,
	});
	await Bun.sleep(10);
	expect(h.delegates).toHaveLength(0);
	h.peer.event(transcript("user", "予定を確認して"));
	await until(() => h!.delegates.length === 1);
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "d1" },
	});
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "d2" },
	});
	await Bun.sleep(20);
	expect(h.delegates).toHaveLength(1);
	expect(h.conversation.get("main").messages).toHaveLength(1);
	const runId = h.delegates[0]!.id;
	h.peer.event(transcript("user", "、訂正します", 101, 200));
	await until(() => h!.service.state(id)!.segments.length === 2);
	expect(() =>
		h!.store.read((db) => h!.service.delivery.assertCurrent(db, runId)),
	).toThrow("live_input_changed");
});
test("audio is ordered, a repeated sequence is not sent twice, mute sends silence and stale sequences are refused", async () => {
	h = await setup();
	const id = await h.start();
	const audio = Buffer.from([0, 0, 0, 0]).toString("base64");
	await h.service.audio(id, 1, audio);
	await h.service.audio(id, 1, audio);
	expect(
		h.peer.sent.filter((e) => e.type === "session.input_audio.append"),
	).toHaveLength(1);
	await expect(h.service.audio(id, 3, audio)).rejects.toThrow(
		"live_audio_sequence",
	);
	h.peer.event({ type: "session.input_audio.muted" });
	await until(() => h!.service.state(id)!.muted);
	await h.service.audio(id, 2, Buffer.from([1, 2, 3, 4]).toString("base64"));
	expect(h.peer.sent.at(-1)).toMatchObject({
		type: "session.input_audio.append",
		audio,
	});
});
test("test sessions never publish conversation messages or execute delegated work", async () => {
	h = await setup();
	const id = await h.start(true);
	h.peer.event(transcript("user", "テスト"));
	h.peer.event(transcript("assistant", "聞こえます"));
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "d1" },
	});
	h.peer.event({ type: "session.closed", usage: { duration: 1 } });
	await until(() => h!.service.state(id)?.status === "closed");
	expect(h.conversation.get("main").messages).toHaveLength(0);
	expect(h.delegates).toHaveLength(0);
});
test("unrelated settings keep the session; credential rotation revokes live audio and late output", async () => {
	h = await setup();
	const id = await h.start();
	let doc = h.settings.get();
	doc.general.agentName = "別名";
	doc.live.model = "";
	doc.live.voice = "次回の声";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: doc.revision,
		settings: doc,
		keys: [],
	});
	expect(h.service.state(id)?.status).toBe("active");
	doc = h.settings.get();
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: doc.revision,
		settings: doc,
		keys: [
			{ connectionId: doc.live.connectionId, value: "new-fixture-secret" },
		],
	});
	await until(() => h!.service.state(id)?.status === "interrupted");
	h.peer.event(transcript("assistant", "遅い返事"));
	expect(h.service.state(id)?.segments).toHaveLength(0);
});
test("disconnect persists received fragments and records final usage as unconfirmed", async () => {
	h = await setup();
	const id = await h.start();
	h.peer.event(transcript("user", "途中の言葉"));
	await until(() => h!.service.state(id)!.segments.length === 1);
	h.peer.close();
	await until(() => h!.service.state(id)?.status === "interrupted");
	expect(h.conversation.get("main").messages[0]?.text).toBe("途中の言葉");
	expect(h.service.state(id)?.usageConfirmed).toBe(false);
});
test("erasing a transcript erases its raw copies and invalidates the provider context", async () => {
	h = await setup();
	const id = await h.start();
	h.peer.event(transcript("user", "忘却する本文"));
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "d1" },
	});
	await until(() => h!.delegates.length === 1);
	const messageId = h.delegates[0]!.messageId;
	await h.store.write((db) => h!.service.purgeInTransaction(db, messageId));
	await until(() => h!.service.state(id)?.status === "interrupted");
	expect(
		h.store.read((db) =>
			db
				.query("SELECT delta FROM live_voice_fragments WHERE segment_id=?")
				.all(messageId),
		),
	).toEqual([{ delta: "" }]);
});

test("agency speech proposals go to Live without creating a duplicate assistant message", async () => {
	h = await setup();
	await h.start();
	await h.store.write((db) =>
		h!.service.proposeInTransaction(
			db,
			"main",
			"仕事の結果について質問します。",
		),
	);
	await until(() =>
		h!.peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	expect(h.conversation.get("main").messages).toHaveLength(0);
});

test("persistent write failure closes the provider and fences old execution; explicit start can recover after storage is restored", async () => {
	h = await setup();
	const id = await h.start();
	h.peer.event(transcript("user", "保存済みの依頼"));
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "storage" },
	});
	await until(() => h!.delegates.length === 1);
	const run = h.delegates[0]!.id;
	const write = h.store.write;
	try {
		h.store.write = (() =>
			Promise.reject(new Error("fixture_storage_unavailable"))) as typeof write;
		h.peer.event(transcript("assistant", "未保存の字幕", 200, 300));
		await until(() => h!.service.state(id)?.error === "live_storage_failed");
		expect(h.peer.readyState).toBe(3);
		expect(h.service.current("main")?.error).toBe("live_storage_failed");
		expect(() =>
			h!.store.read((db) => h!.service.delivery.assertCurrent(db, run)),
		).toThrow("live_session_inactive");
		expect(
			h.service.state(id)?.segments.some((s) => s.text.includes("未保存")),
		).toBe(false);
		await expect(h.service.audio(id, 1, "AAAAAA==")).rejects.toThrow(
			"live_session_inactive",
		);
	} finally {
		h.store.write = write;
	}
	const recovered = await h.service.start({
		requestId: crypto.randomUUID(),
		conversationId: "main",
	});
	expect(recovered.status).toBe("connecting");
	expect(recovered.id).not.toBe(id);
	expect(h.service.state(id)?.status).toBe("failed");
});
