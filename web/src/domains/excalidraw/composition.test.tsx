import {
	ArtifactRenderer,
	compileArtifact,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	render,
	fireEvent,
	screen,
	cleanup,
	waitFor,
} from "@testing-library/react";
import { afterEach, test, expect, vi } from "vitest";
afterEach(cleanup);
test("drawing controls compose with another registered view; actions stay bound to the source and runtime URL", async () => {
	const snapshot: Snapshot = {
		d: {
			kind: "drawing-workspace",
			revision: 7,
			status: "利用可能",
			references: [{ id: "ref", title: "図A", revision: 2 }],
			url: `${window.location.origin}/#drawing/${crypto.randomUUID()}?revision=2`,
		},
		c: { kind: "components", revision: 1 },
	};
	const definition = JSON.stringify({
		view: "layout",
		children: [
			{ view: "drawing-workspace", source: "d" },
			{ view: "components", source: "c" },
		],
	});
	expect(compileArtifact(definition, snapshot).request.view).toBe("layout");
	expect(() =>
		compileArtifact(definition, { ...snapshot, d: snapshot.c! }),
	).toThrow("source");
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "受付",
	}));
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch }}
		/>,
	);
	const frame = (await screen.findByTitle(
		"Excalidraw編集画面",
	)) as HTMLIFrameElement;
	expect(frame.src).toContain("/excalidraw?embedded=1#drawing/");
	fireEvent(
		window,
		new MessageEvent("message", {
			origin: window.location.origin,
			source: frame.contentWindow,
			data: {
				type: "eumenes:drawing-state",
				referenceId: new URL(frame.src).hash.split("/")[1]!.split("?")[0],
				title: "現在の図",
				status: "保存済み",
				error: "",
				busy: false,
				hasDraft: false,
				dirty: false,
				loaded: true,
			},
		}),
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
						allowed: true,
					},
				}),
			);
	});
	fireEvent.click(screen.getByRole("button", { name: "図一覧" }));
	await waitFor(() =>
		expect(
			(screen.getByRole("menuitem", { name: "図A" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("menuitem", { name: "図A" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "d",
				revision: 7,
				action: "drawing-open",
				values: { id: "ref" },
			}),
		),
	);
});
