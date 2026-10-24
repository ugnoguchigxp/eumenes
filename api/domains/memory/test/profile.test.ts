import { expect, test } from "bun:test";
import {
	keepOrder,
	lastTokyoDay,
	profileItemFields,
	publishedOrder,
	tokyoDay,
	type ProfileItem,
} from "../service/profile";

const item = (
	id: string,
	kind: string,
	newness: number,
	extra: Partial<ProfileItem> = {},
): ProfileItem => ({
	id,
	kind,
	text: id,
	negated: false,
	source: kind === "tendency" ? "observed" : "user_said",
	revision: 1,
	newness,
	...extra,
});

test("the published order keeps the previous items in place and appends new ones to their kind, oldest first", () => {
	const items = [
		item("p-new2", "preference", 9),
		item("habit", "habit", 1),
		item("p-old", "preference", 2),
		item("c", "constraint", 3),
		item("p-new1", "preference", 8),
		item("t", "tendency", 5),
		item("p-first", "preference", 7),
	];
	const order = publishedOrder(items, ["p-first", "p-old", "c"]).map(
		(i) => i.id,
	);
	expect(order).toEqual([
		"c",
		"p-first",
		"p-old",
		"p-new1",
		"p-new2",
		"habit",
		"t",
	]);
	// The same input gives the same order, whatever the input order.
	expect(
		publishedOrder([...items].reverse(), ["p-first", "p-old", "c"]).map(
			(i) => i.id,
		),
	).toEqual(order);
});

test("the keep order is kinds first, newest first inside a kind (never the showing order)", () => {
	const items = [
		item("p-old", "preference", 1),
		item("t", "tendency", 99),
		item("p-new", "preference", 9),
		item("c", "constraint", 0),
	];
	expect(keepOrder(items).map((i) => i.id)).toEqual([
		"c",
		"p-new",
		"p-old",
		"t",
	]);
});

test("an item shows its text, source and absolute days; hidden fields stay out", () => {
	expect(
		profileItemFields(
			item("st_1", "constraint", 3, {
				text: "平日夜は通知を控える",
				negated: true,
				since: "2026-09",
				until: "2026-12-31",
				untilMs: 1,
			}),
		),
	).toEqual({
		id: "st_1",
		kind: "constraint",
		text: "平日夜は通知を控える",
		negated: true,
		source: "user_said",
		since: "2026-09",
		until: "2026-12-31",
	});
	expect(profileItemFields(item("t", "tendency", 1))).toEqual({
		id: "t",
		kind: "tendency",
		text: "t",
		source: "observed",
	});
});

test("days are Asia/Tokyo calendar days; an exclusive end shows its last day", () => {
	// 2026-10-13T15:00Z is 2026-10-14 00:00 in Tokyo.
	expect(tokyoDay(Date.parse("2026-10-13T15:00:00Z"))).toBe("2026-10-14");
	expect(lastTokyoDay(Date.parse("2026-10-13T15:00:00Z"))).toBe("2026-10-13");
});
