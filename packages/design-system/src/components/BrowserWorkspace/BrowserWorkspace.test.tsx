import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { sampleCaptures, sampleTabs, sampleTasks } from "./fixtures";
import type { BrowserWorkspaceProps } from "./types";

const preview =
	"data:image/svg+xml," +
	encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');

function props(patch: Partial<BrowserWorkspaceProps> = {}) {
	return {
		availability: { available: true },
		connection: { state: "connected" },
		executablePath: "/opt/brave/brave",
		tabs: sampleTabs,
		tasks: sampleTasks,
		captures: sampleCaptures,
		onConnect: vi.fn(),
		onDisconnect: vi.fn(),
		onSaveExecutablePath: vi.fn(),
		onOpenUrl: vi.fn(),
		onFocusTab: vi.fn(),
		onCloseTab: vi.fn(),
		onSelectCapture: vi.fn(),
		onDownloadCapture: vi.fn(),
		onCancelTask: vi.fn(),
		onCancelCapture: vi.fn(),
		...patch,
	} as BrowserWorkspaceProps;
}

describe("BrowserWorkspace tabs", () => {
	it("shows tab state and sends focus and close events", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		const tabs = screen.getByRole("region", { name: "タブ" });
		expect(within(tabs).getByText("現在のタブ")).toBeTruthy();
		expect(within(tabs).getByText("作業: 明日の天気を調べる")).toBeTruthy();
		expect(within(tabs).getByText("見失いました")).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: "ニュースへ切り替える" }),
		);
		expect(p.onFocusTab).toHaveBeenCalledWith("t2");
		await userEvent.click(
			screen.getByRole("button", { name: "ニュースを閉じる" }),
		);
		expect(p.onCloseTab).toHaveBeenCalledWith("t2");
	});

	it("shows a tab the host stopped for safety and offers no switching or closing for it", () => {
		render(<BrowserWorkspace {...props()} />);
		const tabs = screen.getByRole("region", { name: "タブ" });
		expect(within(tabs).getByText("保護のため停止")).toBeTruthy();
		expect(
			within(tabs).getByText(/Braveで別のページに移してください/),
		).toBeTruthy();
		for (const name of [
			"保護されたページへ切り替える",
			"保護されたページを閉じる",
		])
			expect(
				(screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
			).toBe(true);
	});

	it("blocks switching and closing for the active, busy, lost and closed tabs", () => {
		render(<BrowserWorkspace {...props()} />);
		for (const name of [
			"天気予報へ切り替える",
			"天気予報を閉じる",
			"フォームへ切り替える",
			"フォームを閉じる",
			"旧ページへ切り替える",
			"旧ページを閉じる",
		]) {
			expect(
				(screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
			).toBe(true);
		}
	});

	it("opens a new URL separately from switching tabs", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		await userEvent.type(
			screen.getByLabelText("開くURL"),
			" https://a.test/x ",
		);
		await userEvent.click(screen.getByRole("button", { name: "新しく開く" }));
		expect(p.onOpenUrl).toHaveBeenCalledWith("https://a.test/x");
		expect(p.onFocusTab).not.toHaveBeenCalled();
	});

	it("rejects an empty or non-http URL without emitting", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		await userEvent.click(screen.getByRole("button", { name: "新しく開く" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"URLを入力",
		);
		await userEvent.type(
			screen.getByLabelText("開くURL"),
			"javascript:alert(1)",
		);
		await userEvent.click(screen.getByRole("button", { name: "新しく開く" }));
		expect(screen.getByRole("alert").textContent).toContain("http");
		expect(p.onOpenUrl).not.toHaveBeenCalled();
	});
});

describe("BrowserWorkspace tasks", () => {
	it("labels every state and cancels only queued or running tasks", async () => {
		const p = props({
			tasks: [
				...sampleTasks,
				{ taskId: "k5", requestSummary: "待機の依頼", state: "queued" },
			],
		});
		render(<BrowserWorkspace {...p} />);
		const tasks = screen.getByRole("region", { name: "作業" });
		for (const text of ["実行中", "完了", "入力待ち", "結果不明", "待機中"])
			expect(within(tasks).getAllByText(text).length).toBeGreaterThan(0);
		expect(
			within(tasks).getByText("住所の入力で止まっています。"),
		).toBeTruthy();
		expect(within(tasks).getAllByRole("button")).toHaveLength(2);
		await userEvent.click(
			screen.getByRole("button", {
				name: "作業「明日の天気を調べる」を取り消す",
			}),
		);
		expect(p.onCancelTask).toHaveBeenCalledWith("k1");
	});
});

describe("BrowserWorkspace captures", () => {
	it("lists captures with size, reduction and a neutral library label", () => {
		render(<BrowserWorkspace {...props()} />);
		const list = screen.getByRole("region", { name: "撮影した画像" });
		expect(within(list).getByText(/1280 × 720 px/)).toBeTruthy();
		expect(within(list).getByText(/削減 86%/)).toBeTruthy();
		expect(within(list).getAllByText("ライブラリー保存: 未対応")).toHaveLength(
			3,
		);
		expect(within(list).getByText("変換中")).toBeTruthy();
		expect(
			within(list).queryByRole("button", { name: /再送|再試行/ }),
		).toBeNull();
	});

	it("selects, downloads and cancels captures", async () => {
		const p = props({ selectedCaptureId: "c1", previewSrc: preview });
		render(<BrowserWorkspace {...p} />);
		await userEvent.click(
			screen.getByRole("button", { name: /ページ全体.*を選ぶ/ }),
		);
		expect(p.onSelectCapture).toHaveBeenCalledWith("c2");
		await userEvent.click(screen.getByRole("button", { name: "ダウンロード" }));
		expect(p.onDownloadCapture).toHaveBeenCalledWith("c1");
		await userEvent.click(
			screen.getByRole("button", { name: /ページ全体.*の撮影を取り消す/ }),
		);
		expect(p.onCancelCapture).toHaveBeenCalledWith("c2");
		expect(
			screen.getByRole("img", { name: /撮影画像/ }).getAttribute("src"),
		).toBe(preview);
	});

	it("shows no image or download until the selected capture is ready", () => {
		render(
			<BrowserWorkspace
				{...props({ selectedCaptureId: "c2", previewSrc: preview })}
			/>,
		);
		expect(screen.queryByRole("img", { name: /撮影画像/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "ダウンロード" })).toBeNull();
		expect(screen.getByText("撮影が終わるとここに表示します。")).toBeTruthy();
	});
});

describe("BrowserWorkspace connection", () => {
	it("offers connect when disconnected and hides tab and URL controls", async () => {
		const p = props({
			availability: { available: false, reason: "browser_disconnected" },
			connection: { state: "disconnected" },
		});
		render(<BrowserWorkspace {...p} />);
		expect(screen.getByRole("alert").textContent).toContain(
			"ブラウザに接続されていません",
		);
		expect(screen.queryByRole("button", { name: "切断" })).toBeNull();
		expect(screen.queryByLabelText("開くURL")).toBeNull();
		expect(screen.queryByRole("region", { name: "タブ" })).toBeNull();
		expect(screen.getByText(/接続すると/)).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: "ブラウザに接続" }),
		);
		expect(p.onConnect).toHaveBeenCalledTimes(1);
	});

	it("shows the end reason after a connection ends", () => {
		render(
			<BrowserWorkspace
				{...props({
					availability: { available: false, reason: "browser_disconnected" },
					connection: { state: "disconnected", endReason: "browser_closed" },
				})}
			/>,
		);
		expect(screen.getByText(/Braveが終了した/)).toBeTruthy();
	});

	it("guides the user to pick a tab while connecting", () => {
		render(
			<BrowserWorkspace
				{...props({
					availability: { available: false, reason: "browser_disconnected" },
					connection: { state: "connecting" },
				})}
			/>,
		);
		expect(
			screen.getByText(
				"Braveに表示された接続ページで、操作させるタブを選んでください",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ブラウザに接続" })).toBeNull();
		expect(screen.queryByLabelText("開くURL")).toBeNull();
	});

	it("offers disconnect when connected", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		expect(screen.queryByRole("button", { name: "ブラウザに接続" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "切断" }));
		expect(p.onDisconnect).toHaveBeenCalledTimes(1);
	});

	it("saves the Brave executable path and blocks connecting until it is set", async () => {
		const p = props({
			availability: { available: false, reason: "browser_not_configured" },
			connection: { state: "disconnected" },
			executablePath: undefined,
		});
		render(<BrowserWorkspace {...p} />);
		expect(
			(
				screen.getByRole("button", {
					name: "ブラウザに接続",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		const save = screen.getByRole("button", {
			name: "保存",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await userEvent.type(
			screen.getByLabelText("Braveの実行ファイルのパス"),
			" /opt/brave/brave ",
		);
		await userEvent.click(save);
		expect(p.onSaveExecutablePath).toHaveBeenCalledWith("/opt/brave/brave");
	});

	it("keeps the path editable from the settings area once configured", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		const input = screen.getByLabelText(
			"Braveの実行ファイルのパス",
		) as HTMLInputElement;
		expect(input.value).toBe("/opt/brave/brave");
		await userEvent.type(input, "2");
		await userEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(p.onSaveExecutablePath).toHaveBeenCalledWith("/opt/brave/brave2");
	});
});

describe("BrowserWorkspace availability", () => {
	it.each([
		["browser_not_configured", "パスが設定されていません"],
		["browser_disconnected", "接続されていません"],
		["browser_connect_timeout", "時間内に完了しませんでした"],
		["browser_mcp_unavailable", "起動できませんでした"],
	])("maps %s to Japanese and disables operations", (reason, text) => {
		render(
			<BrowserWorkspace
				{...props({ availability: { available: false, reason } })}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(text);
		expect(
			(screen.getByRole("button", { name: "新しく開く" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "ニュースへ切り替える",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("falls back to a generic label for an unknown or removed reason", () => {
		render(
			<BrowserWorkspace
				{...props({
					availability: {
						available: false,
						reason: "browser_network_boundary_unavailable",
					},
				})}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"現在ブラウザを利用できません。",
		);
	});

	it("has no quality or compression controls", () => {
		render(<BrowserWorkspace {...props()} />);
		expect(screen.queryByText(/品質|圧縮率/)).toBeNull();
	});
});
