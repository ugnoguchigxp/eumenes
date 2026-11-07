import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useCacheAutosave } from "./use-cache-autosave";
import type { MarkdownDraft } from "./types";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
const draft = (title: string): MarkdownDraft => ({
	documentId: "doc",
	baseRevision: 1,
	title,
	document: {
		formatVersion: 1,
		nodes: [{ type: "p", children: [{ text: title }] }],
		originalMarkdown: "\uFEFF# 原文\r\n",
	},
});
const advance = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
test("edits coalesce until idle and identical snapshots are not written again", async () => {
	vi.useFakeTimers();
	let value = draft("初稿");
	const save = vi.fn<
		(d: MarkdownDraft, m: string, id: string) => Promise<boolean>
	>(async () => true);
	const hook = renderHook(
		({ change, revision }) =>
			useCacheAutosave({
				enabled: true,
				composing: false,
				change,
				revision,
				documentId: "doc",
				snapshot: () => ({ draft: value, markdown: value.title }),
				save,
			}),
		{ initialProps: { change: 0, revision: 1 } },
	);
	await advance(400);
	value = draft("途中");
	hook.rerender({ change: 1, revision: 1 });
	await advance(600);
	expect(save).not.toHaveBeenCalled();
	value = draft("最後の入力");
	hook.rerender({ change: 2, revision: 1 });
	await advance(999);
	expect(save).not.toHaveBeenCalled();
	await advance(1);
	expect(save).toHaveBeenCalledTimes(1);
	expect(save.mock.calls[0]?.[0]).toEqual(value);
	expect(hook.result.current).toBe("saved");
	hook.rerender({ change: 2, revision: 2 });
	await advance(1000);
	expect(save).toHaveBeenCalledTimes(1);
});
test("IME composition and unavailable cache never write an intermediate snapshot", async () => {
	vi.useFakeTimers();
	const save = vi.fn(async () => true),
		snapshot = () => ({ draft: draft("変換中"), markdown: "本文" });
	const h = renderHook(
		({ enabled, composing }) =>
			useCacheAutosave({
				enabled,
				composing,
				change: 1,
				documentId: "doc",
				revision: 1,
				snapshot,
				save,
			}),
		{ initialProps: { enabled: true, composing: true } },
	);
	await advance(2000);
	expect(save).not.toHaveBeenCalled();
	h.rerender({ enabled: false, composing: false });
	await advance(2000);
	expect(save).not.toHaveBeenCalled();
	h.rerender({ enabled: true, composing: false });
	await advance(1000);
	expect(save).toHaveBeenCalledTimes(1);
});
test("cache writes serialize and a late result cannot acknowledge newer typing", async () => {
	vi.useFakeTimers();
	let resolve!: (v: boolean) => void;
	const gate = new Promise<boolean>((r) => {
		resolve = r;
	});
	let value = draft("保存開始時");
	const save = vi
		.fn<(d: MarkdownDraft, m: string, id: string) => Promise<boolean>>()
		.mockImplementationOnce(() => gate)
		.mockResolvedValue(true);
	const h = renderHook(
		({ change }) =>
			useCacheAutosave({
				enabled: true,
				composing: false,
				change,
				documentId: "doc",
				revision: 1,
				snapshot: () => ({ draft: value, markdown: value.title }),
				save,
			}),
		{ initialProps: { change: 0 } },
	);
	await advance(1000);
	expect(save).toHaveBeenCalledTimes(1);
	value = draft("保存中の追記");
	h.rerender({ change: 1 });
	await advance(1000);
	expect(save).toHaveBeenCalledTimes(1);
	expect(h.result.current).not.toBe("saved");
	await act(async () => {
		resolve(true);
		await Promise.resolve();
	});
	expect(save).toHaveBeenCalledTimes(2);
	expect(save.mock.calls[1]?.[0].title).toBe("保存中の追記");
	expect(h.result.current).toBe("saved");
});
test("failure preserves the snapshot, avoids a retry loop and reuses its request ID on a later attempt", async () => {
	vi.useFakeTimers();
	const value = draft("失敗しても残す"),
		save = vi
			.fn<(d: MarkdownDraft, m: string, id: string) => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
	const h = renderHook(
		({ change }) =>
			useCacheAutosave({
				enabled: true,
				composing: false,
				change,
				documentId: "doc",
				revision: 1,
				snapshot: () => ({ draft: value, markdown: "本文" }),
				save,
			}),
		{ initialProps: { change: 0 } },
	);
	await advance(1000);
	expect(h.result.current).toBe("error");
	await advance(10000);
	expect(save).toHaveBeenCalledTimes(1);
	h.rerender({ change: 1 });
	await advance(1000);
	expect(save.mock.calls[1]?.[2]).toBe(save.mock.calls[0]?.[2]);
	expect(h.result.current).toBe("saved");
});
