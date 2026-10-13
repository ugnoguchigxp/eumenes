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

function editorClient() {
	const referenceId = crypto.randomUUID();
	const document = {
		id: crypto.randomUUID(),
		title: "図",
		revision: 1,
		scene: { elements: [], appState: {}, files: {} },
	};
	const port = {
		openDrawing: vi.fn(
			async (_input: {
				requestId: string;
				referenceId?: string;
				conversationId?: string;
				revision?: number;
			}) => ({
				id: crypto.randomUUID(),
				referenceId,
				state: "ready",
				epoch: 0,
				revision: 1,
			}),
		),
		drawingDocument: vi.fn(async () => document),
		drawingSession: vi.fn(async () => {
			throw new Error("status_unavailable");
		}),
		releaseDrawing: vi.fn(async () => {}),
		drawingActivity: vi.fn(async () => {}),
		saveDrawing: vi.fn(
			async (
				_id: string,
				input: {
					title: string;
					scene: typeof document.scene;
					expectedRevision: number;
				},
			) => ({ ...document, ...input, revision: input.expectedRevision + 1 }),
		),
	};
	return {
		referenceId,
		document,
		port,
		client: port as unknown as EumenesClient,
	};
}
test("disabled browser storage still permits loading and confirmed upstream saving", async () => {
	const h = editorClient();
	vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
		throw new DOMException("disabled", "SecurityError");
	});
	const { result } = renderHook(() =>
		useDrawingEditor(h.client, h.referenceId),
	);
	await waitFor(() => expect(result.current.drawing?.id).toBe(h.document.id));
	act(() => result.current.changeTitle("保存可能"));
	await act(async () => {
		await result.current.save();
	});
	expect(result.current.status).toBe("保存済み（版 2）");
	expect(result.current.error).toContain("図は保存済み");
	expect(result.current.error).not.toContain("保存に失敗");
});
test("failure to remove a local draft does not turn a confirmed save into a failed mutation", async () => {
	const h = editorClient();
	const { result } = renderHook(() =>
		useDrawingEditor(h.client, h.referenceId),
	);
	await waitFor(() => expect(result.current.drawing).not.toBeNull());
	vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
		throw new DOMException("disabled", "SecurityError");
	});
	act(() => result.current.changeTitle("保存した図"));
	await act(async () => {
		await result.current.save();
	});
	expect(result.current.status).toBe("保存済み（版 2）");
	expect(result.current.error).toContain("下書きを削除できません");
	expect(h.port.saveDrawing).toHaveBeenCalledTimes(1);
});
test("returning from browser history starts a new owned session while preserving unsaved edits and conversation", async () => {
	const h = editorClient();
	const { result } = renderHook(() =>
		useDrawingEditor(h.client, h.referenceId, undefined, "design"),
	);
	await waitFor(() => expect(result.current.drawing).not.toBeNull());
	const first = result.current.session!.id;
	act(() => {
		result.current.changeTitle("復帰する下書き");
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		);
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
	});
	await waitFor(() => expect(result.current.session?.id).not.toBe(first));
	expect(result.current.title).toBe("復帰する下書き");
	expect(h.port.openDrawing).toHaveBeenCalledTimes(2);
	expect(h.port.openDrawing.mock.calls[1]?.[0]).toMatchObject({
		conversationId: "design",
		referenceId: h.referenceId,
		revision: 1,
	});
	expect(h.port.drawingDocument).toHaveBeenCalledTimes(1);
	await act(async () => {
		await result.current.save();
	});
	expect(h.port.saveDrawing.mock.calls[0]?.[0]).toBe(
		result.current.session!.id,
	);
	expect(result.current.status).toBe("保存済み（版 2）");
});
