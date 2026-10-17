import { expect, test } from "bun:test";
import { setup } from "./specialist.fixture";
import { parseSpecialistAction } from "../service/specialist-prompt";
import { isBriefSpokenReply } from "../../delivery";

test("a verbose conversation answer is rewritten before any body is published", async () => {
	const h = await setup();
	try {
		h.state.main.push(
			"長い解説です。".repeat(30),
			"降水確率は、雨の降る可能性を表します。",
		);
		const run = await h.say("降水確率って何？");
		const bodies: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.text) bodies.push(p.text);
		});
		try {
			await h.finished(run.id);
		} finally {
			stop();
		}
		expect(h.dialogue.get(run.id)?.status).toBe("completed");
		expect(h.state.mainCalls).toHaveLength(2);
		expect(h.dialogue.answerText(run.id)).toBe(
			"降水確率は、雨の降る可能性を表します。",
		);
		expect(bodies.every((body) => body === h.dialogue.answerText(run.id))).toBe(
			true,
		);
	} finally {
		await h.close();
	}
});

test("two verbose answers fail without releasing text for speech", async () => {
	const h = await setup();
	try {
		h.state.main.push("長い説明。".repeat(40), "まだ長い説明。".repeat(30));
		const run = await h.say("意味を教えて");
		const bodies: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.text) bodies.push(p.text);
		});
		try {
			await h.finished(run.id);
		} finally {
			stop();
		}
		expect(h.dialogue.get(run.id)?.status).toBe("failed");
		expect(h.state.mainCalls).toHaveLength(2);
		expect(bodies).toEqual([]);
		expect(h.dialogue.answerText(run.id)).toBeNull();
	} finally {
		await h.close();
	}
});

test("display-only citation addresses do not consume the speech allowance", async () => {
	const h = await setup();
	try {
		const answer = `雨の可能性は低い予報です。[予報](https://weather.example.com/${"path/".repeat(40)})`;
		h.state.main.push(answer);
		const run = await h.ask("提示した予報を要約して");
		expect(run.status).toBe("completed");
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.dialogue.answerText(run.id)).toBe(answer);
	} finally {
		await h.close();
	}
});

test("specialist reply length is bounded without limiting production arguments", () => {
	const content = "成果物の本文。".repeat(200);
	expect(parseSpecialistAction({ action: "reply", text: content })).toBeNull();
	expect(
		parseSpecialistAction({ action: "reply", text: "作成しました。" }),
	).toEqual({ kind: "reply", text: "作成しました。" });
	expect(
		parseSpecialistAction({
			action: "invoke",
			tool: "draft.apply",
			arguments: { content },
		}),
	).toMatchObject({ kind: "invoke", arguments: { content } });
});

test("brief speech is at most two sentences, keeping decimal values and links intact", () => {
	for (const text of [
		"一文です。",
		"確認しました。気温は25.5度です。",
		"完了しました。[結果](https://example.com/result)",
	])
		expect(isBriefSpokenReply(text)).toBe(true);
	expect(
		isBriefSpokenReply("承知しました。説明します。まずはこちらです。"),
	).toBe(false);
	expect(
		parseSpecialistAction({ action: "reply", text: "一。二。三。" }),
	).toBeNull();
});

test("artifact production retains its full body", async () => {
	const h = await setup();
	try {
		const content = "成果物の本文。".repeat(200);
		h.state.main.push(content);
		const run = await h.ask("画面に表示する原稿を作って", {
			presentation: "artifact",
		});
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe(content);
		expect(h.state.mainCalls).toHaveLength(1);
	} finally {
		await h.close();
	}
});
