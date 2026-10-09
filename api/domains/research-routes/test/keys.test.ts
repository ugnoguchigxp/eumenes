import { expect, test } from "bun:test";
import { bindRequest, buildSearchSpec } from "../service/keys";

const m = (q: string) => {
	const r = buildSearchSpec(q);
	if (r.kind !== "matched") throw new Error(`${q}:${r.kind}`);
	return r;
};

test("K02 equivalent Kamakura phrasings share key and query; Shizuoka city differs", () => {
	const a = m("天気予報 鎌倉"),
		b = m("鎌倉の天気を教えて"),
		c = m("鎌倉市の天気"),
		d = m("鎌倉 今日の天気");
	expect(a.spec.keywords).toBe("天気予報 鎌倉");
	for (const x of [b, c, d]) expect(x.key).toBe(a.key);
	const s = m("天気予報 静岡市");
	expect(s.key).not.toBe(a.key);
	expect(s.spec.keywords).toBe("天気予報 静岡市");
	expect(buildSearchSpec("天気予報 静岡").kind).toBe("ambiguous");
	expect(buildSearchSpec("静岡の天気").kind).toBe("ambiguous");
	expect(buildSearchSpec("天気予報 横浜").kind).toBe("unsupported");
});

test("K02 time mode and required fields produce distinct keys", () => {
	const today = m("天気予報 鎌倉").key;
	const tomorrow = m("鎌倉 明日の天気").key;
	const abs = m("鎌倉 2026-10-10 の天気");
	const temp = m("鎌倉 明日の天気 最高気温");
	const both = m("天気予報 鎌倉 明日 最高気温 最低気温");
	expect(new Set([today, tomorrow, abs.key, temp.key, both.key]).size).toBe(5);
	expect(abs.spec.keywords).toBe("天気予報 鎌倉 2026-10-10");
	expect(temp.spec.keywords).toBe("天気予報 鎌倉 明日 最高気温");
	expect(m("　天気予報　　鎌倉　").key).toBe(today);
	expect(buildSearchSpec("鎌倉 2026-02-30 の天気").kind).toBe("unsupported");
});

test("K02 quotes keep ticker characters and reject unconfirmed/compound input", () => {
	const a = m("株価 AAPL");
	expect(a.spec.keywords).toBe("株価 AAPL NASDAQ USD regular");
	expect(m("AAPLの株価を教えて").key).toBe(a.key);
	expect(m("株価 AAPL NASDAQ USD").key).toBe(a.key);
	expect(buildSearchSpec("株価 AAPL NYSE").kind).toBe("unsupported");
	expect(buildSearchSpec("株価 BRK.B").kind).toBe("unsupported");
	expect(buildSearchSpec("株価 aapl").kind).toBe("unsupported");
	expect(buildSearchSpec("株価 AAPL と MSFT を比較").kind).toBe("unsupported");
	expect(buildSearchSpec("「天気予報 鎌倉」と言って").kind).toBe("unsupported");
	expect(buildSearchSpec("鎌倉の天気を教えて、それと傘も").kind).toBe(
		"unsupported",
	);
});

test("K02 binding fixes the target date at acceptance", () => {
	const spec = m("鎌倉 明日の天気").spec;
	const at = Date.parse("2026-10-09T14:59:00Z"); // 23:59 JST
	const b = bindRequest(spec, at);
	expect(b.expectedDate).toBe("2026-10-10");
	// Re-reading the binding two minutes later (00:01 JST) does not change it.
	expect(b).toEqual(bindRequest(spec, at));
	expect(bindRequest(spec, at + 120_000).expectedDate).toBe("2026-10-11");
	expect(bindRequest(m("天気予報 鎌倉").spec, at).expectedDate).toBe(
		"2026-10-09",
	);
	expect(bindRequest(m("鎌倉 2026-12-01 の天気").spec, at).expectedDate).toBe(
		"2026-12-01",
	);
	expect(bindRequest(m("株価 AAPL").spec, at).expectedDate).toBeNull();
});
