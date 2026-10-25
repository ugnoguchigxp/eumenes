import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerDialogue } from "../controller";
import {
	STUDIO,
	STUDIO_ARTIFACT,
	setup,
	type Harness,
} from "./specialist.fixture";

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
const invoke = (title: unknown) => ({
	action: "invoke",
	tool: "draft.apply",
	arguments: { title },
});
async function start(h: Harness) {
	h.handOver({ request: "作って" });
	h.state.specialist.push(reply("はじめます"));
	await h.ask("作って");
}
const lastPrompt = (h: Harness) =>
	h.state.specialistPrompts
		.at(-1)!
		.map((m) => m.content)
		.join("\n");

test("a malformed output is repaired once with the rejected output as data; a second one fails the run", async () => {
	const h = await harness();
	await start(h);
	h.state.specialist.push("これはJSONではありません", reply("直しました"));
	const repaired = await h.ask("続き");
	expect(repaired.status).toBe("completed");
	expect(h.conversation.message(repaired.answerMessageId!)!.text).toBe(
		"直しました",
	);
	expect(lastPrompt(h)).toContain("REJECTED_OUTPUT=");
	h.state.specialist.push({ action: "reply" }, { action: "reply" });
	const failed = await h.ask("もう一度");
	expect(failed).toMatchObject({
		status: "failed",
		error: "specialist_invalid_contract",
	});
	// A failed turn releases the work and leaves the session as it was.
	expect(h.work()[0]!.holder).toBeNull();
	expect((await h.session())!.state).toBe("active");
});

/** The `issues` the repair call carried for the rejected output (data after REJECTED_OUTPUT=). */
function rejectedIssues(h: Harness) {
	const message = h.state.specialistPrompts
		.at(-1)!
		.find((m) => m.content.includes("REJECTED_OUTPUT="))!;
	return {
		message: message.content,
		issues: JSON.parse(message.content.split("REJECTED_OUTPUT=")[1]!).issues,
	};
}

test("a repair call says where the output broke the contract: schema path and kind, or the reply's measured length, never an internal code name", async () => {
	const h = await harness();
	await start(h);
	// A reply too long: its measured characters, sentences and limits are data.
	const long = "これは長い説明です。".repeat(5);
	h.state.specialist.push(reply(long), reply("短く直しました"));
	const spoken = await h.ask("説明して");
	expect(spoken.status).toBe("completed");
	const length = rejectedIssues(h);
	expect(length.issues).toEqual([
		{ path: "text", chars: 50, maxChars: 300, sentences: 5, maxSentences: 2 },
	]);
	expect(length.message).not.toContain("spoken_reply");
	// A wrong type: the path and the schema's kind only.
	h.state.specialist.push({ action: "reply", text: 5 }, reply("直しました"));
	await h.ask("もう一度");
	expect(rejectedIssues(h).issues).toEqual([
		{ path: "text", code: "invalid_type", expected: "string" },
	]);
	// A field the action must not carry, and a field it needs.
	h.state.specialist.push(
		{ action: "invoke", tool: "draft.apply", forward: true },
		{ action: "reply" },
	);
	const failed = await h.ask("さらにもう一度");
	expect(failed.error).toBe("specialist_invalid_contract");
	h.state.specialist.push(
		{ action: "invoke", tool: "draft.apply", forward: true },
		reply("直しました"),
	);
	await h.ask("最後に");
	expect(rejectedIssues(h).issues).toEqual([
		{ action: "invoke", missing: [], unexpected: ["forward"] },
	]);
});

test("a turn is bounded by its model calls; the last one must carry its reply, and work changed before the limit is reported by the host", async () => {
	const h = await harness();
	await start(h);
	const before = h.state.specialistPrompts.length;
	for (let i = 0; i < 8; i++) h.state.specialist.push(invoke(`案${i}`));
	const run = await h.ask("延々と変更して");
	expect(run.status).toBe("completed");
	expect(h.conversation.message(run.answerMessageId!)!.text).toBe(
		"案2を更新しました。",
	);
	// Four calls by default; the fourth invoke has no reply and cannot read a result, so it does not run.
	expect(h.state.specialistPrompts.length - before).toBe(4);
	expect(h.state.invocations).toHaveLength(3);
	expect(h.state.specialistPrompts.at(-1)!.at(-1)!.content).toContain(
		'"callsLeft":1',
	);
});

test("refusals beyond the tool's retries end the turn with the host's words", async () => {
	const h = await harness();
	await start(h);
	h.state.specialist.splice(0);
	h.state.invokeError = "generation_in_progress";
	const before = h.state.specialistPrompts.length;
	h.state.specialist.push(invoke("一"), invoke("二"), invoke("三"));
	const run = await h.ask("変更して");
	expect(run.status).toBe("completed");
	expect(h.conversation.message(run.answerMessageId!)!.text).toBe(
		"反映できませんでした。",
	);
	// One retry by default: the second refusal ends the turn.
	expect(h.state.specialistPrompts.length - before).toBe(2);
});

test("a refused or invalid operation is data for the next call, never a crash", async () => {
	const h = await harness();
	await start(h);
	h.state.specialist.push(invoke(42), reply("引数を直せませんでした"));
	const invalid = await h.ask("変更して");
	expect(invalid.status).toBe("completed");
	expect(lastPrompt(h)).toContain(
		'TOOL_RESULT={"ok":false,"error":"specialist_invalid_arguments","detail":["title: invalid_type expected=string"],"callsLeft":3}',
	);
	expect(h.state.invocations).toHaveLength(0);
	h.state.invokeError = "generation_in_progress";
	h.state.specialist.push(invoke("案"), reply("反映できませんでした"));
	const refused = await h.ask("もう一度");
	expect(refused.status).toBe("completed");
	expect(lastPrompt(h)).toContain('"error":"generation_in_progress"');
	h.state.specialist.push(
		{ action: "invoke", tool: "unknown.tool", arguments: {} },
		reply("そのツールはありません"),
	);
	await h.ask("別のツール");
	expect(lastPrompt(h)).toContain('"error":"specialist_tool_unknown"');
});

test("the specialist is not given memory, World, the main prompt or the conversation's persona", async () => {
	const h = await harness();
	await start(h);
	const prompt = h.state.specialistPrompts[0]!;
	expect(prompt[0]!.role).toBe("system");
	expect(prompt[0]!.content).toContain("制作の専門担当");
	expect(prompt[0]!.content).toContain("TOOLS=");
	expect(prompt[0]!.content).not.toContain("執事");
	expect(prompt).toHaveLength(3);
	// The current request alone, as the user said it, after the enclosed reference data.
	expect(prompt.at(-1)!.content).toBe("作って");
	const input = JSON.parse(prompt[1]!.content.split("REFERENCE=")[1]!);
	expect(Object.keys(input).sort()).toEqual(
		[
			"callsLeft",
			"course",
			"currentWork",
			"dirty",
			"label",
			"now",
			"timeZone",
			"savedRef",
			"viewing",
		].sort(),
	);
	// The time is the host clock as local ISO 8601 with its offset, not a UTC string.
	expect(input.now).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/);
	expect(input.timeZone).toBe("Asia/Tokyo");
	expect(h.state.captures.every((c) => c.maxOutputTokens === 24_576)).toBe(
		true,
	);
	// Without time limits of its own the toolchain keeps the host defaults.
	expect(h.state.captures.every((c) => !("attemptMs" in c))).toBe(true);
	expect(h.state.extended).toEqual([]);
});

test("a toolchain's own time limits: the run lasts its run time from the hand-over, each call gets its turn and inference time, and an utterance addressed to it gets the run time too", async () => {
	const h = await harness({
		limits: { runMs: 1_200_000, turnMs: 900_000, inferenceMs: 600_000 },
	});
	h.handOver({ request: "作って" });
	h.state.specialist.push(reply("はじめます"));
	const handed = await h.ask("作って");
	expect(handed.status).toBe("completed");
	const lasts = (run: { deadlineAt: string | null; createdAt: string }) =>
		Date.parse(run.deadlineAt!) - Date.parse(run.createdAt);
	expect(lasts(handed)).toBeGreaterThanOrEqual(1_200_000);
	expect(h.state.extended).toHaveLength(1);
	expect(h.state.extended[0]!.subject).toBe(handed.id);
	expect(h.state.extended[0]!.deadline).toBe(Date.parse(handed.deadlineAt!));
	const first = h.state.captures.at(-1)!;
	expect(first.attemptMs).toBe(600_000);
	// The turn's deadline is its turn time (well past the default 120 s), within the run's.
	expect(Number(first.deadline) - Date.now()).toBeGreaterThan(800_000);
	expect(Number(first.deadline)).toBeLessThanOrEqual(
		Date.parse(handed.deadlineAt!),
	);
	h.state.specialist.push(reply("直しました"));
	const addressed = await h.ask("もう少し暖かく");
	expect(addressed.status).toBe("completed");
	expect(lasts(addressed)).toBe(1_200_000);
	// Requests captured before (a voice turn's) are moved to the run's deadline as well.
	expect(h.state.extended.at(-1)).toEqual({
		subject: addressed.id,
		deadline: Date.parse(addressed.deadlineAt!),
	});
	expect(h.state.captures.at(-1)!.attemptMs).toBe(600_000);
});

test("the specialist turn never calls the conversation model, and a failed turn does not either", async () => {
	const h = await harness();
	await start(h);
	const calls = h.state.calls.length;
	h.state.specialist.push("x", "y");
	await h.ask("壊れた返答");
	h.state.specialist.push(reply("普通"));
	await h.ask("普通の返答");
	expect(h.state.calls).toHaveLength(calls);
});

test("HTTP: the session, its commands and their errors", async () => {
	const h = await harness();
	const app = new Hono();
	registerDialogue(app, h.dialogue);
	expect(
		await (await app.request("/api/conversations/main/specialist")).json(),
	).toEqual({
		session: null,
	});
	await start(h);
	const { session } = (await (
		await app.request("/api/conversations/main/specialist")
	).json()) as { session: { id: string; revision: number; state: string } };
	expect(session.state).toBe("active");
	const post = (kind: string, body: unknown) =>
		app.request(`/api/specialist-sessions/${session.id}/${kind}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const stale = await post("return", {
		requestId: crypto.randomUUID(),
		expectedRevision: session.revision + 5,
	});
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "revision_conflict" });
	const bad = await post("return", { requestId: "x" });
	expect(bad.status).toBe(400);
	const requestId = crypto.randomUUID();
	const body = { requestId, expectedRevision: session.revision };
	const returned = await post("return", body);
	expect(returned.status).toBe(200);
	const first = (await returned.json()) as { session: { state: string } };
	expect(first.session.state).toBe("ended");
	const missing = await app.request("/api/specialist-sessions/missing/close", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
		}),
	});
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({
		error: "specialist_session_not_found",
	});
});

test("HTTP: an utterance while a turn holds the work is accepted and queued", async () => {
	const h = await harness();
	const app = new Hono();
	registerDialogue(app, h.dialogue);
	await start(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("一つ目"), reply("二つ目"));
	const run = await h.say("一つ目");
	await h.until(() => h.dialogue.get(run.id)?.status === "running");
	const second = await app.request("/api/runs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "二つ目",
		}),
	});
	expect(second.status).toBe(202);
	const queued = (await second.json()) as { id: string };
	release();
	await h.finished(run.id);
	await h.finished(queued.id);
	expect(h.dialogue.get(queued.id)!.status).toBe("completed");
});

test("the addressee the screen showed must still listen: otherwise nothing is stored (409 addressee_changed)", async () => {
	const h = await harness();
	const app = new Hono();
	registerDialogue(app, h.dialogue);
	const send = (addressee: unknown, text = "こんにちは") =>
		app.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
				addressee,
			}),
		});
	const stored = () => h.rows("SELECT COUNT(*) AS n FROM dialogue_runs")[0]!.n;
	// Main is listening: a send that saw a specialist is refused, one that saw the main agent goes through.
	h.state.steps.push({ text: "はい" });
	expect((await send({ sessionId: "x", epoch: 1 })).status).toBe(409);
	expect(stored()).toBe(0);
	expect(h.rows("SELECT COUNT(*) AS n FROM messages")[0]!.n).toBe(0);
	const ok = await send({ sessionId: null, epoch: null });
	expect(ok.status).toBe(202);
	await h.finished(((await ok.json()) as { id: string }).id);
	await start(h);
	const session = (await h.session())!;
	const before = stored();
	const stale = await send({ sessionId: null, epoch: null }, "メインへ");
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "addressee_changed" });
	expect(
		(await send({ sessionId: session.id, epoch: session.epoch + 1 })).status,
	).toBe(409);
	expect(stored()).toBe(before);
	h.state.specialist.push(reply("聞こえました"));
	const matched = await send(
		{ sessionId: session.id, epoch: session.epoch },
		"専門へ",
	);
	expect(matched.status).toBe(202);
	await h.finished(((await matched.json()) as { id: string }).id);
	// Voice and other senders without an addressee are unaffected.
	h.state.specialist.push(reply("はい"));
	expect((await h.ask("宛先なし")).status).toBe("completed");
});

test("a saved item older than the recent choices is offered, accepted and shown when it is on screen", async () => {
	const h = await harness();
	const viewing = {
		artifactRevisionId: STUDIO_ARTIFACT,
		targetRef: "item-old",
	};
	h.state.steps.push({ text: "見ています" });
	await h.ask("これは？", { viewing });
	const shown = (h.material(0).now.records ?? []).find(
		(r: { source: string }) => r.source === "specialist.viewing",
	);
	expect(shown.data).toMatchObject({ ref: "item-old", label: "古い項目" });
	h.handOver({ request: "これを直して", target: "item-old" });
	h.state.specialist.push(reply("開きました"));
	await h.ask("これを直して", { viewing });
	// The search offers it as a target of the studio.
	const found = JSON.parse(
		h.state.calls[2]!.messages.filter((m) => m.role === "tool").at(-1)!.content,
	) as { candidates: Array<{ id: string; targets: Array<{ ref: string }> }> };
	expect(
		found.candidates.find((c) => c.id === STUDIO.id)!.targets.map((t) => t.ref),
	).toContain("item-old");
	expect(h.work()[0]!.savedRef).toBe("item-old");
	// Without the screen showing it, the same ref is not issued: nothing starts.
	const other = await harness();
	other.handOver({ request: "直して", target: "item-old" });
	other.state.steps.push({ text: "開けません" });
	await other.ask("直して");
	expect(other.work()).toHaveLength(0);
	expect(await other.session()).toBeNull();
});

test("a refusal's short repair hint reaches the specialist, truncated", async () => {
	const h = await harness();
	await start(h);
	h.state.invokeError = "invalid_definition";
	h.state.invokeDetail = "x".repeat(3000);
	h.state.specialist.push(invoke("案"), reply("直します"));
	await h.ask("変更して");
	const result = lastPrompt(h)
		.split("\n")
		.find((line) => line.startsWith("TOOL_RESULT="))!;
	const parsed = JSON.parse(result.slice("TOOL_RESULT=".length));
	expect(parsed).toMatchObject({ ok: false, error: "invalid_definition" });
	expect(parsed.detail).toHaveLength(1000);
});
