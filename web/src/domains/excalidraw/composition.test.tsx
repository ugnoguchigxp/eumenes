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
			url: `http://127.0.0.1:5173/#drawing/${crypto.randomUUID()}?revision=2`,
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
	expect(
		screen.getByRole("link", { name: "Excalidrawを開く" }).getAttribute("href"),
	).toBe(
		snapshot.d!.kind === "drawing-workspace" ? snapshot.d!.url : undefined,
	);
	fireEvent.click(screen.getByRole("button", { name: "図A（版 2）" }));
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
