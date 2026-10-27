import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "./BrowserWorkspace";
import {
	sampleCaptures,
	sampleHistories,
	sampleHistoryDetail,
	sampleReplays,
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
		replays: [],
		onConnect: vi.fn(),
		onDisconnect: vi.fn(),
		onSaveExecutablePath: vi.fn(),
		onOpenUrl: vi.fn(),
		onFocusTab: vi.fn(),
		onCloseTab: vi.fn(),
		onSelectCapture: vi.fn(),
		onSelectHistory: vi.fn(),
		onDeleteHistory: vi.fn(),
		onReplayHistory: vi.fn(),
		onCancelReplay: vi.fn(),
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
			within(first).getByText("www.youtube.com ・ 実行3回 ・ 最終 2026-10-20"),
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

	it("plays a row from the list with its variable values, without opening the detail", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		await openHistoryTab();
		const first = screen
			.getAllByRole("listitem")
			.find((r) => r.getAttribute("data-history-id") === "h1")!;
		const play = within(first).getByRole("button", {
			name: `${sampleHistories[0]!.title}を再生`,
		});
		expect(play.textContent).toBe("");
		expect(play.hasAttribute("disabled")).toBe(true);
		await userEvent.type(within(first).getByLabelText("検索語"), "猫 癒し");
		expect(play.hasAttribute("disabled")).toBe(false);
		await userEvent.click(play);
		expect(p.onReplayHistory).toHaveBeenCalledWith("h1", 3, {
			keyword: "猫 癒し",
		});
		expect(p.onSelectHistory).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps a row with committing operations to the detail, and says why", async () => {
		render(<BrowserWorkspace {...props()} />);
		await openHistoryTab();
		const second = screen
			.getAllByRole("listitem")
			.find((r) => r.getAttribute("data-history-id") === "h2")!;
		expect(
			within(second)
				.getByRole("button", { name: `${sampleHistories[1]!.title}を再生` })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			within(second).getByText(
				"送信などを含むため、詳細から確認して実行します",
			),
		).toBeTruthy();
	});

	it("disables a row's play and says why when the history cannot be replayed", async () => {
		const blocked = {
			...sampleHistories[0]!,
			replay: {
				blocked: "replay_incomplete",
				blockedLabel: "記録されていない操作や値があるため実行できません",
			},
		};
		render(<BrowserWorkspace {...props({ histories: [blocked] })} />);
		await openHistoryTab();
		expect(
			screen
				.getByRole("button", { name: `${blocked.title}を再生` })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByText("記録されていない操作や値があるため実行できません"),
		).toBeTruthy();
		expect(screen.getByLabelText("検索語").hasAttribute("disabled")).toBe(true);
	});

	it("turns a running row's play into a stop that cancels that replay", async () => {
		const p = props({ replays: [sampleReplays.running] });
		render(<BrowserWorkspace {...p} />);
		await openHistoryTab();
		const first = screen
			.getAllByRole("listitem")
			.find((r) => r.getAttribute("data-history-id") === "h1")!;
		expect(
			within(first).queryByRole("button", {
				name: `${sampleHistories[0]!.title}を再生`,
			}),
		).toBeNull();
		await userEvent.click(
			within(first).getByRole("button", {
				name: `${sampleHistories[0]!.title}の再生を中止`,
			}),
		);
		expect(p.onCancelReplay).toHaveBeenCalledWith("r1");
	});

	it("shows how a row's latest replay ended", async () => {
		render(
			<BrowserWorkspace {...props({ replays: [sampleReplays.failed] })} />,
		);
		await openHistoryTab();
		const first = screen
			.getAllByRole("listitem")
			.find((r) => r.getAttribute("data-history-id") === "h1")!;
		expect(
			within(first).getByText(
				"時間内に終わりませんでした（要素が見つからない可能性があります）",
			),
		).toBeTruthy();
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
			"リプレイ",
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

describe("BrowserWorkspace history replay", () => {
	const noVariables = {
		...sampleHistoryDetail,
		historyId: "h2",
		revision: 1,
		variables: [],
		hasCommit: true,
	};
	function detailProps(patch: Partial<BrowserWorkspaceProps> = {}) {
		return props({
			selectedHistoryId: "h1",
			historyDetail: sampleHistoryDetail,
			...patch,
		});
	}
	const replayButton = () =>
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "リプレイ",
		}) as HTMLButtonElement;

	it("keeps the button disabled until every variable has a value", async () => {
		render(<BrowserWorkspace {...detailProps()} />);
		const input = screen.getByLabelText("検索語") as HTMLInputElement;
		expect(input.required).toBe(true);
		expect(input.maxLength).toBe(200);
		expect(replayButton().disabled).toBe(true);
		await userEvent.type(input, "   ");
		expect(replayButton().disabled).toBe(true);
		await userEvent.type(input, "猫");
		expect(replayButton().disabled).toBe(false);
	});

	it("shows no input and an enabled button for a history without variables", () => {
		const p = props({
			selectedHistoryId: "h2",
			historyDetail: noVariables,
		});
		render(<BrowserWorkspace {...p} />);
		expect(screen.queryByLabelText("検索語")).toBeNull();
		expect(replayButton().disabled).toBe(false);
	});

	it("confirms with the code first, and runs with the revision and values", async () => {
		const p = detailProps();
		render(<BrowserWorkspace {...p} />);
		await userEvent.type(screen.getByLabelText("検索語"), "猫 癒し");
		await userEvent.click(replayButton());
		expect(p.onReplayHistory).not.toHaveBeenCalled();
		const confirm = screen.getByRole("dialog", { name: "リプレイの確認" });
		expect(
			within(confirm).getByText("新しいタブでこのコードを実行します。"),
		).toBeTruthy();
		expect(within(confirm).getByText("実行するコード")).toBeTruthy();
		expect(confirm.querySelector("pre code")?.textContent).toBe(
			sampleHistoryDetail.replay?.code,
		);
		expect(confirm.textContent).not.toContain("import { test }");
		expect(within(confirm).getByText("変数: 検索語 = 猫 癒し")).toBeTruthy();
		expect(
			within(confirm).queryByText("送信・購入などの確定操作を含みます。"),
		).toBeNull();
		await userEvent.click(
			within(confirm).getByRole("button", { name: "実行する" }),
		);
		expect(p.onReplayHistory).toHaveBeenCalledWith("h1", 3, {
			keyword: "猫 癒し",
		});
		expect(screen.queryByRole("dialog", { name: "リプレイの確認" })).toBeNull();
	});

	it("warns about committing operations and sends no values without variables", async () => {
		const p = props({ selectedHistoryId: "h2", historyDetail: noVariables });
		render(<BrowserWorkspace {...p} />);
		await userEvent.click(replayButton());
		const confirm = screen.getByRole("dialog", { name: "リプレイの確認" });
		expect(
			within(confirm).getByText("送信・購入などの確定操作を含みます。"),
		).toBeTruthy();
		await userEvent.click(
			within(confirm).getByRole("button", { name: "実行する" }),
		);
		expect(p.onReplayHistory).toHaveBeenCalledWith("h2", 1, {});
	});

	it("disables the button and the inputs and says why when the history cannot be replayed", async () => {
		const label = "記録されていない操作や値があるため実行できません";
		render(
			<BrowserWorkspace
				{...detailProps({
					historyDetail: {
						...sampleHistoryDetail,
						replay: {
							code: "",
							blocked: "replay_incomplete",
							blockedLabel: label,
						},
					},
				})}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(label)).toBeTruthy();
		expect((screen.getByLabelText("検索語") as HTMLInputElement).disabled).toBe(
			true,
		);
		expect(replayButton().disabled).toBe(true);
		await userEvent.click(replayButton());
		expect(screen.queryByRole("dialog", { name: "リプレイの確認" })).toBeNull();
	});

	it("disables the button when the replay information is missing", () => {
		render(
			<BrowserWorkspace
				{...detailProps({
					historyDetail: { ...sampleHistoryDetail, replay: undefined },
				})}
			/>,
		);
		expect(
			within(screen.getByRole("dialog")).getByText(
				"このリプレイの情報を読み込めませんでした",
			),
		).toBeTruthy();
		expect(replayButton().disabled).toBe(true);
	});

	it("does not run when the confirmation is dismissed", async () => {
		const p = detailProps();
		render(<BrowserWorkspace {...p} />);
		await userEvent.type(screen.getByLabelText("検索語"), "猫");
		await userEvent.click(replayButton());
		await userEvent.click(screen.getByRole("button", { name: "やめる" }));
		expect(p.onReplayHistory).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog", { name: "リプレイの確認" })).toBeNull();
	});

	it("shows a running replay with a cancel button and disables the replay button", async () => {
		const p = detailProps({ replays: [sampleReplays.running] });
		render(<BrowserWorkspace {...p} />);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("実行中…")).toBeTruthy();
		expect(replayButton().disabled).toBe(true);
		await userEvent.click(within(dialog).getByRole("button", { name: "中止" }));
		expect(p.onCancelReplay).toHaveBeenCalledWith("r1");
	});

	it.each([
		["completed", "完了しました"],
		["cancelled", "中止しました"],
		[
			"failed",
			"時間内に終わりませんでした（要素が見つからない可能性があります）",
		],
	] as const)("shows the ended %s replay", (state, text) => {
		render(
			<BrowserWorkspace
				{...detailProps({ replays: [sampleReplays[state]] })}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(text)).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: "中止" })).toBeNull();
	});

	it("uses the newest replay of the open history only", () => {
		render(
			<BrowserWorkspace
				{...detailProps({
					replays: [
						{ ...sampleReplays.running, replayId: "other", historyId: "h2" },
						sampleReplays.completed,
						sampleReplays.failed,
					],
				})}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("完了しました")).toBeTruthy();
		expect(within(dialog).queryByText("実行中…")).toBeNull();
	});

	it("marks the list row of a history whose replay is running", async () => {
		render(
			<BrowserWorkspace {...props({ replays: [sampleReplays.running] })} />,
		);
		await openHistoryTab();
		const rows = screen.getAllByRole("listitem");
		const first = rows.find((r) => r.getAttribute("data-history-id") === "h1")!;
		const second = rows.find(
			(r) => r.getAttribute("data-history-id") === "h2",
		)!;
		expect(within(first).getByText("実行中")).toBeTruthy();
		expect(within(second).queryByText("実行中")).toBeNull();
	});

	it("does not mark a row for an ended replay", async () => {
		render(
			<BrowserWorkspace {...props({ replays: [sampleReplays.completed] })} />,
		);
		await openHistoryTab();
		for (const row of screen.getAllByRole("listitem")) {
			if (row.hasAttribute("data-history-id"))
				expect(within(row).queryByText("実行中")).toBeNull();
		}
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
