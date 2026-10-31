import { expect, test } from "vitest";
import {
	equalsSaved,
	parseWire,
	reviewRows,
	toWire,
	type DocumentAccess,
	type RegisteredField,
} from "./documents";
import { createDraftStore, draftStoreFor, type DraftEntry } from "./drafts";

import { findActionBinding } from "./screen-dispatch";

const field = (extra: Partial<RegisteredField> = {}): RegisteredField => ({
	fieldId: "a.b",
	document: "document:test@1",
	path: "$.a.b",
	label: "項目",
	control: "text",
	section: "画面",
	artifactRevisionId: "artifact:test.screen@1",
	sources: [],
	...extra,
});
const rule = (f: RegisteredField) => ({
	options: f.options,
	min: f.min,
	max: f.max,
	step: f.step,
	maxLength: f.maxLength,
});

test("a field accepts only the registered kind of value", () => {
	const number = field({ control: "number", min: 300, max: 3000, step: 100 });
	expect(parseWire(number, rule(number), "1800")).toEqual({
		ok: true,
		change: { value: 1800 },
	});
	for (const bad of ["100", "5000", "300.5", "", "NaN", " "])
		expect(parseWire(number, rule(number), bad).ok).toBe(false);
	expect(parseWire(number, rule(number), 5).ok).toBe(false);

	const toggle = field({ control: "toggle" });
	expect(parseWire(toggle, rule(toggle), "false")).toEqual({
		ok: true,
		change: { value: false },
	});
	expect(parseWire(toggle, rule(toggle), "1").ok).toBe(false);

	const select = field({
		control: "select",
		options: [{ value: "x", label: "X" }],
	});
	expect(parseWire(select, rule(select), "x").ok).toBe(true);
	expect(parseWire(select, rule(select), "y").ok).toBe(false);

	const multiple = field({
		control: "multiple",
		options: [
			{ value: "ja", label: "日本語" },
			{ value: "en", label: "英語" },
		],
	});
	expect(parseWire(multiple, rule(multiple), '["ja","en"]').ok).toBe(true);
	for (const bad of ["[]", '["ja","ja"]', '["fr"]', "ja", "{}"])
		expect(parseWire(multiple, rule(multiple), bad).ok).toBe(false);

	const text = field({ maxLength: 3, unset: "delete-key" });
	expect(parseWire(text, rule(text), "abc").ok).toBe(true);
	expect(parseWire(text, rule(text), "abcd").ok).toBe(false);
	expect(parseWire(text, rule(text), "")).toEqual({
		ok: true,
		change: { unset: true },
	});
});

test("unset equals an absent key, and a value equals only itself", () => {
	expect(equalsSaved({ unset: true }, undefined)).toBe(true);
	expect(equalsSaved({ unset: true }, "x")).toBe(false);
	expect(equalsSaved({ value: [1, 2] }, [1, 2])).toBe(true);
	expect(equalsSaved({ value: 1 }, "1")).toBe(false);
	expect(toWire(["a"])).toBe('["a"]');
	expect(toWire(undefined)).toBe("");
});

test("the review compares saved and draft values and shows secrets only as a count", () => {
	const store = createDraftStore();
	const label = field({
		fieldId: "t",
		path: "$.t",
		control: "select",
		label: "テーマ",
		options: [
			{ value: "light", label: "ライト" },
			{ value: "dark", label: "ダーク" },
		],
	});
	const secret = field({
		fieldId: "k",
		path: "$.k",
		label: "キー",
		confidential: true,
	});
	store.set({ fieldId: "t", change: { value: "dark" } });
	store.set({
		fieldId: "k",
		change: { value: "sk-very-secret" },
		confidential: true,
	});
	store.set({ fieldId: "same", change: { value: "light" } });
	const access = {
		read: (f: { path: string }) =>
			f.path === "$.t" || f.path === "$.same" ? "light" : undefined,
		rule: () => null,
		targets: () => [],
	} as unknown as DocumentAccess;
	const rows = reviewRows(
		store.getView(),
		[label, secret, field({ fieldId: "same", path: "$.same" })],
		access,
	);
	expect(rows).toEqual([
		{ id: "t", label: "画面 / テーマ", before: "ライト", after: "ダーク" },
		{
			id: "credentials",
			label: "認証情報",
			before: "現在の認証情報",
			after: "更新・削除予定 1件",
		},
	]);
	expect(JSON.stringify(store.getView())).not.toContain("sk-very-secret");
});

test("settling keeps what changed while saving and forgets only what was sent", () => {
	const store = createDraftStore();
	store.set({ fieldId: "a", change: { value: 1 } });
	store.set({ fieldId: "b", change: { value: 2 } });
	const frozen = store.freeze(() => true)!;
	expect(store.getView().busy).toBe(true);
	expect(store.freeze(() => true)).toBeNull();
	store.set({ fieldId: "b", change: { value: 3 } });
	store.set({ fieldId: "c", change: { value: 4 } });
	store.settle(frozen, "applied");
	expect(store.getView().busy).toBe(false);
	expect(
		store.getView().entries.map((e: DraftEntry) => [e.fieldId, e.change]),
	).toEqual([
		["b", { value: 3 }],
		["c", { value: 4 }],
	]);
	const again = store.freeze(() => true)!;
	store.settle(again, "kept");
	expect(store.getView().entries).toHaveLength(2);
	expect(store.discard()).toBe(true);
	expect(store.getView().entries).toEqual([]);
});

test("one draft per identity and document is shared by every screen", () => {
	expect(draftStoreFor("i1", "document:a@1")).toBe(
		draftStoreFor("i1", "document:a@1"),
	);
	expect(draftStoreFor("i1", "document:a@1")).not.toBe(
		draftStoreFor("i2", "document:a@1"),
	);
	expect(draftStoreFor("i1", "document:a@1")).not.toBe(
		draftStoreFor("i1", "document:b@1"),
	);
});

test("an event picks the binding of its source, else the only binding of that event", () => {
	const base = {
		inputSchemaRef: "builtin:emptyInput",
		effect: "local" as const,
	};
	const bindings = [
		{
			...base,
			actionId: "action",
			eventAction: "settings-action",
			source: "voice",
		},
		{
			...base,
			actionId: "solo",
			eventAction: "settings-apply",
			source: "other",
		},
	];
	const ev = (action: string, source: string) => ({ action, source }) as never;
	expect(
		findActionBinding(bindings, ev("settings-action", "voice"))?.actionId,
	).toBe("action");
	expect(
		findActionBinding(bindings, ev("settings-apply", "elsewhere"))?.actionId,
	).toBe("solo");
	expect(
		findActionBinding(bindings, ev("settings-edit", "voice")),
	).toBeUndefined();
});

test("rows of fields no loaded screen registered stay hidden until the screens are read", () => {
	const store = createDraftStore();
	store.set({ fieldId: "later", change: { value: "x" } });
	const access = {
		read: () => undefined,
		rule: () => null,
		targets: () => [],
	} as unknown as DocumentAccess;
	expect(reviewRows(store.getView(), [], access, false)).toEqual([]);
	expect(reviewRows(store.getView(), [], access, true)).toEqual([
		{
			id: "later",
			label: "未登録の項目 / later",
			before: "サービスの標準",
			after: "x",
		},
	]);
});
