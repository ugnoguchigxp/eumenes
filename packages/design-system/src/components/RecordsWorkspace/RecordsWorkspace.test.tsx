import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RecordsWorkspace } from "./RecordsWorkspace";

afterEach(cleanup);
test("mounted tabs retain expanded rows, scroll and procedure confirmation; actions are explicit", () => {
	const state = vi.fn(),
		remove = vi.fn(),
		refresh = vi.fn(),
		download = vi.fn();
	render(
		<RecordsWorkspace
			tabs={[
				{
					id: "ai",
					label: "AIの利用",
					description: "AI",
					rows: [
						{
							id: "u",
							label: "会話",
							summary: ["採用済み"],
							details: [{ label: "トークン数", value: "10" }],
						},
					],
				},
				{
					id: "toolchains",
					label: "ツールチェーン",
					description: "作業",
					rows: [],
					procedures: [
						{
							id: "r",
							label: "取得手順",
							description: "読む箇所",
							enabled: true,
							status: "有効",
						},
					],
				},
			]}
			dataDescription={["端末に保存"]}
			onRefresh={refresh}
			onQuery={() => {}}
			onProcedureState={state}
			onProcedureDelete={remove}
			onDownload={download}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "AIの利用: uの詳細" }));
	const scroll = screen.getByRole("region", { name: "AIの利用の表" });
	scroll.scrollTop = 80;
	fireEvent.mouseDown(screen.getByRole("tab", { name: "ツールチェーン" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByText("保存済みの取得手順"));
	fireEvent.click(screen.getByRole("button", { name: "無効にする" }));
	expect(state).toHaveBeenCalledWith("r", false);
	fireEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除" }));
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	expect(remove).toHaveBeenCalledWith("r");
	fireEvent.mouseDown(screen.getByRole("tab", { name: "AIの利用" }), {
		button: 0,
		ctrlKey: false,
	});
	expect(screen.getByText("トークン数")).toBeTruthy();
	expect(scroll.scrollTop).toBe(80);
	fireEvent.click(screen.getByRole("button", { name: "記録を更新" }));
	expect(refresh).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByText("データと診断"));
	fireEvent.click(screen.getByRole("button", { name: "診断データを保存" }));
	expect(download).toHaveBeenCalledOnce();
});

test("compact records show AI and toolchain details in dialogs", () => {
	render(
		<RecordsWorkspace
			compact
			tabs={[
				{
					id: "ai",
					label: "AIの利用",
					rows: [
						{
							id: "ai-row",
							label: "会話",
							summary: [],
							details: [{ label: "要求ID", value: "ai-request" }],
						},
					],
				},
				{
					id: "toolchains",
					label: "ツールチェーン",
					rows: [
						{
							id: "tool-row",
							label: "検索",
							summary: [],
							details: [{ label: "実行ID", value: "tool-run" }],
						},
					],
				},
			]}
			dataDescription={[]}
			onRefresh={() => {}}
			onQuery={() => {}}
			onProcedureState={() => {}}
			onProcedureDelete={() => {}}
			onDownload={() => {}}
		/>,
	);
	expect(screen.queryByText("データと診断")).toBeNull();
	expect(screen.queryByRole("button", { name: "診断データを保存" })).toBeNull();
	fireEvent.click(
		screen.getByRole("button", { name: "AIの利用: ai-rowの詳細" }),
	);
	let dialog = screen.getByRole("dialog", { name: "AIの利用の詳細" });
	expect(within(dialog).getByText("ai-request")).toBeTruthy();
	expect(screen.queryByText("選択した行の詳細")).toBeNull();
	fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
	fireEvent.mouseDown(screen.getByRole("tab", { name: "ツールチェーン" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(
		screen.getByRole("button", { name: "ツールチェーン: tool-rowの詳細" }),
	);
	dialog = screen.getByRole("dialog", { name: "ツールチェーンの詳細" });
	expect(within(dialog).getByText("tool-run")).toBeTruthy();
	expect(screen.queryByText("選択した行の詳細")).toBeNull();
});
