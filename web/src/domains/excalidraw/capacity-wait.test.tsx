import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import {
	capacityTimeoutMessage,
	capacityWaitingMessage,
} from "../../hooks/capacity-wait";
import { DrawingArtifact } from "./DrawingArtifact";
import { drawingDefinition } from "./drawing-definition";
import { drawingScreen } from "./resource-screen";
import { useDrawingEditor } from "./useDrawingEditor";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	sessionStorage.clear();
});
const advance = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

const referenceId = crypto.randomUUID();
const session = (state: string, extra: Record<string, unknown> = {}) => ({
	id: crypto.randomUUID(),
	referenceId,
	conversationId: "main",
	title: "図",
	state,
	errorCode: null,
	revision: 1,
	url: null,
	epoch: 0,
	lastOperation: 0,
	...extra,
});
const refused = (retryAfterMs: number | null = null) =>
	session("failed", { errorCode: "larm_capacity_busy", retryAfterMs });
const document = {
	id: crypto.randomUUID(),
	title: "図",
	revision: 1,
	scene: { elements: [], appState: {}, files: {} },
};
const pageshow = () =>
	window.dispatchEvent(
		Object.assign(new Event("pageshow"), { persisted: true }),
	);

/** A client whose session starts are refused for `refusals` tries, then succeed. */
function editorClient(refusals: number, retryAfterMs: number | null = null) {
	let tries = 0;
	const client = {
		openDrawing: vi.fn(async () => {
			tries++;
			return session("starting");
		}),
		reconnectDrawing: vi.fn(async () => {
			tries++;
			return session("starting");
		}),
		drawingSession: vi.fn(async () =>
			tries <= refusals ? refused(retryAfterMs) : session("ready"),
		),
		drawingDocument: vi.fn(async () => document),
		drawingActivity: vi.fn(async () => {}),
		releaseDrawing: vi.fn(async () => {}),
	};
	return client;
}
const editor = (client: ReturnType<typeof editorClient>) =>
	renderHook(() =>
		useDrawingEditor(client as unknown as EumenesClient, {
			kind: "reference",
			referenceId,
			conversationId: "main",
		}),
	);

test("a refused start waits with one timer, ignores a page restore, and sends the same start once after the wait", async () => {
	const client = editorClient(1, 90_000);
	const h = editor(client);
	await advance(300);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	expect(h.result.current.status).toBe(capacityWaitingMessage);
	expect(h.result.current.busy).toBe(true);
	expect(h.result.current.drawing).toBeNull();
	// The refused session holds no lease and is released.
	expect(client.releaseDrawing).toHaveBeenCalledTimes(1);
	// Neither a page restore nor the manual reconnect sends anything.
	act(() => pageshow());
	await act(async () => {
		await h.result.current.reconnect();
	});
	await h.result.current.activity();
	expect(client.reconnectDrawing).not.toHaveBeenCalled();
	expect(client.drawingActivity).not.toHaveBeenCalled();
	await advance(89_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	await advance(1_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(2);
	await advance(300);
	expect(h.result.current.drawing).not.toBeNull();
	expect(h.result.current.busy).toBe(false);
	await advance(10 * 60_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(2);
});

test("after 30 minutes from the first refusal it stops with the timeout and does not send again", async () => {
	const client = editorClient(Infinity);
	const h = editor(client);
	for (let i = 0; i < 70; i++) await advance(30_250);
	// Each try polls the session for 250 ms; the 61st would pass the limit counted from the first refusal.
	expect(client.openDrawing).toHaveBeenCalledTimes(60);
	expect(h.result.current.error).toBe(capacityTimeoutMessage);
	expect(h.result.current.busy).toBe(false);
	await advance(10 * 60_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(60);
});

test("closing the editor while waiting stops the timer", async () => {
	const client = editorClient(Infinity);
	const h = editor(client);
	await advance(300);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	h.unmount();
	await advance(10 * 60_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
});

test("a refused reconnect waits the same way, with the manual reconnect and activity doing nothing", async () => {
	const client = editorClient(0);
	const h = editor(client);
	await advance(300);
	expect(h.result.current.drawing).not.toBeNull();
	// From now on LARM has no memory for the next start.
	let refusing = true;
	client.drawingSession.mockImplementation(async () =>
		refusing ? refused() : session("ready"),
	);
	await act(async () => {
		void h.result.current.reconnect();
		await vi.advanceTimersByTimeAsync(300);
	});
	expect(client.reconnectDrawing).toHaveBeenCalledTimes(1);
	expect(h.result.current.status).toBe(capacityWaitingMessage);
	await act(async () => {
		await h.result.current.reconnect();
	});
	await h.result.current.activity();
	expect(client.reconnectDrawing).toHaveBeenCalledTimes(1);
	expect(client.drawingActivity).not.toHaveBeenCalled();
	refusing = false;
	await advance(30_000);
	expect(client.reconnectDrawing).toHaveBeenCalledTimes(2);
	expect(h.result.current.error).toBe("");
});

test("a refused save keeps the draft, sends the same key once after the wait, and the editor saves nothing else meanwhile", async () => {
	const client = Object.assign(editorClient(0), {
		saveDrawing: vi
			.fn()
			.mockRejectedValueOnce(
				new ApiError(503, "larm_capacity_busy", undefined, undefined, {
					error: "larm_capacity_busy",
					retryAfterMs: 45_000,
				}),
			)
			.mockImplementation(async () => ({ ...document, revision: 2 })),
	});
	const h = editor(client);
	await advance(300);
	act(() => h.result.current.changeTitle("変更"));
	await act(async () => {
		await h.result.current.save();
	});
	expect(client.saveDrawing).toHaveBeenCalledTimes(1);
	expect(h.result.current.status).toBe(capacityWaitingMessage);
	expect(h.result.current.busy).toBe(true);
	await act(async () => {
		await h.result.current.save();
	});
	await advance(44_000);
	expect(client.saveDrawing).toHaveBeenCalledTimes(1);
	await advance(1_000);
	expect(client.saveDrawing).toHaveBeenCalledTimes(2);
	expect(client.saveDrawing.mock.calls[1]![2]).toBe(
		client.saveDrawing.mock.calls[0]![2],
	);
	expect(h.result.current.busy).toBe(false);
});

test("the drawing screen sends a refused open once after the wait, and unmounting stops the timer", async () => {
	let refusing = true;
	const client = {
		identity: crypto.randomUUID(),
		drawingReferences: vi.fn(async () => [
			{ id: referenceId, title: "図A", revision: 2 },
		]),
		drawingOperations: vi.fn(async () => []),
		drawingSession: vi.fn(async () =>
			refusing ? refused(60_000) : session("ready"),
		),
		openDrawing: vi.fn(async () => session("starting")),
		releaseDrawing: vi.fn(async () => {}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={cache}>
			<DrawingArtifact
				client={client as never}
				definition={drawingDefinition}
			/>
		</QueryClientProvider>,
	);
	await advance(10);
	await act(async () => {
		void drawingScreen.focus?.(referenceId);
		await vi.advanceTimersByTimeAsync(100);
	});
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	expect(view.container.textContent).toContain(capacityWaitingMessage);
	await advance(59_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	refusing = false;
	await advance(1_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(2);
	await advance(10 * 60_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(2);

	// Closing the artifact while waiting sends nothing more.
	refusing = true;
	await act(async () => {
		void drawingScreen.focus?.(referenceId);
		await vi.advanceTimersByTimeAsync(100);
	});
	view.unmount();
	const opened = client.openDrawing.mock.calls.length;
	await advance(10 * 60_000);
	expect(client.openDrawing).toHaveBeenCalledTimes(opened);
});
