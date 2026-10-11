import {
	ArtifactRenderer,
	compileArtifact,
	compileLang,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	render,
	screen,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const snapshot: Snapshot = {
	m: {
		kind: "music",
		revision: 1,
		currentId: "a",
		tracks: [
			{ id: "a", title: "曲A", url: "blob:audio" },
			{ id: "b", title: "曲B" },
		],
	},
	g: {
		kind: "generation",
		revision: 1,
		status: "running",
		title: "画像を生成しています",
	},
	c: { kind: "components", revision: 1 },
};
const definition = JSON.stringify({
	view: "layout",
	direction: "grid",
	children: [
		{ view: "music-player", source: "m" },
		{ view: "playlist", source: "m" },
		{ view: "generation-status", source: "g" },
		{ view: "components", source: "c" },
	],
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
test("JSON composes registered views through OpenUI, preserves media during other source updates", async () => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "選択済み",
	}));
	const compiled = compileArtifact(definition, snapshot);
	expect(compileLang(compiled.lang, snapshot)).toEqual(compiled);
	const result = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch }}
		/>,
	);
	const audio = result.container.querySelector("audio");
	expect(audio?.src).toBe("blob:audio");
	await screen.findByText("画像を生成しています");
	fireEvent.click(screen.getByRole("button", { name: "曲B" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "m",
				revision: 1,
				action: "music-select",
				values: { id: "b" },
			}),
		),
	);
	result.rerender(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: {
					...snapshot,
					g: {
						kind: "generation",
						revision: 2,
						status: "completed",
						title: "完了",
						hidden: true,
					},
				},
				dispatch,
			}}
		/>,
	);
	expect(result.container.querySelector("audio")).toBe(audio);
	expect(screen.queryByText("画像を生成しています")).toBeNull();
});
for (const children of [
	[{ view: "music-player", source: "g" }],
	[{ view: "playlist", source: "secret" }],
	[
		{
			view: "music-player",
			source: "m",
			url: "https://untrusted.example/audio",
		},
	],
	[{ view: "layout", children: [] }],
	Array.from({ length: 13 }, () => ({ view: "playlist", source: "m" })),
])
	test("composition rejects invalid nested source, arbitrary props and unbounded layouts", () => {
		expect(() =>
			compileArtifact(JSON.stringify({ view: "layout", children }), snapshot),
		).toThrow();
	});
test("unsafe host media URL is never rendered as audio or download", () => {
	const bad: Snapshot = {
		m: {
			kind: "music",
			revision: 1,
			currentId: "a",
			tracks: [{ id: "a", title: "bad", url: "javascript:alert(1)" }],
		},
	};
	const result = render(
		<ArtifactRenderer
			definition='{"view":"music-player","source":"m"}'
			runtime={{ snapshot: bad, dispatch: vi.fn() }}
		/>,
	);
	expect(result.container.querySelector("audio,a")).toBeNull();
});
test("registered library controls share the music source and reject a wrong resource kind", () => {
	const json = JSON.stringify({
		view: "layout",
		children: [
			{ view: "music-library", source: "m" },
			{ view: "music-player", source: "m" },
			{ view: "playlist", source: "m" },
		],
	});
	expect(compileArtifact(json, snapshot).lang).toContain("music-library");
	expect(() => compileArtifact(json, { m: snapshot.g! })).toThrow("source");
});
test("workspace is registered, composes with other views, and rejects unsafe host artwork", () => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const json = JSON.stringify({
		view: "layout",
		children: [
			{ view: "music-workspace", source: "m" },
			{ view: "components", source: "c" },
		],
	});
	expect(compileArtifact(json, snapshot).lang).toContain("music-workspace");
	expect(() => compileArtifact(json, { ...snapshot, m: snapshot.g! })).toThrow(
		"source",
	);
	const result = render(
		<ArtifactRenderer
			definition={json}
			runtime={{
				snapshot: {
					...snapshot,
					m: {
						kind: "music",
						revision: 1,
						currentId: "a",
						tracks: [
							{
								id: "a",
								title: "unsafe",
								url: "javascript:alert(1)",
								artworkUrl: "javascript:alert(1)",
							},
						],
					},
				},
				dispatch: vi.fn(),
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "楽曲イメージ" }));
	expect(result.container.querySelector("audio,img")).toBeNull();
});
