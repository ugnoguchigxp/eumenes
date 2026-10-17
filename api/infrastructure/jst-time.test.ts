import { expect, test } from "bun:test";
import { jstDisplay, jstIso, parseTimeJst } from "./jst-time";

test("jstIso writes JST with its offset and the same instant", () => {
	const ms = Date.parse("2026-10-17T20:15:00.123Z");
	expect(jstIso(ms)).toBe("2026-10-18T05:15:00.123+09:00");
	expect(Date.parse(jstIso(ms))).toBe(ms);
	expect(jstDisplay(ms)).toBe("2026-10-18 05:15:00");
});

test("a time without a zone is JST while Z and offsets keep their own zone", () => {
	const ms = Date.parse("2026-10-17T20:15:00.000Z");
	expect(parseTimeJst("2026-10-18T05:15")).toBe(ms);
	expect(parseTimeJst("2026-10-18T05:15:00")).toBe(ms);
	expect(parseTimeJst("2026-10-18T05:15:00.000+09:00")).toBe(ms);
	expect(parseTimeJst("2026-10-17T20:15:00Z")).toBe(ms);
	expect(parseTimeJst("2026-10-18")).toBe(Date.parse("2026-10-17T15:00:00Z"));
	expect(parseTimeJst("nonsense")).toBeNaN();
});
