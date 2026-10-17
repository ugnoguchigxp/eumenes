import { afterEach, expect, test } from "bun:test";
import type { LarmPort } from "../../domains/larm";
import { harness } from "./toolchain.fixture";

/**
 * API-level integration of the specialist dialogue (spec toolchain-specialist-dialogue-p0-contract):
 * the real wiring of the harness (dialogue, `createSpecialistPort`, the ui-compositions bundle and
 * adapter, the action ledger) with scripted models. Nothing but the models is faked.
 */

const STUDIO = "artifact:ui.studio@2";
const id = () => crypto.randomUUID();

/** A valid definition: a heading text, a radio field and a free-text field. */
const survey = (title: string, gap?: "compact" | "normal" | "relaxed") => ({
	view: "layout",
	direction: "stack",
	...(gap ? { gap } : {}),
	children: [
		{ view: "text-block", title, body: "ご感想をお聞かせください。" },
		{
			view: "form",
			title: "アンケート",
			fields: [
				{
					id: "rating",
					label: "満足度",
					type: "radio",
					required: true,
					options: ["満足", "普通", "不満"],
				},
				{ id: "comment", label: "感想", type: "textarea", required: false },
			],
		},
	],
});
const apply = (title: string, gap?: "compact" | "normal" | "relaxed") => ({
	action: "invoke",
	tool: "ui.draft.apply",
	arguments: { title, definition: survey(title, gap) },
});
const reply = (text: string) => ({ action: "reply", text });
const toolCall = (request: string, extra: Record<string, unknown> = {}) => ({
	tool: "ui_create",
	args: { request, announcement: "制作担当に引き継ぎます。", ...extra },
});

type Prompt = Array<{ role: string; content: string }>;
type MainStep = string | { tool: string; args: Record<string, unknown> };
type SpecialistStep = unknown | ((signal: AbortSignal) => Promise<unknown>);

const rigs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.close();
});

/** The harness with a model that answers the main agent and the specialist from two scripts. */
async function rig() {
	const script = {
		main: [] as MainStep[],
		specialist: [] as SpecialistStep[],
	};
	const mainPrompts: Prompt[] = [];
	let routeCalls = 0;
	const specialistPrompts: Prompt[] = [];
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(48),
		answer: async (messages, signal, options) => {
			const system = messages[0]!.content;
			if (system.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			if (system.includes("FUNCTIONS="))
				return JSON.stringify({
					decision: "answer",
					functionName: "",
					request: "",
					questionRef: "",
				});
			if (system.includes("あなたはUI制作の専門担当です")) {
				specialistPrompts.push(messages.map((m) => ({ ...m })));
				const step = script.specialist.shift();
				if (step === undefined) throw new Error("script_specialist_missing");
				const value =
					typeof step === "function"
						? await (step as (s: AbortSignal) => Promise<unknown>)(
								signal ?? new AbortController().signal,
							)
						: step;
				return typeof value === "string" ? value : JSON.stringify(value);
			}
			mainPrompts.push(messages.map((m) => ({ ...m })));
			const discovery = options?.tools?.[0]?.function.name === "find_toolchain";
			const head = script.main[0];
			if (discovery) routeCalls++;
			if (discovery && typeof head === "object") {
				options!.onToolCalls!([
					{ id: id(), name: "find_toolchain", arguments: "{}" },
				]);
				return "";
			}
			const routing = !!options?.tools?.length && !discovery;
			if (routing && typeof head === "object") {
				script.main.shift();
				options!.onToolCalls!([
					{ id: id(), name: head.tool, arguments: JSON.stringify(head.args) },
				]);
				return "";
			}
			const step = script.main.shift() ?? "かしこまりました。";
			if (typeof step !== "string") throw new Error("script_tool_after_route");
			return step;
		},
	};
	const h = await harness({ uiCompositions: true, model });
	const handle = { close: () => h.close() };
	rigs.push(handle);

	/** Posts a user utterance; with `wait` false the run is not awaited (a gated turn). */
	const say = async (text: string, extra: Record<string, unknown> = {}) => {
		const response = await h.request("/api/runs", {
			requestId: id(),
			conversationId: "main",
			text,
			...extra,
		});
		expect(response.status).toBe(202);
		const run = (await response.json()) as { id: string };
		return {
			run,
			done: async () =>
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))!,
		};
	};
	const sayAndWait = async (text: string) => {
		const sent = await say(text);
		const done = await sent.done();
		return { id: sent.run.id, status: done.status };
	};
	const session = async () =>
		(
			(await (
				await h.request("/api/conversations/main/specialist")
			).json()) as {
				session: Record<string, any> | null;
			}
		).session;
	const source = async () => {
		const response = await h.request(
			`/api/toolchain-artifacts/${STUDIO}/sources/ui-studio`,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			revision: number;
			data: {
				work: Record<string, any> | null;
				viewing: unknown;
				history: Array<{ id: string; title: string }>;
			};
		};
	};
	/** One screen action as the ledger takes it (the screen sends string values). */
	const act = async (
		actionId: "undo" | "redo" | "save",
		patch: Record<string, string> = {},
	) => {
		const now = await source();
		const work = now.data.work!;
		const input =
			actionId === "save"
				? {
						workRef: work.workRef,
						expectedRevision: String(work.revision),
						expectedSavedRevision: String(work.savedRevision),
					}
				: { workRef: work.workRef, expectedRevision: String(work.revision) };
		const response = await h.request("/api/toolchain-actions", {
			version: 1,
			eventId: id(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: STUDIO,
			source: "ui-studio",
			sourceRevision: now.revision,
			actionId,
			scopeRef: h.toolchain.actionRequests.scopeRef,
			input: { ...input, ...patch },
		});
		return (await response.json()) as {
			status: string;
			errorCode?: string;
			error?: string;
		};
	};
	const command = async (
		kind: "return" | "resume" | "discard" | "close",
		current?: Record<string, any>,
	) => {
		const live = current ?? (await session())!;
		const response = await h.request(
			`/api/specialist-sessions/${live.id}/${kind}`,
			{
				requestId: id(),
				expectedRevision: live.revision,
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, any>,
		};
	};
	/** A specialist step that waits (until released or the turn is cancelled) and then answers. */
	const hold = (then: unknown) => {
		let release!: () => void;
		let entered!: () => void;
		const open = new Promise<void>((resolve) => (release = resolve));
		const reached = new Promise<void>((resolve) => (entered = resolve));
		const step: SpecialistStep = async (signal: AbortSignal) => {
			entered();
			await Promise.race([
				open,
				new Promise<never>((_, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					}),
				),
			]);
			return then;
		};
		return { step, release, reached };
	};
	/** Starts the session with a first request answered by `steps` and returns its run. */
	const start = async (
		steps: SpecialistStep[] = [apply("来場者アンケート"), reply("初稿です。")],
		request = "来場者アンケートのUIを作ってください",
	) => {
		script.main.push(toolCall(request));
		script.specialist.push(...steps);
		return sayAndWait(request);
	};
	return {
		h,
		script,
		mainPrompts,
		/** How many runs the main agent took (each starts with one answer/discovery decision). */
		get mainRuns() {
			return routeCalls;
		},
		specialistPrompts,
		say,
		sayAndWait,
		session,
		source,
		act,
		command,
		hold,
		start,
	};
}

const text = (prompt: Prompt) => prompt.map((m) => m.content).join("\n");

test("ui_create opens the work and the same run continues as the specialist's turn, which drafts and replies", async () => {
	const r = await rig();
	const first = await r.start();
	expect(first.status).toBe("completed");
	// The main agent decided, then selected the toolchain; the specialist answered the run.
	expect(r.mainRuns).toBe(1);
	expect(r.mainPrompts).toHaveLength(2);
	expect(r.h.dialogue.answerText(first.id)).toBe("初稿です。");
	expect(r.h.dialogue.get(first.id)!.specialistSessionId).toBe(
		(await r.session())!.id,
	);
	const live = (await r.session())!;
	expect(live).toMatchObject({
		state: "active",
		toolchainId: "ui.compose",
		artifactRevisionId: STUDIO,
		activeRunId: null,
		dirty: true,
		busy: false,
	});
	const { work } = (await r.source()).data;
	expect(work).toMatchObject({
		sessionId: live.id,
		workRef: live.workRef,
		title: "来場者アンケート",
		dirty: true,
		busy: false,
		canUndo: true,
		canRedo: false,
		savedRevision: 0,
	});
	expect(work!.definition.children[1].fields[0]).toMatchObject({
		id: "rating",
		type: "radio",
		options: ["満足", "普通", "不満"],
	});
	// The specialist saw the request, the tools of its set and nothing else of the conversation.
	const prompt = r.specialistPrompts[0]!;
	expect(prompt.map((m) => m.role)).toEqual(["system", "user"]);
	expect(prompt[0]!.content).toContain("ui.draft.apply");
	expect(JSON.parse(prompt[1]!.content).request).toBe(
		"来場者アンケートのUIを作ってください",
	);
});

test("later utterances go to the specialist without the main model; an explanation does not grow the undo history", async () => {
	const r = await rig();
	await r.start();
	r.script.specialist.push(
		apply("やわらかいアンケート", "relaxed"),
		reply("雰囲気をやわらかくしました。"),
		reply("このままで問題ありません。"),
	);
	const mainBefore = r.mainPrompts.length;
	const soften = await r.sayAndWait("もっとやわらかい雰囲気にしてください");
	expect(soften.status).toBe("completed");
	const afterSoften = (await r.source()).data.work!;
	expect(afterSoften.title).toBe("やわらかいアンケート");
	expect(afterSoften.definition.gap).toBe("relaxed");
	// The specialist's second input carries the first draft as the current work.
	const input = JSON.parse(r.specialistPrompts.at(-2)!.at(-1)!.content);
	expect(input.currentWork).toBeTruthy();

	const explain = await r.sayAndWait("この画面の使い方を教えてください");
	expect(explain.status).toBe("completed");
	expect(r.h.dialogue.answerText(explain.id)).toBe(
		"このままで問題ありません。",
	);
	const afterExplain = (await r.source()).data.work!;
	expect(afterExplain.revision).toBe(afterSoften.revision);
	expect(afterExplain.title).toBe("やわらかいアンケート");
	// Neither utterance reached the main model.
	expect(r.mainPrompts).toHaveLength(mainBefore);
	expect((await r.session())!.state).toBe("active");
	// Undo steps back exactly one change (explaining added nothing to the history).
	expect((await r.act("undo")).status).toBe("accepted");
	expect((await r.source()).data.work!.title).toBe("来場者アンケート");
});

test("undo and redo take the screen's string values; they are refused while a turn holds the work", async () => {
	const r = await rig();
	await r.start();
	r.script.specialist.push(apply("二つ目"), reply("直しました。"));
	await r.sayAndWait("直してください");
	expect((await r.source()).data.work).toMatchObject({
		title: "二つ目",
		canUndo: true,
		canRedo: false,
	});
	expect((await r.act("undo")).status).toBe("accepted");
	expect((await r.source()).data.work).toMatchObject({
		title: "来場者アンケート",
		canRedo: true,
	});
	expect((await r.act("redo")).status).toBe("accepted");
	expect((await r.source()).data.work!.title).toBe("二つ目");
	// A non-numeric screen value is a field error, not an operation.
	const invalid = await r.act("undo", { expectedRevision: "x" });
	expect(invalid.error).toBe("invalid_input");

	// While the specialist is thinking the work is busy: no history action is taken.
	const held = r.hold(reply("お待たせしました。"));
	r.script.specialist.push(held.step);
	const sent = await r.say("もう少し考えてください");
	await held.reached;
	expect((await r.source()).data.work).toMatchObject({ busy: true });
	const refusedUndo = await r.act("undo");
	expect(refusedUndo).toMatchObject({
		status: "rejected",
		errorCode: "generation_in_progress",
	});
	expect((await r.act("save")).errorCode).toBe("generation_in_progress");
	held.release();
	await sent.done();
	expect((await r.source()).data.work).toMatchObject({
		busy: false,
		title: "二つ目",
	});
	expect((await r.act("undo")).status).toBe("accepted");
});

test("only the screen saves: the saved work shows in the history and the specialist has no save tool", async () => {
	const r = await rig();
	await r.start();
	// A save asked of the specialist cannot be carried out: the tool does not exist.
	r.script.specialist.push(
		{ action: "invoke", tool: "ui.save", arguments: {} },
		reply("保存は画面の保存ボタンから行ってください。"),
	);
	const asked = await r.sayAndWait("保存しておいてください");
	expect(asked.status).toBe("completed");
	const toolResult = r.specialistPrompts.at(-1)!.at(-1)!.content;
	expect(toolResult).toContain("specialist_tool_unknown");
	const before = await r.source();
	expect(before.data.history).toEqual([]);
	expect(before.data.work).toMatchObject({ dirty: true, savedRevision: 0 });
	// The tool list the specialist works with is the one registered tool.
	const tools = JSON.parse(
		r.specialistPrompts[0]![0]!.content.split("TOOLS=")[1]!.split("\n")[0]!,
	) as Array<{ id: string }>;
	expect(tools.map((t) => t.id)).toEqual(["ui.draft.apply"]);

	expect((await r.act("save")).status).toBe("accepted");
	const saved = await r.source();
	expect(saved.data.history).toHaveLength(1);
	expect(saved.data.history[0]).toMatchObject({ title: "来場者アンケート" });
	expect(saved.data.work).toMatchObject({
		dirty: false,
		savedRevision: 1,
		canUndo: false,
	});
	// Saving again with nothing changed is refused, not a second work.
	expect((await r.act("save")).errorCode).toBe("nothing_to_save");
	expect((await r.source()).data.history).toHaveLength(1);
});

test("return with unsaved work suspends the session, the main agent answers, and ui_create resumes the same work", async () => {
	const r = await rig();
	await r.start();
	const live = (await r.session())!;
	r.script.specialist.push({
		action: "return",
		forward: false,
		text: "会話に戻ります。",
	});
	const back = await r.sayAndWait("会話エージェントに戻って");
	expect(back.status).toBe("completed");
	expect(r.h.dialogue.answerText(back.id)).toBe("会話に戻ります。");
	expect(await r.session()).toMatchObject({
		id: live.id,
		state: "suspended",
		dirty: true,
	});
	// The next utterance is the main agent's, who is told that work is pending.
	const mainBefore = r.mainRuns;
	r.script.main.push("ご用件をどうぞ。");
	const next = await r.sayAndWait("こんにちは");
	expect(r.mainRuns).toBe(mainBefore + 1);
	expect(r.h.dialogue.answerText(next.id)).toBe("ご用件をどうぞ。");
	const pending = text(r.mainPrompts.at(-1)!);
	expect(pending).toContain("specialistWork=");
	expect(pending).toContain('"unsaved":true');
	// Only the record's facts, never the draft's definition.
	expect(pending).not.toContain("ご感想をお聞かせください");
	// Starting the same toolchain again resumes the suspended work; no second work or session.
	r.script.main.push(toolCall("続きを直したいです"));
	r.script.specialist.push(reply("続きから直しましょう。"));
	const resumed = await r.sayAndWait("続きを直したいです");
	expect(resumed.status).toBe("completed");
	expect(r.h.dialogue.answerText(resumed.id)).toBe("続きから直しましょう。");
	const again = (await r.session())!;
	expect(again).toMatchObject({
		id: live.id,
		workRef: live.workRef,
		state: "active",
		dirty: true,
	});
	expect(again.epoch).toBeGreaterThan(live.epoch);
	expect((await r.source()).data.work).toMatchObject({
		workRef: live.workRef,
		title: "来場者アンケート",
	});
	// The screen's resume button does the same for a suspended session.
	r.script.specialist.push({ action: "return", forward: false, text: "戻る" });
	await r.sayAndWait("戻ってください");
	const suspended = (await r.session())!;
	expect(suspended.state).toBe("suspended");
	const resume = await r.command("resume", suspended);
	expect(resume.status).toBe(200);
	expect(resume.body.session).toMatchObject({
		id: live.id,
		state: "active",
		workRef: live.workRef,
	});
});

test("forward:true hands the same run to the main agent exactly once", async () => {
	const r = await rig();
	await r.start();
	r.script.specialist.push({ action: "return", forward: true });
	r.script.main.push("東京は晴れの予報です。");
	const mainBefore = r.mainRuns;
	const asked = await r.sayAndWait("今日の天気を教えてください");
	expect(asked.status).toBe("completed");
	expect(r.mainRuns).toBe(mainBefore + 1);
	const forwarded = r.mainPrompts.at(-1)!;
	expect(forwarded.at(-1)!.content).toContain("今日の天気を教えてください");
	expect(r.h.dialogue.answerText(asked.id)).toBe("東京は晴れの予報です。");
	// The unsaved draft is kept for later; the run is the main agent's now.
	expect(await r.session()).toMatchObject({ state: "suspended", dirty: true });
	expect(r.h.dialogue.get(asked.id)!.status).toBe("completed");
	// Nothing else asked the main agent in the meantime.
	expect(r.mainRuns).toBe(mainBefore + 1);
});

test("a discard command during a running turn cancels the run and removes the work, leaving saved works alone", async () => {
	const r = await rig();
	await r.start();
	expect((await r.act("save")).status).toBe("accepted");
	r.script.specialist.push(apply("保存後の変更"), reply("変更しました。"));
	await r.sayAndWait("もう少し直してください");
	const held = r.hold(reply("遅れて届く返答"));
	r.script.specialist.push(held.step);
	const sent = await r.say("さらに直してください");
	await held.reached;
	const live = (await r.session())!;
	expect(live).toMatchObject({ busy: true, activeRunId: sent.run.id });

	const discarded = await r.command("discard", live);
	expect(discarded.status).toBe(200);
	expect(discarded.body.session).toMatchObject({
		state: "ended",
		endReason: "discarded",
	});
	const done = await sent.done();
	expect(done.status).toBe("cancelled");
	expect(await r.session()).toBeNull();
	// The in-flight turn's late answer was never adopted.
	held.release();
	expect(r.h.dialogue.answerText(sent.run.id)).toBeNull();
	const after = await r.source();
	expect(after.data.work).toBeNull();
	expect(after.data.history).toHaveLength(1);
	expect(after.data.history[0]).toMatchObject({ title: "来場者アンケート" });
	// The conversation is the main agent's again.
	r.script.main.push("はい。");
	const next = await r.sayAndWait("こんにちは");
	expect(r.h.dialogue.answerText(next.id)).toBe("はい。");
});

test("closing: unsaved work is refused with work_unsaved; clean work ends", async () => {
	const r = await rig();
	await r.start();
	const live = (await r.session())!;
	const refused = await r.command("close", live);
	expect(refused.status).toBe(409);
	expect(refused.body.error).toBe("work_unsaved");
	expect(await r.session()).toMatchObject({ id: live.id, state: "active" });
	expect((await r.source()).data.work).toMatchObject({ dirty: true });

	expect((await r.act("save")).status).toBe("accepted");
	const closed = await r.command("close");
	expect(closed.status).toBe(200);
	expect(closed.body.session).toMatchObject({
		state: "ended",
		endReason: "closed",
	});
	expect(await r.session()).toBeNull();
	const after = await r.source();
	expect(after.data.work).toBeNull();
	expect(after.data.history).toHaveLength(1);
});

test("a session idle past its expiry is ended by the sweep and its work is removed", async () => {
	const r = await rig();
	await r.start();
	const live = (await r.session())!;
	const day = 24 * 3_600_000;
	// Before the expiry nothing happens.
	await r.h.store.write((db) =>
		r.h.dialogue.sweepSpecialistSessionsInTransaction(
			db,
			new Date(Date.parse(live.expiresAt) - 1000).toISOString(),
		),
	);
	expect((await r.session())!.state).toBe("active");
	expect((await r.source()).data.work).not.toBeNull();
	await r.h.store.write((db) =>
		r.h.dialogue.sweepSpecialistSessionsInTransaction(
			db,
			new Date(Date.parse(live.expiresAt) + day).toISOString(),
		),
	);
	expect(await r.session()).toBeNull();
	expect((await r.source()).data.work).toBeNull();
	// The main agent is told once why the session ended, then the conversation is plain.
	r.script.main.push("承知しました。");
	await r.sayAndWait("こんにちは");
	expect(text(r.mainPrompts.at(-1)!)).toContain("expired");
});

test("the specialist's prompt holds no conversation, World or memory material and specialist messages stay out of the main agent's prompt", async () => {
	const r = await rig();
	r.script.main.push("好きな色は青色と覚えました。");
	const plain = await r.sayAndWait("私の好きな色はMAIN_MARKER_BLUEです");
	expect(plain.status).toBe("completed");
	await r.start(
		[apply("来場者アンケート"), reply("SPECIALIST_REPLY_ONE")],
		"来場者アンケートのUIを作ってください",
	);
	r.script.specialist.push(reply("SPECIALIST_REPLY_TWO"));
	await r.sayAndWait("SPECIALIST_USER_TWO");
	for (const prompt of r.specialistPrompts) {
		expect(text(prompt)).not.toContain("MAIN_MARKER_BLUE");
		expect(prompt[0]!.role).toBe("system");
		// Only the instruction and the turn's data (plus the turn's own tool exchange).
		// The turn's data is the last user message that is not a tool result.
		const data = prompt
			.filter((m) => m.role === "user" && !m.content.startsWith("TOOL_RESULT="))
			.at(-1)!;
		expect(Object.keys(JSON.parse(data.content)).sort()).toEqual(
			[
				"currentWork",
				"dirty",
				"label",
				"now",
				"request",
				"savedRef",
				"timeZone",
				"viewing",
			].sort(),
		);
	}
	// Return to the main agent: it never reads what was said with the specialist.
	r.script.specialist.push({
		action: "return",
		forward: false,
		text: "戻ります",
	});
	await r.sayAndWait("会話に戻ってください");
	r.script.main.push("こんにちは。");
	await r.sayAndWait("MAIN_MARKER_AFTER");
	const main = text(r.mainPrompts.at(-1)!);
	expect(main).toContain("MAIN_MARKER_AFTER");
	expect(main).toContain("MAIN_MARKER_BLUE");
	for (const marker of [
		"SPECIALIST_REPLY_ONE",
		"SPECIALIST_REPLY_TWO",
		"SPECIALIST_USER_TWO",
		"会話に戻ってください",
		"戻ります",
	])
		expect(main).not.toContain(marker);
});

test("a draft with a view outside the allowed set is refused and neither the draft nor the undo history changes", async () => {
	const r = await rig();
	await r.start();
	const before = (await r.source()).data.work!;
	r.script.specialist.push(
		{
			action: "invoke",
			tool: "ui.draft.apply",
			arguments: {
				title: "不正",
				definition: { view: "ui-studio", source: "ui-studio", title: "x" },
			},
		},
		reply("反映できませんでした。"),
	);
	const refused = await r.sayAndWait("別の画面を埋め込んでください");
	expect(refused.status).toBe("completed");
	const result = r.specialistPrompts.at(-1)!.at(-1)!.content;
	expect(result).toStartWith("TOOL_RESULT=");
	expect(result).toContain('"ok":false');
	const after = (await r.source()).data.work!;
	expect(after.title).toBe(before.title);
	expect(after.revision).toBe(before.revision);
	// One undo returns to the empty start: the refused draft added nothing.
	expect((await r.act("undo")).status).toBe("accepted");
	expect((await r.source()).data.work).toMatchObject({
		canUndo: false,
		definition: null,
	});
});
