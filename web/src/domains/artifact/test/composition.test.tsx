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

test("tab headers require an explicit, non-overlapping tab partition", () => {
	const children = [
		{ view: "playlist", source: "m" },
		{ view: "music-player", source: "m" },
	];
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "layout",
				direction: "tabs",
				headerChildren: [0],
				children,
			}),
			snapshot,
		),
	).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "layout",
				direction: "tabs",
				headerChildren: [0],
				tabs: [{ label: "曲", children: [0, 1] }],
				children,
			}),
			snapshot,
		),
	).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "layout",
				direction: "tabs",
				headerChildren: [0],
				tabs: [{ label: "曲", children: [1] }],
				children,
			}),
			snapshot,
		),
	).not.toThrow();
});

test("registered catalog selection filters rows and preselects the action form", async () => {
	const catalog: Snapshot = {
		services: {
			kind: "collection",
			revision: 1,
			title: "試せるサービス",
			columns: [
				{ key: "name", label: "サービス" },
				{ key: "model", label: "モデル" },
			],
			rows: [
				{ id: "a", cells: { name: "音声認識", model: "model-a" }, actions: [] },
				{ id: "b", cells: { name: "会話", model: "model-b" }, actions: [] },
			],
			total: 2,
			create: {
				actionId: "start",
				label: "試す",
				fields: [
					{
						id: "targetId",
						label: "サービス",
						control: "select",
						required: true,
						options: [
							{ value: "a", label: "音声認識" },
							{ value: "b", label: "会話" },
						],
					},
				],
			},
		},
	};
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	render(
		<ArtifactRenderer
			definition={JSON.stringify({
				view: "collection-workspace",
				source: "services",
				presentation: "catalog",
				selectionField: "targetId",
			})}
			runtime={{ snapshot: catalog, dispatch }}
		/>,
	);
	fireEvent.change(screen.getByRole("searchbox", { name: "一覧を検索" }), {
		target: { value: "会話" },
	});
	expect(screen.queryByRole("button", { name: /音声認識/ })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: /会話.*model-b/ }));
	fireEvent.click(screen.getByText("試す", { selector: "summary" }));
	expect(
		(screen.getByLabelText("サービス（必須）") as HTMLSelectElement).value,
	).toBe("b");
	fireEvent.click(screen.getByRole("button", { name: "試す" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "services",
				action: "collection-create",
				values: { actionId: "start", targetId: "b" },
			}),
		),
	);
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

test("a tab may show its subtitle preview inside its settings section, and only that pair", () => {
	const settings = { view: "settings-section", source: "s", title: "表示" };
	const preview = { view: "subtitle-preview", source: "p" };
	const parse = (tabs: unknown, children: unknown[]) =>
		compileArtifact(
			JSON.stringify({ view: "layout", direction: "tabs", tabs, children }),
			{
				s: { kind: "settings-section", revision: 1 },
				p: { kind: "subtitle-preview", revision: 1 },
			} as unknown as Snapshot,
		);
	expect(() =>
		parse(
			[
				{ label: "表示", children: [0, 1], arrangement: "form-preview" },
				{ label: "アニメーション", children: [2] },
			],
			[settings, preview, { view: "avatar-motion-lab" }],
		),
	).not.toThrow();
	expect(() =>
		parse(
			[
				{ label: "表示", children: [1, 0], arrangement: "form-preview" },
				{ label: "アニメーション", children: [2] },
			],
			[settings, preview, { view: "avatar-motion-lab" }],
		),
	).toThrow();
	expect(() =>
		parse(
			[{ label: "表示", children: [0], arrangement: "form-preview" }],
			[settings],
		),
	).toThrow();
	// The lab reads no source: naming one is rejected.
	expect(() =>
		parse(
			[{ label: "動作", children: [0] }],
			[{ view: "avatar-motion-lab", source: "s" }],
		),
	).toThrow();
});

test("the avatar lab is drawn by the host, and says so when the host has none", () => {
	const definition = JSON.stringify({
		view: "layout",
		direction: "tabs",
		tabs: [
			{ label: "曲", children: [0] },
			{ label: "アニメーション", children: [1] },
		],
		children: [
			{ view: "playlist", source: "m" },
			{ view: "avatar-motion-lab", title: "光の精霊の動作" },
		],
	});
	const view = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot,
				dispatch: vi.fn(),
				hostViews: { "avatar-motion-lab": () => <p>試写面</p> },
			}}
		/>,
	);
	expect(screen.getByText("試写面")).toBeTruthy();
	view.unmount();
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch: vi.fn() }}
		/>,
	);
	expect(
		screen.getByText("この画面では光の精霊の試写を利用できません。"),
	).toBeTruthy();
});
