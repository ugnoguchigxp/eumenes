import { ArtifactRenderer, compileArtifact } from "@eumenes/artifact-ui";
import type {
	BrowserWorkspaceResource,
	Receipt,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(cleanup);

const capture = {
	captureId: "11111111-1111-4111-8111-111111111111",
	range: "viewport" as const,
	capturedAt: "2026-10-18T09:00:00.000Z",
	width: 1500,
	height: 685,
	bytes: 40960,
	reductionPercent: 85,
	state: "local_ready" as const,
};
const resource: BrowserWorkspaceResource = {
	kind: "browser",
	revision: 3,
	availability: { available: true },
	connection: { state: "connected" },
	executablePath:
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	tabs: [
		{
			tabRef: "tab-1",
			title: "Eumenes",
			url: "http://127.0.0.1:5173/",
			active: true,
			status: "open",
		},
		{
			tabRef: "tab-2",
			title: "Example",
			url: "https://example.com/",
			active: false,
			status: "open",
		},
	],
	tasks: [],
	histories: [],
	replays: [],
	captures: [
		capture,
		{
			...capture,
			captureId: "22222222-2222-4222-8222-222222222222",
			state: "capturing",
		},
	],
};
const definition = JSON.stringify({
	view: "browser-workspace",
	source: "browser",
	title: "ブラウザ",
});

function setup(
	value: BrowserWorkspaceResource = resource,
	fetchMedia?: (path: string) => Promise<Blob>,
) {
	const dispatch = vi.fn(async (): Promise<Receipt> => ({
		status: "accepted",
		message: "",
	}));
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: { browser: value }, dispatch, fetchMedia }}
		/>,
	);
	return dispatch;
}
const last = (dispatch: ReturnType<typeof setup>) =>
	(
		dispatch.mock.calls as unknown as [
			{ action: string; source: string; revision: number; values: unknown },
		][]
	).at(-1)?.[0];

it("compiles only the strict view over a browser source", () => {
	const snapshot: Snapshot = { browser: resource };
	expect(compileArtifact(definition, snapshot).request).toMatchObject({
		view: "browser-workspace",
		source: "browser",
	});
	expect(() =>
		compileArtifact(definition, {
			browser: { kind: "music", revision: 0, currentId: "", tracks: [] },
		}),
	).toThrow();
	expect(() => compileArtifact(definition, {})).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "browser-workspace",
				source: "browser",
				extra: 1,
			}),
			snapshot,
		),
	).toThrow();
	expect(() =>
		compileArtifact(JSON.stringify({ view: "browser-workspace" }), snapshot),
	).toThrow();
});

it("sends each screen event with the source revision and its own values", async () => {
	const dispatch = setup();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByRole("button", { name: "切断" }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-disconnect"),
	);
	expect(last(dispatch)).toMatchObject({ source: "browser", revision: 3 });
	fireEvent.click(screen.getByRole("button", { name: "Exampleへ切り替える" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-focus-tab"));
	expect(last(dispatch)?.values).toEqual({ tabRef: "tab-2" });
	fireEvent.click(screen.getByRole("button", { name: "Exampleを閉じる" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-close-tab"));
	expect(last(dispatch)?.values).toEqual({ tabRef: "tab-2" });
	fireEvent.change(screen.getByLabelText("開くURL"), {
		target: { value: "https://example.org/a" },
	});
	fireEvent.click(screen.getByRole("button", { name: "新しく開く" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-open-url"));
	expect(last(dispatch)?.values).toEqual({ url: "https://example.org/a" });
});

it("connects through the connection tab and keeps path settings out of the workspace", async () => {
	const dispatch = setup({
		...resource,
		connection: { state: "disconnected" },
		availability: { available: false, reason: "browser_disconnected" },
		tabs: [],
	});
	fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByRole("button", { name: "ブラウザに接続" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-connect"));
	expect(screen.queryByLabelText("Braveの実行ファイルのパス")).toBeNull();
});

it("cancels only a capture still in progress", async () => {
	const dispatch = setup();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByRole("button", { name: /撮影を取り消す/ }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-cancel-capture"),
	);
	expect(last(dispatch)?.values).toEqual({
		captureId: "22222222-2222-4222-8222-222222222222",
	});
});

it("reads a selected capture through the host and revokes its object URL", async () => {
	const created: string[] = [];
	const revoked: string[] = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = vi.fn(() => {
		const url = `blob:capture-${created.length}`;
		created.push(url);
		return url;
	});
	URL.revokeObjectURL = vi.fn((url: string) => {
		revoked.push(url);
	});
	try {
		const fetchMedia = vi.fn(
			async () => new Blob(["x"], { type: "image/webp" }),
		);
		setup(resource, fetchMedia);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getAllByRole("button", { name: /を選ぶ/ })[0]!);
		await waitFor(() => expect(fetchMedia).toHaveBeenCalled());
		expect(fetchMedia).toHaveBeenCalledWith(
			`/api/browser/captures/${capture.captureId}/content`,
		);
		await waitFor(() =>
			expect(document.querySelector("img")?.getAttribute("src")).toBe(
				"blob:capture-0",
			),
		);
		cleanup();
		expect(revoked).toContain("blob:capture-0");
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	}
});

it("refuses a capture id that is not a plain identifier", async () => {
	const fetchMedia = vi.fn(async () => new Blob(["x"]));
	setup(
		{
			...resource,
			captures: [{ ...capture, captureId: "../../etc/passwd" }],
		},
		fetchMedia,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByRole("button", { name: /を選ぶ/ }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(fetchMedia).not.toHaveBeenCalled();
});

it("downloads the selected capture as a file named by its id", async () => {
	const fetchMedia = vi.fn(async () => new Blob(["x"], { type: "image/webp" }));
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = vi.fn(() => "blob:download");
	URL.revokeObjectURL = vi.fn();
	const clicked: Array<{ download: string; href: string }> = [];
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(function (this: HTMLAnchorElement) {
			clicked.push({ download: this.download, href: this.href });
		});
	try {
		setup(resource, fetchMedia);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getAllByRole("button", { name: /を選ぶ/ })[0]!);
		await waitFor(() => screen.getByRole("button", { name: "ダウンロード" }));
		fireEvent.click(screen.getByRole("button", { name: "ダウンロード" }));
		await waitFor(() => expect(clicked).toHaveLength(1));
		expect(clicked[0]?.download).toBe(`capture-${capture.captureId}.webp`);
	} finally {
		click.mockRestore();
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	}
});

it("renders browser settings as an artifact and clears the write-only token after saving", async () => {
	const dispatch = vi.fn(async (): Promise<Receipt> => ({
		status: "accepted",
		message: "保存しました",
	}));
	render(
		<ArtifactRenderer
			definition={JSON.stringify({
				view: "browser-settings",
				source: "browser",
				title: "ブラウザの設定",
			})}
			runtime={{
				snapshot: {
					browser: {
						...resource,
						bridge: {
							revision: 4,
							enabled: false,
							configured: false,
							available: true,
						},
					},
				},
				dispatch,
			}}
		/>,
	);
	expect(screen.queryByRole("tab", { name: "操作" })).toBeNull();
	const input = screen.getByLabelText("接続トークン") as HTMLInputElement;
	expect(input.type).toBe("password");
	fireEvent.change(input, { target: { value: "fixture-secret" } });
	fireEvent.click(screen.getByLabelText("接続時の手動承認を省略"));
	fireEvent.click(screen.getByRole("button", { name: "承認の設定を保存" }));
	await waitFor(() => expect(input.value).toBe(""));
	expect(last(dispatch)).toMatchObject({
		action: "browser-bridge-save",
		values: {
			token: "fixture-secret",
			enabled: true,
			clear: false,
			expectedRevision: "4",
		},
	});
});

const historyId = "33333333-3333-4333-8333-333333333333";
const summary = {
	historyId,
	revision: 4,
	title: "YouTubeで検索し、結果からランダムに再生する",
	request: "おすすめの動画を再生して",
	place: "www.youtube.com",
	variables: [{ name: "keyword", label: "検索語" }],
	stepCount: 1,
	runCount: 2,
	failureCount: 0,
	lastOutcome: "completed" as const,
	hasCommit: false,
	lastUsedAt: 1792454400000,
	createdAt: 1792368000000,
	updatedAt: 1792454400000,
};

it("opens a history's detail as a read event and closes it with an empty id", async () => {
	const dispatch = setup({ ...resource, histories: [summary] });
	fireEvent.mouseDown(screen.getByRole("tab", { name: "履歴" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByRole("button", { name: /詳細/ }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-select-history"),
	);
	expect(last(dispatch)?.values).toEqual({ historyId });
});

it("deletes the shown history at its revision after the confirmation", async () => {
	const dispatch = setup({
		...resource,
		histories: [summary],
		selectedHistoryId: historyId,
		historyDetail: {
			...summary,
			steps: [{ label: "検索する", expectation: "結果が表示される" }],
			actions: [{ seq: 1, kind: "navigate", place: "www.youtube.com/" }],
			source: "await page.goto('https://www.youtube.com/');",
		},
	});
	fireEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(dispatch).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-delete-history"),
	);
	expect(last(dispatch)?.values).toEqual({
		historyId,
		expectedRevision: "4",
	});
	fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "browser-select-history",
			values: { historyId: "" },
		}),
	);
});

const historyDetail = {
	...summary,
	steps: [{ label: "検索する", expectation: "結果が表示される" }],
	actions: [{ seq: 1, kind: "navigate" as const, place: "www.youtube.com/" }],
	source: "await page.goto('https://www.youtube.com/');",
	replay: {
		code: "async (page) => { await page.goto('https://www.youtube.com/'); }",
		blocked: null,
		blockedLabel: null,
	},
};

it("replays the shown history with one var.<name> value per variable after the confirmation", async () => {
	const dispatch = setup({
		...resource,
		histories: [summary],
		selectedHistoryId: historyId,
		historyDetail,
	});
	const button = screen.getByRole("button", { name: "リプレイ" });
	expect((button as HTMLButtonElement).disabled).toBe(true);
	fireEvent.change(screen.getByLabelText("検索語"), {
		target: { value: "猫 癒し" },
	});
	fireEvent.click(button);
	expect(dispatch).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "実行する" }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-replay-history"),
	);
	expect(last(dispatch)?.values).toEqual({
		historyId,
		expectedRevision: "4",
		"var.keyword": "猫 癒し",
	});
});

it("cancels the running replay by its id", async () => {
	const replayId = "44444444-4444-4444-8444-444444444444";
	const dispatch = setup({
		...resource,
		histories: [summary],
		selectedHistoryId: historyId,
		historyDetail,
		replays: [
			{ replayId, historyId, state: "running", startedAt: 1792454400000 },
		],
	});
	fireEvent.click(screen.getByRole("button", { name: "中止" }));
	await waitFor(() =>
		expect(last(dispatch)?.action).toBe("browser-cancel-replay"),
	);
	expect(last(dispatch)?.values).toEqual({ replayId });
});
