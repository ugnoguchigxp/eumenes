import { afterEach, expect, test } from "bun:test";
import {
	IMAGE,
	INSTANT,
	respond,
	setup,
	type Harness,
} from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("an utterance is answered with respond: the said events, a full delivery and the answer trace", async () => {
	h = await setup();
	h.state.steps.push({ text: "こんにちは。", calls: [respond()] });
	const run = await h.say("やあ");
	expect(h.dialogue.answerText(run.id)).toBe("こんにちは。");
	const call = h.state.calls[0]!;
	expect(call.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
	expect(call.messages[2]!.content).toBe("やあ");
	expect(JSON.parse(call.messages[1]!.content)).toHaveProperty("now");
	expect(call.tools).toEqual([
		"memory",
		"find_toolchain",
		"delegate",
		"work",
		"respond",
	]);
	const log = h.log();
	expect(log.map((e) => [e.type, e.by])).toEqual([
		["said", "user"],
		["said", "agent"],
		["delivered", "host"],
	]);
	expect(h.fields(log[2]!)).toMatchObject({ ref: log[1]!.id, heard: "full" });
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "answer",
		analysis: { kind: "chat", next: "answer" },
	});
});

test("an utterance answered without respond is repaired once, then fails", async () => {
	h = await setup();
	h.state.steps.push(
		{ text: "はい。" },
		{ text: "はい。", calls: [respond()] },
	);
	const ok = await h.say("ねえ");
	expect(h.dialogue.answerText(ok.id)).toBe("はい。");
	const repaired = h.state.calls[1]!.messages;
	expect(repaired.at(-2)!.content).toStartWith("UNTRUSTED_REJECTED_OUTPUT=");
	expect(repaired.at(-1)!.content).toBe("ねえ");
	h.state.steps.push({ text: "はい。" }, { text: "はい。" });
	const failed = await h.say("もう一度", "failed");
	expect(failed.error).toBe("invalid_conversation_operation");
});

test("a live question needs a basis: an instant toolchain's answer is one, and makes no TODO", async () => {
	h = await setup();
	const live = { kind: "live_info", freshness: "live" };
	h.state.steps.push(
		// Speaking at once on a live question has no basis: repaired once.
		{ text: "12時です。", calls: [respond(live)] },
		{ calls: [{ name: "find_toolchain", args: { query: "時刻" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: INSTANT.id,
						request: "東京の時刻",
						impact: "none",
						inputs: { city: "東京" },
					},
				},
			],
		},
		{ text: "東京は12時です。", calls: [respond(live)] },
	);
	const run = await h.say("東京は今何時？");
	expect(h.dialogue.answerText(run.id)).toBe("東京は12時です。");
	const rejected = h.state.calls[1]!.messages.find((m) =>
		m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
	);
	expect(rejected?.content).toContain("answer_without_basis");
	expect(h.todos()).toEqual([]);
	const tool = h.state.calls.at(-1)!.messages.filter((m) => m.role === "tool");
	expect(JSON.parse(tool.at(-1)!.content)).toEqual({
		answered: true,
		answer: "東京は12時です。",
	});
});

test("a delegation is announced, opens a TODO and hands the run over; the result comes back through active", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵を描く" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	expect(waiting.announcement).toBe("描きますね。");
	const [todo] = h.todos();
	expect(todo).toMatchObject({ status: "todo", title: "猫の絵" });
	const types = h
		.log()
		.map((e) => [
			e.type,
			e.by,
			h!.fields(e).action ?? h!.fields(e).origin ?? null,
		]);
	expect(types).toEqual([
		["acted", "agent", "find_toolchain"],
		["said", "user", null],
		["said", "agent", "announcement"],
		["delivered", "host", null],
		["acted", "agent", "delegate"],
	]);
	// The result: the TODO is done, its slot is in active, the generation speaks on the fixed text and archives it.
	h.state.steps.push({
		text: "猫の絵ができました。",
		calls: [],
	});
	h.state.steps.unshift({
		calls: [
			{
				name: "work",
				args: {
					todo: todo!.id,
					operation: "archive",
					revision: todo!.revision + 1,
					told: "this",
				},
			},
		],
	});
	const done = await h.finishImage(waiting.id, {
		state: "completed",
		title: "猫",
	});
	expect(h.dialogue.answerText(done.id)).toBe("猫の絵ができました。");
	const resumed = h.state.calls.at(-2)!;
	expect(resumed.messages.at(-1)!.content).toContain("新しい出来事があります");
	const document = JSON.parse(resumed.messages[1]!.content) as {
		active: Array<Record<string, unknown>>;
		now: { trigger: Array<Record<string, unknown>> };
	};
	expect(document.now.trigger[0]).toMatchObject({ kind: "todo_changed" });
	expect(JSON.stringify(document.active)).toContain("猫");
	// Said with todoRefs? This one named none, so the archive stays unconfirmed and the TODO stays done.
	expect(h.todos()[0]).toMatchObject({ status: "done", outcome: "succeeded" });
	expect(
		h.log().some((e) => h!.fields(e).action === "work.archive_unconfirmed"),
	).toBe(true);
});

test("a TODO told archived by the utterance that names it is archived once delivered, and its slot removed", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "犬の絵",
						impact: "create",
						announcement: "描きます。",
					},
				},
			],
		},
	);
	const waiting = await h.say("犬の絵", "queued");
	const [todo] = h.todos();
	// The result's generation archives the TODO with this utterance and names it in todoRefs.
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: todo!.id,
						operation: "archive",
						revision: todo!.revision + 1,
						told: "this",
					},
				},
			],
		},
		{
			text: "犬の絵ができました。",
			calls: [respond({ todoRefs: [todo!.id] })],
		},
	);
	await h.finishImage(waiting.id, { state: "completed", title: "犬" });
	expect(h.todos()).toEqual([]);
	expect(h.active()).toEqual([]);
	expect(h.log().some((e) => h!.fields(e).action === "work.archived")).toBe(
		true,
	);
});

test("a change needs a confirmation first; the approval executes the saved request", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵の差替え" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
						announcement: "差し替えます。",
					},
				},
			],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
					},
				},
			],
		},
		{
			text: "今の壁紙を差し替えてよいですか？",
			calls: [respond({ kind: "action", impact: "modify_existing" })],
		},
	);
	await h.say("壁紙を差し替えて");
	const repaired = h.state.calls[2]!.messages.find((m) =>
		m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
	);
	expect(repaired?.content).toContain("confirmation_required");
	const confirmationId = h.store.read(
		(db) =>
			db.query("SELECT id FROM dialogue_confirmations").get() as { id: string },
	).id;
	const document = JSON.parse(h.state.calls.at(-1)!.messages[1]!.content);
	expect(document).toBeTruthy();
	h.state.steps.push({
		calls: [
			{
				name: "delegate",
				args: {
					mode: "approve",
					confirmation: confirmationId,
					announcement: "差し替えます。",
				},
			},
		],
	});
	const approved = await h.say("お願い", "queued");
	expect(approved.announcement).toBe("差し替えます。");
	expect(h.todos()[0]).toMatchObject({
		title: "壁紙を差し替える",
		status: "todo",
	});
	// A confirmation is used once.
	expect(
		h.store.read(
			(db) =>
				db.query("SELECT used_at FROM dialogue_confirmations").get() as {
					used_at: string | null;
				},
		).used_at,
	).not.toBeNull();
});

test("a memory request goes to the steward with the user's message as its source", async () => {
	h = await setup();
	h.state.steps.push(
		{
			calls: [
				{
					name: "memory",
					args: {
						operation: "request",
						kind: "remember",
						what: "辛い物が好き",
					},
				},
			],
		},
		{ text: "覚えておきます。", calls: [respond({ kind: "action" })] },
	);
	const run = await h.say("辛い物が好きって覚えて");
	expect(h.state.stewardRequests).toEqual([
		expect.objectContaining({
			kind: "remember",
			what: "辛い物が好き",
			sourceRef: run.inputMessageId,
		}),
	]);
});

test("a spoken answer cut short records what was heard, without the announcement", async () => {
	h = await setup();
	h.state.steps.push({
		text: "長い答えです。続きがあります。",
		calls: [respond()],
	});
	const run = await h.say("教えて");
	// A text reply is delivered in full at once; a later playback report adds nothing.
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, run.id, "partial", "長い答え"),
	);
	expect(h.log().filter((e) => e.type === "delivered")).toHaveLength(1);
});
