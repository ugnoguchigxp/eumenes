import { afterEach, expect, test } from "bun:test";
import {
	OTHER,
	approve,
	choice,
	OTHER_REVISION,
	STUDIO,
	STUDIO_ARTIFACT,
	setup,
	type Harness,
} from "./specialist.fixture";
import { forgetWork } from "../repository/work";

/**
 * A session toolchain takes the conversation over (the ContextWindow specification, section 6.8): the conversation
 * model hands over with `delegate` (`execute`, optionally with `target` and `resolveUnsaved`); from then on the
 * utterances go to the specialist directly until it leaves.
 */
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
	h.handOver({ request });
	h.state.specialist.push(invoke(title), reply("作りました"));
	return h.ask(request);
}
/** The reference record of the main model's nth call's `<now>`, by source. */
/** The `## State` line of the nth conversation call that starts with `head`. */
const stateLine = (h: Harness, call: number, head: string) =>
	h.stateOf(call).find((line) => line.startsWith(head));

test("a session starts from the conversation's delegate, then talks directly: no conversation model call for the utterances after it", async () => {
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
	// The conversation model is not called again for the utterances after it.
	const modelCalls = h.state.calls.length;
	for (const [i, text] of [
		"第1問を直して",
		"色を変えて",
		"ありがとう",
	].entries()) {
		h.state.specialist.push(reply(`返答${i + 1}`));
		const run = await h.ask(text);
		expect(run.status).toBe("completed");
		expect(run.specialistSessionId).toBe(started.id);
		expect(h.answerText(run.id)).toBe(`返答${i + 1}`);
	}
	expect(h.state.calls).toHaveLength(modelCalls);
	// Every specialist call used the session's agent session, and sees its own earlier exchanges.
	expect(
		h.state.specialistSessions.every((s) => (s as any).taskId === started.id),
	).toBe(true);
	expect(
		h.state.specialistPrompts
			.at(-1)!
			.map((m) => m.content)
			.join("\n"),
	).toContain("返答2");
	expect(h.state.captures.at(-1)).toMatchObject({
		policySubject: expect.any(String),
		maxOutputTokens: 24_576,
	});
	expect((await h.session())!.activeRunId).toBeNull();
	expect(h.work()[0]!.holder).toBeNull();
});

test("a hand-over to a session toolchain ends the generation: the model is called for the one choice only (the host searches itself)", async () => {
	const h = await harness();
	await startDirty(h);
	expect(h.state.calls).toHaveLength(1);
	expect(h.state.calls[0]!.session?.outputSchema).toBeDefined();
});

test("an utterance handed to the specialist is logged as said by the user, to the specialist, and is not pending for the conversation agent", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(reply("返答"));
	await h.ask("第1問を直して");
	const said = h
		.log()
		.filter((e) => e.type === "said" && e.by === "user")
		.map((e) => h.fields(e));
	expect(said).toContainEqual(
		expect.objectContaining({ text: "第1問を直して", to: "specialist" }),
	);
	// Handed over at once: nothing of it waits for a generation of the conversation agent.
	const pending = h.store.read((db) =>
		h.continuity.events.pendingInTransaction(db, "main"),
	);
	expect(pending).toEqual([]);
});

test("the specialist's reply is logged as said by the specialist, with the toolchain's id (6.8)", async () => {
	const h = await harness();
	await startDirty(h);
	const said = h
		.log()
		.filter((e) => e.type === "said" && e.by === "specialist");
	expect(said.map((e) => h.fields(e))).toEqual([
		expect.objectContaining({ text: "作りました", toolchain: "fake.studio" }),
	]);
});

test("specialist dialogue is blocked from memory, and the specialist's turns tell the steward nothing", async () => {
	const h = await harness();
	const first = await startDirty(h);
	h.state.specialist.push(reply("返答"));
	const run = await h.ask("もう少し");
	const blocked = new Set(h.blocked());
	expect(blocked.has(run.inputMessageId)).toBe(true);
	expect(blocked.has(run.answerMessageId!)).toBe(true);
	expect(blocked.has(first.inputMessageId)).toBe(true);
	const reasons = h
		.rows("SELECT DISTINCT reason FROM memory_message_block")
		.map((row) => row.reason);
	expect(reasons).toEqual(["specialist_dialogue"]);
	// A session's turn is not learned from; an ordinary run is.
	expect(h.state.runEnds.map((e) => e.runId)).not.toContain(run.id);
	expect(h.state.runEnds.map((e) => e.runId)).not.toContain(first.id);
});

test("returning: unsaved work is suspended and the conversation agent takes over with a short record of it", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "会話担当へ戻ります"));
	const back = await h.ask("会話に戻って");
	expect(back.status).toBe("completed");
	expect(await h.session()).toMatchObject({ state: "suspended", dirty: true });
	expect(h.work()[0]!.ended).toBe(false);
	// The next utterance is the conversation agent's, with the record of the suspended work.
	h.talk("天気は晴れです");
	const asked = await h.ask("今日の天気は？");
	expect(asked.specialistSessionId).toBeNull();
	expect(asked.status).toBe("completed");
	// The conversation shows its own hand-over; the words said to the specialist are the specialist's, not its.
	const talkCall = h.state.calls.length - 1;
	expect(h.inputOf(talkCall)).toContain("「制作担当」に頼みます。");
	expect(h.inputOf(talkCall)).not.toContain("会話に戻って");
});

test("returning a clean work ends the session once and tells the conversation agent once", async () => {
	const h = await harness();
	h.handOver({ request: "相談したい" });
	h.state.specialist.push(reply("どんな内容ですか"));
	await h.ask("相談したい");
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("やっぱり戻って");
	expect(await h.session()).toBeNull();
	expect(h.state.calledPort).toContain("end:close");
	expect(h.state.released).toHaveLength(1);
	h.talk("はい");
	const next = await h.ask("こんにちは");
	expect(next.specialistSessionId).toBeNull();
	expect(h.answerText(next.id)).toBe("はい");
});

test("a request outside the specialist's scope is forwarded to the conversation agent once, as its own utterance", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(true));
	h.talk("明日は雨です");
	const requestId = crypto.randomUUID();
	const run = await h.dialogue.submit({
		requestId,
		conversationId: "main",
		text: "明日の天気を教えて",
	});
	await h.finished(run.id);
	const done = h.dialogue.get(run.id)!;
	expect(done.status).toBe("completed");
	expect(h.answerText(run.id)).toBe("明日は雨です");
	// The run is the conversation's again; its message is no longer kept from memory.
	expect(done.specialistSessionId).toBeNull();
	expect(h.blocked()).not.toContain(done.inputMessageId);
	expect(h.userOf(h.state.calls.length - 1)).toBe("明日の天気を教えて");
	expect((await h.session())!.state).toBe("suspended");
	// Sending the same request again returns the same run and does not deliver it twice.
	const calls = h.state.calls.length;
	const again = await h.dialogue.submit({
		requestId,
		conversationId: "main",
		text: "明日の天気を教えて",
	});
	expect(again.id).toBe(run.id);
	expect(h.state.calls).toHaveLength(calls);
});

test("a discard ends the session, drops the work and returns the conversation", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push({ action: "discard", text: "破棄しました" });
	const run = await h.ask("全部捨てて");
	expect(run.status).toBe("completed");
	expect(await h.session()).toBeNull();
	expect(h.state.calledPort).toContain("end:discard");
	expect(h.work()[0]!.ended).toBe(true);
});

test("a hand-over to another toolchain while unsaved work stands waits for the user's decision, and the conversation agent asks", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("会話に戻って");
	const suspended = (await h.session())!;
	// The conversation chooses another session toolchain: nothing is switched, the conversation agent asks.
	h.handOver({ request: "別のものを作って" }, OTHER.id);
	h.state.steps.push({
		text: "未保存の作業があります。破棄しますか？",
	});
	const asked = await h.ask("別のものを作って");
	expect(asked.status).toBe("completed");
	expect(h.answerText(asked.id)).toBe("未保存の作業があります。破棄しますか？");
	const waiting = (await h.session())!;
	expect(waiting.id).toBe(suspended.id);
	expect(waiting.pendingSwitch).toMatchObject({
		toolchainId: "fake.other",
		targetRef: null,
		workRevision: h.work()[0]!.revision,
	});
	expect(h.work()).toHaveLength(1);
	// The talk that asks is told what is at stake: the unsaved work's label.
	expect(
		h.state.calls
			.at(-1)!
			.messages.map((m) => m.content)
			.join("\n"),
	).toContain("アンケート");
	// A changed work needs a new decision: the word given for the old revision discards nothing.
	h.work()[0]!.revision += 1;
	// The answer's words find no toolchain: the one the switch waits for is offered all the same.
	h.state.found = [];
	h.handOver(
		{ request: "別のものを作って", resolveUnsaved: "discard" },
		OTHER.id,
	);
	h.state.steps.push({ text: "もう一度確認します" });
	await h.ask("破棄していいよ");
	// The word that the unsaved work may go is the host's own candidate, offered beside the router's search.
	expect(h.state.routerAsked.at(-1)!.criteria.map((c) => c.name)).toContain(
		"switch.discard",
	);
	expect((await h.session())!.id).toBe(suspended.id);
	expect((await h.session())!.pendingSwitch!.workRevision).toBe(
		h.work()[0]!.revision,
	);
	expect(h.work()[0]!.ended).toBe(false);
	expect(h.state.calledPort).not.toContain("end:discard");
	// With the current revision let go, the old work is dropped and the new specialist starts.
	h.handOver(
		{ request: "別のものを作って", resolveUnsaved: "discard" },
		OTHER.id,
	);
	h.state.specialist.push(reply("別の担当です"));
	const switched = await h.ask("はい破棄して");
	expect(switched.status).toBe("completed");
	const now = (await h.session())!;
	expect(now.id).not.toBe(suspended.id);
	expect(now.toolchainId).toBe("fake.other");
	expect(now.toolchainRevisionId).toBe(OTHER_REVISION);
	expect(h.work()[0]!.ended).toBe(true);
	expect(h.state.calledPort).toContain("end:discard");
	expect(h.state.released).toContain(suspended.id);
});

test("the same target resumes the suspended work instead of starting another", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("会話に戻って");
	const suspended = (await h.session())!;
	h.handOver({ request: "続きをやって" });
	h.state.specialist.push(reply("続けます"));
	await h.ask("続きをやって");
	const resumed = (await h.session())!;
	expect(resumed).toMatchObject({
		id: suspended.id,
		state: "active",
		epoch: 2,
	});
	expect(h.work()).toHaveLength(1);
	expect(h.state.calledPort.filter((c) => c === "open")).toHaveLength(1);
});

test("a target the host did not issue is refused before anything starts", async () => {
	const h = await harness();
	h.handOver({ request: "直して", target: "item-9" });
	h.talk("開けませんでした");
	const run = await h.ask("直して");
	expect(h.work()).toHaveLength(0);
	expect(await h.session()).toBeNull();
	expect(run.specialistSessionId).toBeNull();
	expect(h.state.specialistPrompts).toHaveLength(0);
});

test("a saved item starts the session from it; the fill offers exactly the issued items, and the screen's viewing is shown when issued", async () => {
	const h = await harness();
	h.handOver({ request: "これを直して", target: "item-1" });
	await h.ask("これを直して", {
		viewing: { artifactRevisionId: STUDIO_ARTIFACT, targetRef: "item-1" },
	});
	// The fill of the toolchain the router decided reads the item on screen and lists the studio's issued items.
	const fill = h.lastChoice();
	expect(stateLine(h, fill, "- 制作担当「")).toMatch(
		/（画面に表示中、target item-1）$/,
	);
	const found = h.state.calls[fill]!.messages.at(-1)!.content.split("\n");
	const line = found.find((l) => l.startsWith(`- ${STUDIO.id}: `))!;
	expect([...line.matchAll(/(item-\d)「/g)].map((m) => m[1])).toEqual([
		"item-1",
		"item-2",
	]);
	// Changing a saved item is confirmed first; the approval starts the session from it.
	expect(await h.session()).toBeNull();
	h.state.steps.push(approve());
	h.state.specialist.push(reply("開きました"));
	await h.ask("お願い");
	expect(await h.session()).toMatchObject({ label: "保存済み item-1" });
	expect(h.work()[0]!.savedRef).toBe("item-1");
});

test("an item on screen the host did not issue is not shown", async () => {
	const h = await harness();
	h.handOver({ request: "これを直して", target: "item-1" });
	await h.ask("これを直して", {
		viewing: { artifactRevisionId: STUDIO_ARTIFACT, targetRef: "item-9" },
	});
	expect(stateLine(h, h.lastChoice(), "- 制作担当「")).toBeUndefined();
});

test("a change of a saved item is confirmed naming the item, and the approval opens that same item", async () => {
	const h = await harness();
	h.state.steps.push(
		choice({
			choice: STUDIO.id,
			say: "直します。",
			request: "見出しを直す",
			target: "item-2",
		}),
	);
	const asked = await h.ask("保存済み2の見出しを直して");
	expect(h.answerText(asked.id)).toBe(
		"制作担当に、保存済み2について「保存済み2の見出しを直して」を頼みます。今あるものを変えます。よろしいですか？",
	);
	expect(await h.session()).toBeNull();
	h.state.steps.push(approve());
	h.state.specialist.push(reply("開きました"));
	await h.ask("お願い");
	// The router was offered the yes to the confirmation, naming its item.
	expect(
		h.state.routerAsked.at(-1)!.criteria.find((c) => c.name === "c1.approve")!
			.description,
	).toContain("保存済み2");
	expect(await h.session()).toMatchObject({ label: "保存済み item-2" });
	expect(h.work()[0]!.savedRef).toBe("item-2");
});

test("a request to make something new is handed to the specialist at once, on a new work", async () => {
	const h = await harness();
	h.state.steps.push(
		choice({
			choice: STUDIO.id,
			say: "作りますね。",
			request: "イヤホンのランディングページを作る",
			target: "new",
		}),
	);
	h.state.specialist.push(reply("どんな雰囲気にしますか。"));
	await h.ask("イヤホンのランディングページを作りたいです");
	expect(h.rows("SELECT id FROM dialogue_confirmations")).toEqual([]);
	expect(await h.session()).toMatchObject({ label: "新規" });
	expect(h.work()[0]!.savedRef).toBeNull();
	expect(h.state.specialistPrompts).toHaveLength(1);
});

/** The routed turn's choice that asks to change `target` in the studio (confirmed first). */
const confirmOn = (target: string) =>
	choice({
		choice: STUDIO.id,
		say: "直します。",
		request: "見出しを直す",
		target,
	});

test("a confirmation keeps its target: the same request on two items stays two confirmations, and the approved one opens its item", async () => {
	const h = await harness();
	h.state.steps.push(confirmOn("item-1"));
	await h.ask("保存済み1の見出しを直して");
	// The second request comes while the first is open: the router decides the studio again, which confirms.
	h.state.steps.push(confirmOn("item-2"));
	await h.ask("保存済み2も直して");
	expect(
		h.rows(
			"SELECT ref, target, superseded_at AS superseded FROM dialogue_confirmations ORDER BY ref",
		),
	).toEqual([
		{ ref: 1, target: "item-1", superseded: null },
		{ ref: 2, target: "item-2", superseded: null },
	]);
	h.state.steps.push(approve(2));
	h.state.specialist.push(reply("開きました"));
	await h.ask("2つ目をお願い");
	// The open confirmations name their items: the router tells the two apart.
	const offered = h.state.routerAsked.at(-1)!.criteria;
	expect(offered.find((c) => c.name === "c1.approve")!.description).toContain(
		"保存済み1",
	);
	expect(offered.find((c) => c.name === "c2.approve")!.description).toContain(
		"保存済み2",
	);
	expect(await h.session()).toMatchObject({ label: "保存済み item-2" });
	expect(h.work()[0]!.savedRef).toBe("item-2");
});

test("an item that is gone is refused when confirmed, and a confirmation whose item went since is closed before anything is announced", async () => {
	const h = await harness();
	// A fill that names an item the host never issued is refused: nothing is confirmed, the host says it could not.
	h.state.steps.push(confirmOn("item-9"));
	const refused = await h.ask("見出しを直して");
	expect(h.answerText(refused.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(h.rows("SELECT ref FROM dialogue_confirmations")).toEqual([]);
	h.state.steps.push(confirmOn("item-2"));
	await h.ask("保存済み2の見出しを直して");
	expect(
		h.rows(
			"SELECT ref, target, target_label AS label FROM dialogue_confirmations",
		),
	).toEqual([{ ref: 1, target: "item-2", label: "保存済み2" }]);
	h.state.gone.add("item-2");
	h.state.steps.push(approve());
	const approved = await h.ask("お願い");
	// Nothing is announced: the host says it could not ask for it.
	expect(h.answerText(approved.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	expect(approved.announcement ?? null).toBeNull();
	expect(
		h.rows(
			"SELECT superseded_at IS NOT NULL AS closed, used_at FROM dialogue_confirmations",
		),
	).toEqual([{ closed: 1, used_at: null }]);
	expect(await h.session()).toBeNull();
	expect(h.work()).toHaveLength(0);
	expect(h.state.specialistPrompts).toHaveLength(0);
});

test("forgetting the words a confirmation came from clears its target with its request", async () => {
	const h = await harness();
	h.state.steps.push(confirmOn("item-1"));
	await h.ask("見出しを直して");
	const [row] = h.rows(
		"SELECT message_ids_json AS ids FROM dialogue_confirmations",
	);
	await h.store.write((db) =>
		forgetWork(db, JSON.parse(row.ids), "2026-10-30T12:00:00.000Z"),
	);
	expect(
		h.rows(
			"SELECT request, target, target_label AS label, resolve_unsaved AS resolve FROM dialogue_confirmations",
		),
	).toEqual([{ request: "", target: null, label: null, resolve: null }]);
});
