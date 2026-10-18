import { afterEach, expect, test } from "bun:test";
import { OTHER_REVISION, setup, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function harness(options: Parameters<typeof setup>[0] = {}) {
	const h = await setup(options);
	open.push(h);
	return h;
}

const reply = (text: string) => ({ action: "reply", text });
const invoke = (title: string) => ({
	action: "invoke",
	tool: "draft.apply",
	arguments: { title },
});
const ret = (forward: boolean, text?: string) => ({
	action: "return",
	forward,
	...(text ? { text } : {}),
});

/** The main model hands "request" to the studio toolchain and the specialist drafts, then answers. */
async function startDirty(
	h: Harness,
	request = "アンケートを作って",
	title = "アンケート",
) {
	h.startCall({ request });
	h.state.specialist.push(invoke(title), reply("作りました"));
	return h.ask(request);
}

test("a session starts from the conversation's choice, then talks directly: three round trips, no main model call", async () => {
	const h = await harness();
	const first = await startDirty(h);
	expect(first.status).toBe("completed");
	expect(first.specialistSessionId).not.toBeNull();
	const started = (await h.session())!;
	expect(started).toMatchObject({
		state: "active",
		toolchainId: "fake.studio",
		epoch: 1,
		dirty: true,
		busy: false,
		activeRunId: null,
		label: "アンケート",
	});
	// The handed-over request reached the specialist, and the operation ran for this turn.
	expect(h.state.specialistPrompts[0]!.at(-1)!.content).toContain(
		"アンケートを作って",
	);
	expect(h.state.invocations).toHaveLength(1);
	expect(h.state.invocations[0]).toMatchObject({
		operationName: "fake.draft.apply",
		input: { title: "アンケート" },
		sessionId: started.id,
		runId: first.id,
		conversationId: "main",
	});
	// The operation's result is the next model input of the same turn.
	expect(h.state.specialistPrompts[1]!.at(-1)!.content).toContain(
		'TOOL_RESULT={"ok":true,"result":{"applied":true',
	);
	// The analysis and the selection: two model calls before the session.
	const mainCalls = h.state.mainCalls.length;
	expect(h.state.analysisCalls).toHaveLength(1);
	expect(mainCalls).toBe(1);
	for (const [i, text] of [
		"第1問を直して",
		"色を変えて",
		"ありがとう",
	].entries()) {
		h.state.specialist.push(reply(`返答${i + 1}`));
		const run = await h.ask(text);
		expect(run.status).toBe("completed");
		expect(run.specialistSessionId).toBe(started.id);
		expect(h.conversation.message(run.answerMessageId!)!.text).toBe(
			`返答${i + 1}`,
		);
	}
	// The conversation model was never called again, and every specialist call used the session's agent session.
	expect(h.state.mainCalls).toHaveLength(mainCalls);
	expect(
		h.state.specialistSessions.every((s) => (s as any).taskId === started.id),
	).toBe(true);
	// The specialist sees its own earlier exchanges.
	const last = h.state.specialistPrompts.at(-1)!;
	expect(last.map((m) => m.content).join("\n")).toContain("返答2");
	// The call's inference is rooted in the turn's run.
	expect(h.state.captures.at(-1)).toMatchObject({
		policySubject: expect.any(String),
		maxOutputTokens: 24_576,
	});
	expect((await h.session())!.activeRunId).toBeNull();
	expect(h.work()[0]!.holder).toBeNull();
});

test("specialist dialogue is blocked from memory and learned from nowhere", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(reply("返答"));
	const run = await h.ask("もう少し");
	const blocked = new Set(h.blocked());
	expect(blocked.has(run.inputMessageId)).toBe(true);
	expect(blocked.has(run.answerMessageId!)).toBe(true);
	const reasons = h
		.rows("SELECT DISTINCT reason FROM memory_message_block")
		.map((row) => row.reason);
	expect(reasons).toEqual(["specialist_dialogue"]);
	// No exchange of the ledger, whatever the way the turns ended.
	expect(h.memory!.exchanges("main")).toEqual([]);
});

test("returning: unsaved work is suspended and the main agent takes over with a short record", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "会話担当へ戻ります"));
	const back = await h.ask("会話に戻って");
	expect(back.status).toBe("completed");
	expect(await h.session()).toMatchObject({ state: "suspended", dirty: true });
	expect(h.work()[0]!.ended).toBe(false);
	// The next utterance is the main agent's, with the record of the suspended work and none of the dialogue.
	h.state.main.push("天気は晴れです");
	const asked = await h.ask("今日の天気は？");
	expect(asked.specialistSessionId).toBeNull();
	const prompt = h.state.mainCalls
		.at(-1)!
		.history.map((m) => m.content)
		.join("\n");
	expect(prompt).toContain("specialistWork=");
	expect(prompt).toContain('"unsaved":true');
	for (const hidden of [
		"アンケートを作って",
		"作りました",
		"会話担当へ戻ります",
	])
		expect(prompt).not.toContain(hidden);
	// The ordinary exchange is learned from as usual.
	expect(h.memory!.exchanges("main")).toHaveLength(1);
});

test("returning a clean work ends the session once and records the end for the main agent once", async () => {
	const h = await harness();
	h.startCall({ request: "相談したい" });
	h.state.specialist.push(reply("どんな内容ですか"));
	await h.ask("相談したい");
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("やっぱり戻って");
	expect(await h.session()).toBeNull();
	expect(h.state.calls).toContain("end:close");
	expect(h.state.released).toHaveLength(1);
	h.state.main.push("はい", "はい");
	await h.ask("こんにちは");
	expect(
		h.state.mainCalls
			.at(-1)!
			.history.map((m) => m.content)
			.join("\n"),
	).toContain('"ended":{"specialist":"制作担当","reason":"returned"');
	await h.ask("もう一度");
	expect(
		h.state.mainCalls
			.at(-1)!
			.history.map((m) => m.content)
			.join("\n"),
	).not.toContain("specialistWork=");
});

test("a request outside the specialist's scope is forwarded to the main agent once and becomes an ordinary message", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(true));
	// The first call of a decision with tools only selects; the second is the answer.
	h.state.main.push("明日は雨です");
	const requestId = crypto.randomUUID();
	const run = await h.dialogue.submit({
		requestId,
		conversationId: "main",
		text: "明日の天気を教えて",
	});
	await h.finished(run.id);
	const done = h.dialogue.get(run.id)!;
	expect(done.status).toBe("completed");
	expect(h.conversation.message(done.answerMessageId!)!.text).toBe(
		"明日は雨です",
	);
	// The run is the conversation's again; its message is no longer kept from memory.
	expect(done.specialistSessionId).toBeNull();
	expect(h.blocked()).not.toContain(done.inputMessageId);
	expect(h.blocked()).not.toContain(done.answerMessageId!);
	const prompt = h.state.mainCalls
		.at(-1)!
		.history.map((m) => m.content)
		.join("\n");
	expect(prompt).toContain("specialistHandoff=");
	expect(prompt).toContain('"work":"suspended"');
	// Tools are still offered: the forwarded request can go to any toolchain.
	expect(
		h.state.mainCalls.slice(-2).some((call) => call.tools.length > 0),
	).toBe(true);
	expect((await h.session())!.state).toBe("suspended");
	// Sending the same request again returns the same run and does not deliver it twice.
	const calls = h.state.mainCalls.length;
	const again = await h.dialogue.submit({
		requestId,
		conversationId: "main",
		text: "明日の天気を教えて",
	});
	expect(again.id).toBe(run.id);
	expect(h.state.mainCalls).toHaveLength(calls);
	// The delivered message is part of the conversation's history afterwards.
	h.state.main.push("はい");
	await h.ask("ありがとう");
	const history = h.state.mainCalls.at(-1)!.history.map((m) => m.content);
	expect(history).toContain("明日の天気を教えて");
	expect(history).toContain("明日は雨です");
	expect(history).not.toContain("作りました");
});

test("a label longer than the old payload limit still reaches the main agent in a handoff and in a switch confirmation", async () => {
	const h = await harness();
	const title = "長い題名".repeat(300);
	await startDirty(h, "アンケートを作って", title);
	// Forwarded to the main agent: the handoff record carries the whole label in the queue payload.
	h.state.specialist.push(ret(true));
	h.state.main.push("明日は雨です");
	const forwarded = await h.ask("明日の天気を教えて");
	expect(forwarded.status).toBe("completed");
	const handoff = h.state.mainCalls
		.at(-1)!
		.history.map((m) => m.content)
		.join("\n");
	expect(handoff).toContain("specialistHandoff=");
	expect(handoff).toContain(title);
	// A switch while that work stands: the confirmation note carries the label too.
	h.startCall({ request: "別のものを作って" }, "other_create");
	h.state.main.push("未保存の作業があります。破棄しますか？");
	const asked = await h.ask("別のものを作って");
	expect(asked.status).toBe("completed");
	expect(
		h.state.mainCalls
			.at(-1)!
			.history.map((m) => m.content)
			.join("\n"),
	).toContain(title);
});

test("a discard ends the session, drops the work and returns the conversation", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push({ action: "discard", text: "破棄しました" });
	const run = await h.ask("全部捨てて");
	expect(run.status).toBe("completed");
	expect(await h.session()).toBeNull();
	expect(h.state.calls).toContain("end:discard");
	expect(h.work()[0]!.ended).toBe(true);
});

test("a switch to another toolchain while unsaved work stands waits for the user's decision", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("会話に戻って");
	const suspended = (await h.session())!;
	// The conversation chooses another session toolchain: nothing is switched, the main agent asks.
	h.startCall({ request: "別のものを作って" }, "other_create");
	h.state.main.push("未保存の作業があります。破棄しますか？");
	const asked = await h.ask("別のものを作って");
	expect(asked.status).toBe("completed");
	const waiting = (await h.session())!;
	expect(waiting.id).toBe(suspended.id);
	expect(waiting.pendingSwitch).toMatchObject({
		toolchainId: "fake.other",
		targetRef: null,
		workRevision: h.work()[0]!.revision,
	});
	expect(h.work()).toHaveLength(1);
	const note = h.state.mainCalls
		.at(-1)!
		.history.map((m) => m.content)
		.join("\n");
	expect(note).toContain('"commandQuestion"');
	// A changed work needs a new decision: the old confirmation does not discard the new draft.
	h.work()[0]!.revision += 1;
	h.startCall(
		{ request: "別のものを作って", resolveUnsaved: "discard" },
		"other_create",
	);
	h.state.main.push("もう一度確認します");
	await h.ask("破棄していいよ");
	expect((await h.session())!.id).toBe(suspended.id);
	expect((await h.session())!.pendingSwitch!.workRevision).toBe(
		h.work()[0]!.revision,
	);
	expect(h.work()[0]!.ended).toBe(false);
	// With the current revision confirmed the old work is dropped and the new specialist starts.
	h.startCall(
		{ request: "別のものを作って", resolveUnsaved: "discard" },
		"other_create",
	);
	h.state.specialist.push(reply("別の担当です"));
	const switched = await h.ask("はい破棄して");
	expect(switched.status).toBe("completed");
	const now = (await h.session())!;
	expect(now.id).not.toBe(suspended.id);
	expect(now.toolchainId).toBe("fake.other");
	expect(h.work()[0]!.ended).toBe(true);
	expect(h.state.calls).toContain("end:discard");
	expect(h.state.released).toContain(suspended.id);
	expect(OTHER_REVISION).toBe(now.toolchainRevisionId);
});

test("the same target resumes the suspended work instead of starting another", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("会話に戻って");
	const suspended = (await h.session())!;
	h.startCall({ request: "続きをやって" });
	h.state.specialist.push(reply("続けます"));
	await h.ask("続きをやって");
	const resumed = (await h.session())!;
	expect(resumed).toMatchObject({
		id: suspended.id,
		state: "active",
		epoch: 2,
	});
	expect(h.work()).toHaveLength(1);
	expect(h.state.calls.filter((c) => c === "open")).toHaveLength(1);
});

test("a target the host did not issue is refused before anything starts", async () => {
	const h = await harness();
	h.startCall({ request: "直して", target: "item-9" });
	h.startCall({ request: "直して", target: "item-9" });
	const run = await h.ask("直して");
	expect(run.status).toBe("failed");
	expect(run.error).toBe("invalid_conversation_operation");
	expect(h.work()).toHaveLength(0);
	expect(await h.session()).toBeNull();
});

test("a saved item starts the session from it, and the screen's viewing is shown only when issued", async () => {
	const h = await harness();
	h.state.main.push("見ています");
	await h.ask("これは何？", {
		viewing: {
			artifactRevisionId: "artifact:fake.studio@1",
			targetRef: "item-1",
		},
	});
	const shown = h.state.mainCalls
		.at(-1)!
		.history.map((m) => m.content)
		.join("\n");
	expect(shown).toContain("viewing=");
	expect(shown).toContain('"ref":"item-1"');
	h.state.main.push("見えません");
	await h.ask("あれは？", {
		viewing: {
			artifactRevisionId: "artifact:fake.studio@1",
			targetRef: "item-9",
		},
	});
	expect(
		h.state.mainCalls
			.at(-1)!
			.history.map((m) => m.content)
			.join("\n"),
	).not.toContain("viewing=");
	h.startCall({ request: "これを直して", target: "item-1" });
	h.state.specialist.push(reply("開きました"));
	await h.ask("これを直して");
	// The tool offers exactly the issued items as the target.
	const tool = h.state.mainCalls
		.flatMap((call) => call.tools)
		.find((t) => t.function.name === "studio_create")!;
	expect((tool.function.parameters.properties as any).target.enum).toEqual([
		"item-1",
		"item-2",
	]);

	expect(await h.session()).toMatchObject({ label: "保存済み item-1" });
	expect(h.work()[0]!.savedRef).toBe("item-1");
});
