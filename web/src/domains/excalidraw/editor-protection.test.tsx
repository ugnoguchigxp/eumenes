import { test, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { EumenesClient } from "../../../../client";
import { useDrawingEditor } from "./useDrawingEditor";
const at = (referenceId: string, conversationId = "main") => ({
	kind: "reference" as const,
	referenceId,
	conversationId,
});
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
	const { result } = renderHook(() =>
		useDrawingEditor(client, at(referenceId)),
	);
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
		drawingDocument: vi.fn(
			async (_sessionId: string, _signal?: AbortSignal) => document,
		),
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
test("opening an idle session still loads the document through the lease-aware API", async () => {
	const h = editorClient();
	const sessionId = crypto.randomUUID();
	h.port.openDrawing.mockResolvedValueOnce({
		id: sessionId,
		referenceId: h.referenceId,
		state: "idle",
		epoch: 0,
		revision: 1,
	});
	const { result } = renderHook(() =>
		useDrawingEditor(h.client, at(h.referenceId)),
	);
	await waitFor(() => expect(result.current.drawing?.id).toBe(h.document.id));
	expect(result.current.title).toBe(h.document.title);
	expect(result.current.error).toBe("");
	expect(h.port.drawingDocument.mock.calls[0]?.[0]).toBe(sessionId);
});
test("disabled browser storage still permits loading and confirmed upstream saving", async () => {
	const h = editorClient();
	vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
		throw new DOMException("disabled", "SecurityError");
	});
	const { result } = renderHook(() =>
		useDrawingEditor(h.client, at(h.referenceId)),
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
		useDrawingEditor(h.client, at(h.referenceId)),
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
		useDrawingEditor(h.client, at(h.referenceId, "design")),
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
test("a new drawing stores nothing until its first save creates it, then saves as a reference", async () => {
	const draftId = crypto.randomUUID(),
		referenceId = crypto.randomUUID(),
		id = crypto.randomUUID(),
		documentId = crypto.randomUUID();
	window.history.replaceState(
		null,
		"",
		`/excalidraw?embedded=1#drawing/new/${draftId}?title=x&conversationId=design`,
	);
	const session = {
		id,
		referenceId: null,
		state: "ready",
		epoch: 0,
		revision: null,
	};
	const client = {
		openDrawing: vi.fn(async () => session),
		drawingSession: vi.fn(async () => session),
		createDrawing: vi.fn(
			async (_id: string, input: { title: string; scene: unknown }) => ({
				referenceId,
				id: documentId,
				revision: 1,
				...input,
			}),
		),
		saveDrawing: vi.fn(
			async (
				_id: string,
				input: { title: string; scene: unknown; expectedRevision: number },
			) => ({
				id: documentId,
				revision: input.expectedRevision + 1,
				title: input.title,
				scene: input.scene,
			}),
		),
		drawingActivity: vi.fn(async () => {}),
		releaseDrawing: vi.fn(async () => {}),
	} as unknown as EumenesClient;
	const { result } = renderHook(() =>
		useDrawingEditor(client, {
			kind: "new",
			draftId,
			title: "構成図",
			conversationId: "design",
		}),
	);
	await waitFor(() => expect(result.current.drawing).not.toBeNull());
	expect(result.current.title).toBe("構成図");
	expect(result.current.busy).toBe(false);
	// Opening, saving without edits and leaving never reach the host.
	await act(async () => {
		await result.current.save();
	});
	expect(await result.current.leaveFrame()).toBe(true);
	expect(client.openDrawing).not.toHaveBeenCalled();
	expect(client.createDrawing).not.toHaveBeenCalled();
	act(() => result.current.changeTitle("構成図 v1"));
	await act(async () => {
		await result.current.save();
	});
	expect(client.openDrawing).toHaveBeenCalledWith(
		expect.objectContaining({ conversationId: "design", title: "構成図 v1" }),
		expect.anything(),
	);
	expect(client.createDrawing).toHaveBeenCalledWith(
		id,
		{ title: "構成図 v1", scene: expect.anything() },
		expect.any(String),
		expect.anything(),
	);
	expect(result.current.referenceId).toBe(referenceId);
	expect(result.current.frameId).toBe(referenceId);
	expect(window.location.hash).toBe(
		`#drawing/${referenceId}?revision=1&conversationId=design`,
	);
	act(() => result.current.changeTitle("構成図 v2"));
	// Unsaved edits after creation are protected under the reference, not the draft id.
	expect(
		sessionStorage.getItem(`eumenes-excalidraw-draft:${draftId}`),
	).toBeNull();
	expect(
		sessionStorage.getItem(`eumenes-excalidraw-draft:${referenceId}`),
	).not.toBeNull();
	await act(async () => {
		await result.current.save();
	});
	expect(client.createDrawing).toHaveBeenCalledTimes(1);
	expect(client.saveDrawing).toHaveBeenCalledWith(
		id,
		expect.objectContaining({ title: "構成図 v2", expectedRevision: 1 }),
		expect.any(String),
	);
	expect(result.current.status).toBe("保存済み（版 2）");
	window.history.replaceState(null, "", "/");
});
