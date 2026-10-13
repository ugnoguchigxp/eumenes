import { test, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { EumenesClient } from "../../../../client";
import { useDrawingEditor } from "./useDrawingEditor";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionStorage.clear();
});
test("failed saves with full browser storage never claim the draft was retained", async () => {
	const referenceId = crypto.randomUUID(),
		id = crypto.randomUUID();
	const scene = {
		elements: [],
		appState: { viewBackgroundColor: "#ffffff" },
		files: {},
	};
	const client = {
		openDrawing: vi.fn(async () => ({
			id,
			referenceId,
			state: "ready",
			epoch: 0,
			revision: 1,
		})),
		drawingDocument: vi.fn(async () => ({
			id: crypto.randomUUID(),
			title: "図",
			revision: 1,
			scene,
		})),
		releaseDrawing: vi.fn(async () => {}),
		drawingActivity: vi.fn(async () => {}),
		saveDrawing: vi.fn(async () => {
			throw new Error("save_failed");
		}),
	} as unknown as EumenesClient;
	const { result } = renderHook(() => useDrawingEditor(client, referenceId));
	await waitFor(() => expect(result.current.drawing).not.toBeNull());
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new DOMException("full", "QuotaExceededError");
	});
	act(() => result.current.changeTitle("未保存の変更"));
	await act(async () => {
		await result.current.save();
	});
	expect(result.current.status).toBe("保存失敗");
	expect(result.current.error).toContain("下書きも保持できません");
	expect(result.current.error).not.toContain("下書きを保持しています");
	expect(result.current.hasDraft).toBe(false);
	expect(result.current.drawing).not.toBeNull();
});
