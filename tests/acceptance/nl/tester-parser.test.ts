import { describe, expect, test } from "bun:test";
import {
	parseTesterOutput,
	scriptedTester,
} from "../../../scripts/nl-acceptance/tester";

const ok = (text: string) => {
	const r = parseTesterOutput(text);
	if (!r.ok) throw new Error(`${r.kind}:${r.detail}`);
	return r.action;
};

describe("tester output parser", () => {
	test("accepts the six screen operations", () => {
		expect(ok('{"action":"click","ref":"e12","reason":"開始を押す"}')).toEqual({
			action: "click",
			ref: "e12",
			reason: "開始を押す",
		});
		expect(
			ok('{"action":"fill","ref":"e7","text":"3","reason":"分"}'),
		).toMatchObject({ action: "fill", ref: "e7", text: "3" });
		expect(ok('{"action":"press","text":"Enter","reason":""}')).toMatchObject({
			action: "press",
			text: "Enter",
		});
		expect(
			ok('{"action":"wait","text":"3","reason":"減るのを待つ"}'),
		).toMatchObject({ action: "wait", text: "3" });
		expect(ok('{"action":"done","reason":"できた"}').action).toBe("done");
		expect(ok('{"action":"give_up","reason":"押せない"}').action).toBe(
			"give_up",
		);
	});

	test("finds the object in fenced or chatty output and ignores extra keys", () => {
		expect(
			ok('```json\n{"action":"click","ref":"e1","reason":"r","extra":1}\n```')
				.action,
		).toBe("click");
		expect(
			ok('次の操作です。{"action":"done","reason":"a {brace} inside"} 以上')
				.action,
		).toBe("done");
	});

	test("a missing reason is tolerated, but required fields are enforced", () => {
		expect(ok('{"action":"done"}').reason).toBe("");
		expect(parseTesterOutput('{"action":"click","reason":"x"}')).toMatchObject({
			ok: false,
			detail: "ref_required",
		});
		expect(
			parseTesterOutput('{"action":"fill","ref":"e1","reason":"x"}'),
		).toMatchObject({ ok: false, detail: "text_required" });
		expect(parseTesterOutput('{"action":"press","reason":"x"}')).toMatchObject({
			ok: false,
			detail: "text_required",
		});
	});

	test("rejects malformed output without throwing", () => {
		for (const text of [
			"",
			"ok",
			"{",
			'{"action":',
			"[1]",
			'{"action":3}',
			'{"action":"click","ref":"a b","reason":"x"}',
		])
			expect(parseTesterOutput(text).ok).toBe(false);
	});

	test("wait is limited to 15 seconds", () => {
		expect(
			parseTesterOutput('{"action":"wait","text":"16","reason":""}'),
		).toMatchObject({ ok: false, detail: "wait_out_of_range" });
		expect(
			parseTesterOutput('{"action":"wait","text":"abc","reason":""}').ok,
		).toBe(false);
	});

	test("asking for evaluate, navigation or API access is forbidden, not retried", () => {
		for (const action of [
			"evaluate",
			"goto",
			"navigate",
			"fetch",
			"api",
			"route",
			"eval",
			"open_url",
		])
			expect(
				parseTesterOutput(`{"action":"${action}","text":"x","reason":""}`),
			).toEqual({ ok: false, kind: "forbidden", detail: action });
	});

	test("an unlisted but harmless action is a format error", () => {
		expect(parseTesterOutput('{"action":"scroll","reason":""}')).toEqual({
			ok: false,
			kind: "parse",
			detail: "unknown_action",
		});
	});

	test("the scripted adapter replays its replies and repeats the last", async () => {
		const t = scriptedTester(["a", "b"]);
		const signal = new AbortController().signal;
		const call = () => t.decide({} as never, signal).then((r) => r.text);
		expect([await call(), await call(), await call()]).toEqual(["a", "b", "b"]);
	});
});
