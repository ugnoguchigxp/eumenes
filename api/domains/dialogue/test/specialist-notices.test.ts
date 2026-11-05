import { afterEach, expect, test } from "bun:test";
import { setup, type Harness } from "./specialist.fixture";

const opened: Harness[] = [];
afterEach(async () => {
	for (const h of opened.splice(0)) await h.close();
});

test("a persisted observation resumes the same specialist without adding a user message or granting a tool", async () => {
	const h = await setup();
	opened.push(h);
	h.handOver({ request: "利用者と作業する" });
	h.state.specialist.push({ action: "reply", text: "作業を始めました。" });
	const original = await h.ask("利用者と作業する");
	const session = h.session()!;
	const users = h.store
		.read((db) => h.conversation.messagesInTransaction(db, "main"))
		.filter((message) => message.role === "user").length;
	const input = {
		sessionId: session.id,
		epoch: session.epoch,
		sourceRunId: original.id,
		eventId: "host-event-1",
		event: {
			id: "child",
			status: "waiting_user",
			revision: 2,
			question: { id: "q1", prompt: "どちらにしますか。" },
		},
	};
	expect(
		h.store.read((db) =>
			h.dialogue.executionSourceInTransaction(db, original.id),
		),
	).toBeNull();
	expect(
		h.store.read((db) =>
			h.dialogue.specialistExecutionSourceInTransaction(db, original.id),
		),
	).toMatchObject({
		specialistSessionId: session.id,
		specialistEpoch: session.epoch,
	});
	h.state.specialist.push({ action: "reply", text: "どちらにしますか。" });
	expect(await h.dialogue.notifySpecialist(input)).toBe(true);
	await h.until(
		() =>
			h.state.specialistPrompts.length === 2 &&
			h.session()?.activeRunId === null,
	);
	expect(
		await h.store.write((db) =>
			h.dialogue.notifySpecialistInTransaction(db, input),
		),
	).toBe(true);
	expect(h.state.specialistPrompts).toHaveLength(2);
	expect(
		h.store
			.read((db) => h.conversation.messagesInTransaction(db, "main"))
			.filter((message) => message.role === "user"),
	).toHaveLength(users);
	const prompt = h.state.specialistPrompts[1]!;
	expect(prompt.at(-1)?.content).toStartWith("HOST_EVENT_NOTICE");
	expect(prompt.at(-1)?.content).toContain("利用者の新しい発言はありません");
	expect(prompt.at(-1)?.content).not.toBe("利用者と作業する");
	expect(prompt[1]!.content).toContain('"hostEvent"');
	const schema = JSON.parse(prompt[0]!.content.split("\nOUTPUT_SCHEMA=")[1]!);
	expect(schema.properties.action.enum).toEqual(["reply"]);
	expect(prompt[0]!.content).toContain("TOOLS=[]");
	expect(
		await h.store.write((db) =>
			h.dialogue.notifySpecialistInTransaction(db, {
				...input,
				eventId: "old",
				epoch: session.epoch + 1,
			}),
		),
	).toBe(false);
	await h.store.write((db) =>
		h.dialogue.forgetSpecialistObservationsInTransaction(db, session.id),
	);
	expect(
		h.store.read((db) =>
			db
				.query("SELECT count(*) AS n FROM dialogue_specialist_observations")
				.get(),
		),
	).toEqual({ n: 0 });
	await expect(h.dialogue.notifySpecialist(input)).rejects.toThrow(
		"request_conflict",
	);
});

test("an observation cannot discard or invoke even when the model ignores its reply-only schema", async () => {
	const h = await setup();
	opened.push(h);
	h.handOver({ request: "下書きを作る" });
	h.state.specialist.push({ action: "reply", text: "下書きを検討します。" });
	const original = await h.ask("下書きを作る");
	const session = h.session()!;
	h.state.specialist.push(
		{ action: "discard" },
		{ action: "reply", text: "確認の回答をお願いします。" },
	);
	await h.dialogue.notifySpecialist({
		sessionId: session.id,
		epoch: session.epoch,
		sourceRunId: original.id,
		eventId: "restricted",
		event: { id: "child", status: "waiting_user", revision: 1 },
	});
	await h.until(
		() =>
			h.state.specialistPrompts.length === 3 &&
			h.session()?.activeRunId === null,
	);
	expect(h.session()?.state).toBe("active");
	expect(h.state.specialistPrompts[2]!.at(-1)!.content).toContain(
		"host_event_reply_only",
	);
});
