import { afterEach, expect, test } from "bun:test";
import { setup, until } from "./live.fixture";
let h: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});
test("a settled task retains its delegation after later input, is sent once, and a closed session receives nothing", async () => {
	h = await setup();
	const sessionId = await h.start();
	h.peer.event({
		type: "session.input_transcript.delta",
		delta: "資料を調べて",
		start_ms: 0,
		end_ms: 100,
	});
	h.peer.event({
		type: "session.delegation.created",
		delegation: { id: "original-task" },
	});
	await until(() => h!.delegates.length === 1);
	const runId = h.delegates[0]!.id;
	h.peer.event({
		type: "session.input_transcript.delta",
		delta: "追加の補足です",
		start_ms: 200,
		end_ms: 300,
	});
	await until(() =>
		h!.service
			.state(sessionId)!
			.segments.map((s) => s.text)
			.join("")
			.includes("補足"),
	);
	const input = {
		id: "work:fixture:2",
		runId,
		conversationId: "main",
		text: "確認済みの結果と出典です。",
	};
	await h.store.write((db) => {
		h!.service.delivery.report(db, input);
		h!.service.delivery.report(db, input);
	});
	await until(() =>
		h!.peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	expect(
		h.peer.sent.filter((e) => e.type === "session.commentary.append"),
	).toEqual([
		expect.objectContaining({
			delegation_id: "original-task",
			content: input.text,
		}),
	]);
	expect(h.service.state(sessionId)!.notices).toHaveLength(1);
	await h.service.stop(sessionId);
	expect(
		await h.store.write((db) =>
			h!.service.delivery.report(db, { ...input, id: "late" }),
		),
	).toBe(false);
});
