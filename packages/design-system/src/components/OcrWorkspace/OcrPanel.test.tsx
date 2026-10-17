import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { OcrPanel } from "./OcrPanel";
import type { OcrWorkspaceProps } from "./types";

afterEach(cleanup);
const props: OcrWorkspaceProps = {
	items: [],
	frameIndex: 0,
	selectedLines: [],
	configured: false,
	connectionRevision: 0,
	baseUrl: null,
};
const completed: OcrWorkspaceProps = {
	...props,
	configured: true,
	selectedId: "image",
	items: [
		{
			id: "image",
			name: "notice.png",
			mime: "image/png",
			revision: 1,
			state: "completed",
			progress: null,
			errorCode: null,
			result: {
				kind: "image",
				width: 100,
				height: 100,
				text: "本日のご案内\n受付は15時まで",
				lines: ["本日のご案内", "受付は15時まで"].map((text) => ({
					text,
					confidence: 0.95,
					polygon: [
						[0, 0],
						[50, 0],
						[50, 10],
						[0, 10],
					],
				})),
			},
		},
	],
};

test("line and full-text views avoid duplicate text and preserve selected-line actions", async () => {
	const user = userEvent.setup();
	const onCopy = vi.fn(),
		onIncorporate = vi.fn(),
		onLine = vi.fn();
	render(
		<OcrPanel
			{...completed}
			selectedLines={[1]}
			onCopy={onCopy}
			onIncorporate={onIncorporate}
			onLine={onLine}
		/>,
	);
	expect(screen.getByRole("tab", { name: "行ごと" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	expect(screen.getAllByText("受付は15時まで")).toHaveLength(1);
	await user.click(
		screen.getByRole("checkbox", { name: "1行目: 本日のご案内" }),
	);
	expect(onLine).toHaveBeenCalledWith(0);
	await user.click(screen.getByRole("button", { name: "選択箇所をコピー" }));
	expect(onCopy).toHaveBeenLastCalledWith("受付は15時まで");
	await user.click(screen.getByRole("tab", { name: "全文" }));
	expect(screen.getByRole("tabpanel")).toHaveTextContent("本日のご案内");
	expect(screen.queryByRole("checkbox")).toBeNull();
	expect(screen.getByText("1行を選択中")).toBeTruthy();
	await user.click(
		screen.getByRole("button", { name: "表示中の全文をコピー" }),
	);
	expect(onCopy).toHaveBeenLastCalledWith("本日のご案内\n受付は15時まで");
	await user.click(
		screen.getByRole("button", { name: "選択箇所を会話に追加" }),
	);
	expect(onIncorporate).toHaveBeenLastCalledWith("image", undefined, [1]);
	await user.click(screen.getByRole("button", { name: "原文を会話に追加" }));
	expect(onIncorporate).toHaveBeenLastCalledWith("image", undefined);
});

test("adopted correction remains the default copy target while raw-text actions remain distinct", async () => {
	const user = userEvent.setup();
	const onCopy = vi.fn(),
		onIncorporate = vi.fn();
	const correction: NonNullable<OcrWorkspaceProps["corrections"]>[number] = {
		id: "candidate",
		sourceId: "image",
		frameIndex: null,
		state: "completed",
		errorCode: null,
		createdAt: 0,
		sourceRevision: 1,
		result: {
			blocks: [
				{
					kind: "paragraph",
					text: "確認した補正案",
					evidence: { lineIndexes: [0] },
					uncertain: false,
				},
			],
			excludedLines: [],
		},
	};
	const { rerender } = render(
		<OcrPanel {...completed} onCopy={onCopy} onIncorporate={onIncorporate} />,
	);
	rerender(
		<OcrPanel
			{...completed}
			correctionPreferredId="candidate"
			corrections={[correction]}
			onCopy={onCopy}
			onIncorporate={onIncorporate}
		/>,
	);
	expect(screen.getByRole("heading", { name: "採用中の補正案" })).toBeTruthy();
	expect(screen.getByRole("tab", { name: "全文" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await user.click(
		screen.getByRole("button", { name: "表示中の全文をコピー" }),
	);
	expect(onCopy).toHaveBeenLastCalledWith("確認した補正案");
	await user.click(screen.getByRole("button", { name: "原文をコピー" }));
	expect(onCopy).toHaveBeenLastCalledWith("本日のご案内\n受付は15時まで");
	await user.click(screen.getByRole("button", { name: "原文を会話に追加" }));
	expect(onIncorporate).toHaveBeenCalledWith("image", undefined);
});

test("video selection actions keep the selected frame and new sources reset the view", async () => {
	const user = userEvent.setup();
	const onIncorporate = vi.fn();
	const item = completed.items[0]!;
	const video: OcrWorkspaceProps = {
		...completed,
		frameIndex: 1,
		items: [
			{
				...item,
				mime: "video/mp4",
				result: {
					kind: "video",
					video: { width: 100, height: 100 },
					frames: [
						{ timestampSeconds: 0, text: "最初", lines: [] },
						{
							timestampSeconds: 1,
							text: "次の時刻",
							lines: [
								{
									text: "次の時刻",
									confidence: 0.9,
									polygon: [
										[0, 0],
										[10, 0],
										[10, 10],
										[0, 10],
									],
								},
							],
						},
					],
				},
			},
		],
	};
	const { rerender } = render(
		<OcrPanel {...video} selectedLines={[0]} onIncorporate={onIncorporate} />,
	);
	await user.click(
		screen.getByRole("button", { name: "選択箇所を会話に追加" }),
	);
	expect(onIncorporate).toHaveBeenLastCalledWith("image", 1, [0]);
	await user.click(screen.getByRole("tab", { name: "全文" }));
	rerender(<OcrPanel {...completed} />);
	expect(screen.getByRole("tab", { name: "行ごと" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

test("a missing URL with a shared token does not report missing authentication", () => {
	render(<OcrPanel {...props} sharedCredentialAvailable />);
	expect(screen.getByText(/OCRの接続先が未設定/)).toBeTruthy();
	expect(screen.getByText(/設定済みのLARM共通トークン/)).toBeTruthy();
	expect(screen.queryByText(/トークンを読み込めません/)).toBeNull();
	expect(
		screen.getByRole("button", { name: "画像・動画ファイルをアップロード" }),
	).toBeDisabled();
});

test("a configured URL with no token reports the credential issue without claiming the URL is missing", () => {
	render(
		<OcrPanel
			{...props}
			baseUrl="http://127.0.0.1:18794/"
			sharedCredentialAvailable={false}
		/>,
	);
	expect(screen.queryByText(/OCRの接続先が未設定/)).toBeNull();
	expect(screen.getByText(/LARM共通トークンを読み込めません/)).toBeTruthy();
	expect(screen.getByLabelText("接続先 URL")).toHaveValue(
		"http://127.0.0.1:18794/",
	);
	expect(
		screen.getByRole("button", { name: "画像・動画ファイルをアップロード" }),
	).toBeDisabled();
});

test("an upstream rejection identifies the shared-token authentication failure", () => {
	render(
		<OcrPanel
			{...props}
			configured
			sharedCredentialAvailable
			selectedId="failed"
			items={[
				{
					id: "failed",
					name: "note.png",
					mime: "image/png",
					state: "failed",
					errorCode: "ocr_auth_failed",
					revision: 1,
					progress: null,
					result: null,
				},
			]}
		/>,
	);
	expect(
		screen.getByText(/OCRサービスがLARM共通トークンでの認証を拒否/),
	).toBeTruthy();
	expect(screen.queryByLabelText("接続先 URL")).toBeNull();
});
