import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "./BrowserWorkspace";
import {
	sampleCaptures,
	sampleHistories,
	sampleTabs,
	sampleTasks,
} from "./fixtures";
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
		histories: sampleHistories,
		onConnect: vi.fn(),
		onDisconnect: vi.fn(),
		onSaveExecutablePath: vi.fn(),
		onOpenUrl: vi.fn(),
		onFocusTab: vi.fn(),
		onCloseTab: vi.fn(),
		onSelectCapture: vi.fn(),
		onSelectHistory: vi.fn(),
		onDeleteHistory: vi.fn(),
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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

describe("BrowserWorkspace Script", () => {
	it("starts with Script only, keeps input in chat, and cancels the selected task", async () => {
		const p = props({ onOpenSettings: vi.fn() });
		render(<BrowserWorkspace {...p} />);
		expect(
			screen.getByRole("tab", { name: "操作" }).getAttribute("aria-selected"),
		).toBe("true");
		expect(screen.getByRole("region", { name: "実行Script" })).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("region", { name: "タブ" })).toBeNull();
		expect(screen.queryByRole("region", { name: "撮影した画像" })).toBeNull();
		expect(screen.queryByLabelText("Braveの実行ファイルのパス")).toBeNull();
		expect(screen.queryByRole("button", { name: /音声|マイク/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "実行を中止" }));
		expect(p.onCancelTask).toHaveBeenCalledWith("k1");
		await userEvent.click(screen.getByRole("button", { name: "設定" }));
		expect(p.onOpenSettings).toHaveBeenCalledOnce();
	});
	it("keeps the selected task across progress refreshes and does not invent completion", async () => {
		const script = {
			revision: 2,
			summary: "対象を開き、表示を確認します。",
			updatedAt: 2,
			history: [
				{
					revision: 1,
					summary: "最初の計画",
					steps: [
						{
							stepId: "s1",
							label: "一覧を見る",
							expectation: "一覧が表示される",
							state: "running" as const,
						},
					],
					updatedAt: 1,
				},
			],
			steps: [
				{
					stepId: "s1",
					label: "表示を確認",
					expectation: "対象が表示される",
					state: "running" as const,
				},
			],
			change: "一覧から対象を選択",
		};
		const p = props({
			tasks: [
				sampleTasks[0]!,
				{
					taskId: "second",
					state: "running",
					requestSummary: "別の依頼",
					script,
				},
			],
		});
		const { rerender } = render(<BrowserWorkspace {...p} />);
		await userEvent.selectOptions(
			screen.getByLabelText("表示する作業"),
			"second",
		);
		expect(screen.getByText(script.summary)).toBeTruthy();
		rerender(
			<BrowserWorkspace
				{...p}
				tasks={[...p.tasks]
					.reverse()
					.map((t) => ({ ...t, state: "indeterminate" as const }))}
			/>,
		);
		expect(
			(screen.getByLabelText("表示する作業") as HTMLSelectElement).value,
		).toBe("second");
		expect(screen.getAllByText("結果不明").length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: "実行を中止" })).toBeNull();
		await userEvent.click(screen.getByText("実行履歴"));
		expect(screen.getByText("一覧を見る · 実行中")).toBeTruthy();
	});
});

describe("BrowserWorkspace captures", () => {
	it("lists captures with size, reduction and a neutral library label", () => {
		render(<BrowserWorkspace {...props()} />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
			button: 0,
			ctrlKey: false,
		});
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

	it("opens the captures and selects the capture the host asks to show, once per request", () => {
		const p = props();
		const { rerender } = render(<BrowserWorkspace {...p} />);
		expect(screen.queryByRole("region", { name: "撮影した画像" })).toBeNull();
		rerender(<BrowserWorkspace {...p} focus={{ seq: 1, captureId: "c2" }} />);
		const list = screen.getByRole("region", { name: "撮影した画像" });
		expect(p.onSelectCapture).toHaveBeenCalledWith("c2");
		expect(list.querySelector("li[data-capture-id='c2']")).not.toBeNull();
		// A re-render with the same request does not select again.
		rerender(<BrowserWorkspace {...p} focus={{ seq: 1, captureId: "c2" }} />);
		expect(p.onSelectCapture).toHaveBeenCalledTimes(1);
		rerender(<BrowserWorkspace {...p} focus={{ seq: 2, captureId: "c2" }} />);
		expect(p.onSelectCapture).toHaveBeenCalledTimes(2);
	});

	it("shows no image or download until the selected capture is ready", () => {
		render(
			<BrowserWorkspace
				{...props({ selectedCaptureId: "c2", previewSrc: preview })}
			/>,
		);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "撮影画像" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
		expect(screen.getByRole("status").textContent).toContain(
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
		expect(screen.queryByRole("button", { name: "ブラウザに接続" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "切断" }));
		expect(p.onDisconnect).toHaveBeenCalledTimes(1);
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
		expect(screen.getByRole("status").textContent).toContain(text);
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
		expect(screen.getByRole("status").textContent).toContain(
			"現在ブラウザを利用できません。",
		);
	});

	it("has no quality or compression controls", () => {
		render(<BrowserWorkspace {...props()} />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "接続・タブ" }), {
			button: 0,
			ctrlKey: false,
		});
		expect(screen.queryByText(/品質|圧縮率/)).toBeNull();
	});
});

it("keeps the selected task and its open history when switching supplementary tabs", async () => {
	const p = props();
	render(<BrowserWorkspace {...p} />);
	await userEvent.selectOptions(screen.getByLabelText("表示する作業"), "k3");
	await userEvent.click(screen.getByText("チャットからの依頼"));
	await userEvent.click(screen.getByRole("tab", { name: "接続・タブ" }));
	await userEvent.click(screen.getByRole("tab", { name: "操作" }));
	expect(
		(screen.getByLabelText("表示する作業") as HTMLSelectElement).value,
	).toBe("k3");
	expect(
		screen.getByText("チャットからの依頼").parentElement?.getAttribute("open"),
	).not.toBeNull();
});

it("shows the persisted execution phase and clears it when the task ends", () => {
	const p = props({ tasks: [{ ...sampleTasks[0]!, phase: "operating" }] });
	const { rerender } = render(<BrowserWorkspace {...p} />);
	expect(screen.getByText("ブラウザ操作を確認・実行中")).toBeTruthy();
	rerender(
		<BrowserWorkspace
			{...p}
			tasks={[{ ...p.tasks[0]!, state: "cancelled" }]}
		/>,
	);
	expect(screen.queryByText("ブラウザ操作を確認・実行中")).toBeNull();
});
