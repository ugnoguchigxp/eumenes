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

it("connects from a disconnected screen and saves the path as typed", async () => {
	const dispatch = setup({
		...resource,
		connection: { state: "disconnected", endReason: "user_disconnected" },
		availability: { available: false, reason: "browser_disconnected" },
		tabs: [],
	});
	fireEvent.click(screen.getByRole("button", { name: "ブラウザに接続" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-connect"));
	expect(last(dispatch)?.values).toEqual({});
	fireEvent.change(screen.getByLabelText("Braveの実行ファイルのパス"), {
		target: { value: "/Applications/Brave/brave" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() => expect(last(dispatch)?.action).toBe("browser-save-path"));
	expect(last(dispatch)?.values).toEqual({ path: "/Applications/Brave/brave" });
});

it("cancels only a capture still in progress", async () => {
	const dispatch = setup();
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
