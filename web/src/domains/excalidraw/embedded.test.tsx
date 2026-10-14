import {
	ArtifactRenderer,
	type ArtifactEvent,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	render,
	screen,
	cleanup,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
afterEach(cleanup);
const definition = JSON.stringify({ view: "drawing-workspace", source: "d" });
function show(url: string) {
	const snapshot: Snapshot = {
		d: {
			kind: "drawing-workspace",
			revision: 1,
			status: "利用可能",
			url,
			references: [{ id: "other", title: "別の図", revision: 2 }],
		},
	};
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "accepted" as const,
		message: "受付",
	}));
	render(
		<div data-artifact-tab="d">
			<ArtifactRenderer
				definition={definition}
				runtime={{ snapshot, dispatch }}
			/>
		</div>,
	);
	return dispatch;
}
test.each([
	`https://external.example/#drawing/${crypto.randomUUID()}`,
	`${window.location.origin}/#drawing/${crypto.randomUUID()}?token=secret`,
	`${window.location.origin}/#drawing/${crypto.randomUUID()}?revision=0`,
	`${window.location.origin}/#drawing/${crypto.randomUUID()}?conversationId=`,
	`${window.location.origin}/#drawing/${crypto.randomUUID()}?revision=1&revision=2`,
])("an unsafe or ambiguous editor URL never becomes an iframe: %s", (url) => {
	show(url);
	expect(screen.queryByTitle("Excalidraw編集画面")).toBeNull();
});
test("foreign frame messages cannot alter controls; unsaved state refuses selection and tab closing", async () => {
	const id = crypto.randomUUID();
	const dispatch = show(
		`${window.location.origin}/#drawing/${id}?conversationId=design%20review`,
	);
	const frame = (await screen.findByTitle(
		"Excalidraw編集画面",
	)) as HTMLIFrameElement;
	expect(frame.src).toContain("conversationId=design%20review");
	const state = {
		type: "eumenes:drawing-state",
		referenceId: id,
		title: "編集中",
		status: "未保存",
		error: "",
		busy: false,
		hasDraft: true,
		dirty: true,
		loaded: true,
	};
	// A queued message from the previously loaded drawing cannot describe this frame.
	fireEvent(
		window,
		new MessageEvent("message", {
			origin: window.location.origin,
			source: frame.contentWindow,
			data: { ...state, referenceId: crypto.randomUUID() },
		}),
	);
	expect(screen.queryByLabelText("図の名前")).toBeNull();
	fireEvent(
		window,
		new MessageEvent("message", {
			origin: "https://external.example",
			source: frame.contentWindow,
			data: state,
		}),
	);
	expect(screen.queryByLabelText("図の名前")).toBeNull();
	fireEvent(
		window,
		new MessageEvent("message", {
			origin: window.location.origin,
			source: window,
			data: state,
		}),
	);
	expect(screen.queryByLabelText("図の名前")).toBeNull();
	fireEvent(
		window,
		new MessageEvent("message", {
			origin: window.location.origin,
			source: frame.contentWindow,
			data: state,
		}),
	);
	expect((screen.getByLabelText("図の名前") as HTMLInputElement).value).toBe(
		"編集中",
	);
	vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data) => {
		if (data.action === "leave")
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source: frame.contentWindow,
					data: {
						type: "eumenes:drawing-leave",
						requestId: data.requestId,
						allowed: false,
					},
				}),
			);
	});
	fireEvent.click(screen.getByRole("button", { name: "図一覧" }));
	await waitFor(() =>
		expect(
			(screen.getByRole("menuitem", { name: "別の図" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("menuitem", { name: "別の図" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("未保存"),
	);
	expect(
		dispatch.mock.calls.some(([event]) => event.action === "drawing-open"),
	).toBe(false);
	const close = vi.fn();
	const event = new CustomEvent("eumenes:artifact-close", {
		cancelable: true,
		detail: { close },
	});
	screen
		.getByRole("region")
		.closest("[data-artifact-tab]")!
		.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(close).not.toHaveBeenCalled();
});
