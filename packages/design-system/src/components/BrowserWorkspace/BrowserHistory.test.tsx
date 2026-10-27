import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "./BrowserWorkspace";
import {
	sampleCaptures,
	sampleHistories,
	sampleHistoryDetail,
	sampleTabs,
	sampleTasks,
} from "./fixtures";
import type { BrowserWorkspaceProps } from "./types";

function props(patch: Partial<BrowserWorkspaceProps> = {}) {
	return {
		availability: { available: true },
		connection: { state: "connected" },
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

async function openHistoryTab() {
	await userEvent.click(screen.getByRole("tab", { name: "履歴" }));
}

describe("BrowserWorkspace history tab", () => {
	it("orders the local tabs and starts on the operation tab", () => {
		render(<BrowserWorkspace {...props()} />);
		expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
			"操作",
			"履歴",
			"接続・タブ",
			"撮影画像",
		]);
		expect(
			screen.getByRole("tab", { name: "操作" }).getAttribute("aria-selected"),
		).toBe("true");
	});

	it("lists rows with meta, request, badges and a detail button", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		await openHistoryTab();
		const rows = screen.getAllByRole("listitem");
		const first = rows.find((r) => r.getAttribute("data-history-id") === "h1")!;
		expect(within(first).getByText(sampleHistories[0]!.title)).toBeTruthy();
		expect(
			within(first).getByText(
				"www.youtube.com ・ 変数: 検索語 ・ 実行3回 ・ 最終 2026-10-20",
			),
		).toBeTruthy();
		expect(
			within(first).getByText("「おすすめの動画を再生して」"),
		).toBeTruthy();
		expect(within(first).queryByText("前回失敗")).toBeNull();
		expect(within(first).queryByText("許可が必要な操作を含む")).toBeNull();
		const second = rows.find(
			(r) => r.getAttribute("data-history-id") === "h2",
		)!;
		expect(within(second).getByText("前回失敗")).toBeTruthy();
		expect(within(second).getByText("許可が必要な操作を含む")).toBeTruthy();
		expect(
			within(second).getByText("example.com ・ 実行1回 ・ 最終 2026-10-19"),
		).toBeTruthy();
		await userEvent.click(within(first).getByRole("button", { name: /詳細/ }));
		expect(p.onSelectHistory).toHaveBeenCalledWith("h1");
	});

	it("shows the empty note", async () => {
		render(<BrowserWorkspace {...props({ histories: [] })} />);
		await openHistoryTab();
		expect(
			screen.getByText(
				"まだ履歴はありません。ブラウザでの作業が完了すると、ここに手順が残ります。",
			),
		).toBeTruthy();
	});
});

describe("BrowserWorkspace history detail", () => {
	function detailProps(patch: Partial<BrowserWorkspaceProps> = {}) {
		return props({
			selectedHistoryId: "h1",
			historyDetail: sampleHistoryDetail,
			...patch,
		});
	}

	it("shows every section in order and the source as plain text", () => {
		render(<BrowserWorkspace {...detailProps()} />);
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByRole("heading", {
				name: sampleHistoryDetail.title,
			}),
		).toBeTruthy();
		const headings = within(dialog)
			.getAllByRole("heading", { level: 4 })
			.map((h) => h.textContent);
		expect(headings).toEqual([
			"依頼",
			"変数",
			"手順",
			"操作",
			"Playwrightのソース",
			"情報",
		]);
		expect(within(dialog).getByText("おすすめの動画を再生して")).toBeTruthy();
		expect(
			within(dialog).getByText("実行ごとに依頼から決まります"),
		).toBeTruthy();
		expect(within(dialog).getByText("検索結果の一覧が表示される")).toBeTruthy();
		expect(
			within(dialog).getByText(
				"入力 ・ 検索ボックス ・ 変数: keyword ・ www.youtube.com/",
			),
		).toBeTruthy();
		const code = dialog.querySelector("pre code")!;
		expect(code.textContent).toBe(sampleHistoryDetail.source);
		// Page-derived text is never HTML.
		expect(
			within(dialog).getByText(/<script>alert\(1\)<\/script>の動画/),
		).toBeTruthy();
		expect(dialog.querySelector("script")).toBeNull();
		expect(within(dialog).getByText("3回")).toBeTruthy();
		expect(within(dialog).getByText("0回")).toBeTruthy();
	});

	it("copies the source", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		render(<BrowserWorkspace {...detailProps()} />);
		await userEvent.click(screen.getByRole("button", { name: "コピー" }));
		expect(writeText).toHaveBeenCalledWith(sampleHistoryDetail.source);
		expect(await screen.findByText("コピーしました。")).toBeTruthy();
	});

	it("confirms before deleting and sends the revision, and closes", async () => {
		const p = detailProps();
		render(<BrowserWorkspace {...p} />);
		await userEvent.click(screen.getByRole("button", { name: "削除" }));
		expect(p.onDeleteHistory).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"この履歴を削除します。ブラウザ担当は以後この手順を使いません。",
			),
		).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "削除する" }));
		expect(p.onDeleteHistory).toHaveBeenCalledWith("h1", 3);
		await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(p.onSelectHistory).toHaveBeenCalledWith(undefined);
	});

	it("does not delete when the confirmation is cancelled", async () => {
		const p = detailProps();
		render(<BrowserWorkspace {...p} />);
		await userEvent.click(screen.getByRole("button", { name: "削除" }));
		await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
		expect(p.onDeleteHistory).not.toHaveBeenCalled();
	});

	it("shows loading, error and a rejected delete reason inside the modal", () => {
		const { rerender } = render(
			<BrowserWorkspace {...detailProps({ historyDetail: undefined })} />,
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("読み込み中です。")).toBeTruthy();
		expect(
			within(dialog).getByRole("heading", { name: sampleHistories[0]!.title }),
		).toBeTruthy();
		expect(
			(
				within(dialog).getByRole("button", {
					name: "削除",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		rerender(
			<BrowserWorkspace
				{...detailProps({
					historyDetail: undefined,
					historyDetailError: "履歴を読み込めませんでした。",
				})}
			/>,
		);
		expect(
			within(screen.getByRole("dialog")).getByRole("alert").textContent,
		).toBe("履歴を読み込めませんでした。");
		rerender(
			<BrowserWorkspace
				{...detailProps({ message: "履歴が更新されていました。" })}
			/>,
		);
		expect(
			within(screen.getByRole("dialog")).getByText(
				"履歴が更新されていました。",
			),
		).toBeTruthy();
	});
});

describe("BrowserWorkspace operation tab with a history", () => {
	it("says which history is used and shows the variable values", () => {
		render(<BrowserWorkspace {...props()} />);
		expect(
			screen.getByText(
				"履歴『YouTubeで検索し、結果からランダムに再生する』の手順を使っています",
			),
		).toBeTruthy();
		const values = screen.getByRole("list", { name: "今回の変数の値" });
		expect(within(values).getByText("検索語: 猫 癒し")).toBeTruthy();
	});

	it("shows nothing about histories for a task that uses none", () => {
		render(
			<BrowserWorkspace
				{...props({ tasks: [{ ...sampleTasks[0]!, history: undefined }] })}
			/>,
		);
		expect(screen.queryByText(/の手順を使っています/)).toBeNull();
	});
});
