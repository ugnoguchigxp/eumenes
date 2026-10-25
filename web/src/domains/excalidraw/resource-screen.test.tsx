import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DrawingArtifact } from "./DrawingArtifact";
import { drawingDefinition } from "./drawing-definition";
import { drawingScreen } from "./resource-screen";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const reference = crypto.randomUUID();
const other = crypto.randomUUID();

function mount(openDrawing?: ReturnType<typeof vi.fn>) {
	const session = (referenceId: string) => ({
		id: crypto.randomUUID(),
		referenceId,
		conversationId: "main",
		title: "図",
		state: "ready",
		errorCode: null,
		revision: 1,
		url: `${window.location.origin}/#drawing/${referenceId}`,
		epoch: 1,
		lastOperation: 0,
	});
	const client = {
		identity: crypto.randomUUID(),
		drawingReferences: vi.fn(async () => [
			{ id: reference, title: "図A", revision: 2 },
			{ id: other, title: "図B", revision: 1 },
		]),
		drawingOperations: vi.fn(async () => []),
		drawingSession: vi.fn(async () => session(reference)),
		openDrawing:
			openDrawing ??
			vi.fn(async (input: { referenceId: string }) =>
				session(input.referenceId),
			),
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
	return { client, cache, view };
}

test("focus opens the saved drawing in the editor, marks the screen for two seconds and viewing names it", async () => {
	const { client, view } = mount();
	await waitFor(() => expect(client.drawingReferences).toHaveBeenCalled());
	expect(drawingScreen.viewing?.()).toBeNull();
	await expect(drawingScreen.focus?.(reference)).resolves.toBe(true);
	expect(client.openDrawing).toHaveBeenCalledWith(
		expect.objectContaining({ referenceId: reference }),
	);
	expect(drawingScreen.viewing?.()).toBe(`eumenes://drawing/${reference}`);
	const screen = view.container.querySelector(".drawing-artifact")!;
	expect(screen.getAttribute("data-resource-focus")).toBe("true");
	// The drawing is already open: nothing is connected again.
	await drawingScreen.focus?.(reference);
	expect(client.openDrawing).toHaveBeenCalledTimes(1);
	await waitFor(
		() => expect(screen.hasAttribute("data-resource-focus")).toBe(false),
		{ timeout: 3_000 },
	);
});

test("focus says no to a drawing the screen lacks or one that cannot be connected", async () => {
	const failing = vi.fn(async () => {
		throw new Error("down");
	});
	const { client } = mount(failing);
	await waitFor(() => expect(client.drawingReferences).toHaveBeenCalled());
	await expect(drawingScreen.focus?.(other)).resolves.toBe(false);
	expect(drawingScreen.viewing?.()).toBeNull();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const unknown = drawingScreen.focus?.(crypto.randomUUID());
	await act(async () => {
		await vi.advanceTimersByTimeAsync(5_500);
	});
	await expect(unknown).resolves.toBe(false);
});
