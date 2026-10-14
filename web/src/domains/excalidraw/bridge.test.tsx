import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useDrawingBridge } from "./useDrawingBridge";
import type { useDrawingEditor } from "./useDrawingEditor";

afterEach(() => {
	cleanup();
	window.history.replaceState(null, "", "/");
});
const editor = { drawing: { revision: 3 } } as ReturnType<
	typeof useDrawingEditor
>;
test("an embedded editor reloads its confirmed revision and retains the conversation", () => {
	const referenceId = crypto.randomUUID();
	window.history.replaceState(
		null,
		"",
		`/excalidraw?embedded=1#drawing/${referenceId}?revision=1&conversationId=design`,
	);
	renderHook(() => useDrawingBridge(true, referenceId, editor));
	expect(window.location.pathname).toBe("/excalidraw");
	expect(window.location.search).toBe("?embedded=1");
	expect(window.location.hash).toBe(
		`#drawing/${referenceId}?revision=3&conversationId=design`,
	);
});
test("a standalone historical link keeps its requested revision", () => {
	const referenceId = crypto.randomUUID();
	window.history.replaceState(null, "", `/#drawing/${referenceId}?revision=1`);
	renderHook(() => useDrawingBridge(false, referenceId, editor));
	expect(window.location.hash).toBe(`#drawing/${referenceId}?revision=1`);
});
