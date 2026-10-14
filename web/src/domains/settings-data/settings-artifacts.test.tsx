import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

afterEach(cleanup);

function open(
	start: string,
	options?: Parameters<typeof createSettingsBackend>[0],
) {
	const backend = createSettingsBackend(options);
	const cache = newCache(backend);
	render(<Screens backend={backend} start={start} cache={cache} />);
	return backend;
}

test("the hub lists registered destinations and a navigate binding opens the registered screen", async () => {
	const backend = open("hub");
	await screen.findByRole("button", { name: "会話" });
	// Entries come from the navigate bindings and the targets' launcher metadata.
	for (const name of ["表示", "音声と入力", "記録"])
		expect(screen.getByRole("button", { name })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "会話" }));
	await screen.findByLabelText("AIの名前");
	expect(screen.getByLabelText("口調")).toBeTruthy();
	expect(backend.client.submitToolchainAction).not.toHaveBeenCalled();
});

test("screens share one draft; closing a screen keeps it; review shows the registered fields; apply sends only the changes", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	fireEvent.change(screen.getByLabelText("あなたの名前"), {
		target: { value: "共有した名前" },
	});
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "Amy " },
	});
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "strategist" },
	});
	fireEvent.click(screen.getByText("閉じる"));
	fireEvent.click(screen.getByText("開く:conversation"));
	await screen.findByLabelText("AIの名前");
	expect((screen.getByLabelText("AIの名前") as HTMLInputElement).value).toBe(
		"Amy ",
	);
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("会話 / 口調");
	expect(screen.getByText("参謀")).toBeTruthy();
	expect(screen.getByText("会話 / AIの名前")).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await waitFor(() => expect(backend.sent).toHaveLength(1));
	await screen.findByText("変更を適用しました");
	expect(backend.sent[0]!.input).toEqual({
		expectedRevision: 1,
		changes: expect.arrayContaining([
			{ fieldId: "conversation.agent-name", value: "Amy " },
			{ fieldId: "conversation.user-name", value: "共有した名前" },
			{ fieldId: "conversation.persona", value: "strategist" },
		]),
	});
	expect(backend.sent[0]!.input).not.toHaveProperty("settings");
	expect(backend.saved().general).toMatchObject({
		agentName: "Amy",
		userName: "共有した名前",
		persona: "strategist",
	});
	fireEvent.click(screen.getByText("開く:conversation"));
	expect(
		((await screen.findByLabelText("口調")) as HTMLSelectElement).value,
	).toBe("strategist");
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
});

test("a failed save keeps the draft and a resend of the same draft keeps its event id", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	const save = screen.getByRole("button", { name: "設定の変更をすべて保存" });
	expect(save).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "保存する名前" },
	});
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "sage" },
	});
	let fail!: (error: Error) => void;
	backend.client.submitToolchainAction.mockImplementationOnce(
		(event: { eventId: string; input: unknown }) =>
			new Promise((_resolve, reject) => {
				backend.sent.push({
					input: event.input as never,
					eventId: event.eventId,
				});
				fail = reject;
			}),
	);
	fireEvent.submit(screen.getByLabelText("AIの名前").closest("form")!);
	await screen.findByRole("button", { name: "保存中…" });
	await act(async () => fail(new TypeError("network")));
	await screen.findByText(/結果を確認できていません/);
	expect(screen.getByLabelText("AIの名前")).toHaveProperty(
		"value",
		"保存する名前",
	);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect(backend.sent).toHaveLength(2);
	expect(backend.sent[1]!.eventId).toBe(backend.sent[0]!.eventId);
	expect(backend.saved().general).toMatchObject({
		agentName: "保存する名前",
		persona: "sage",
	});
});

test("edits made while saving stay in the draft; a revision conflict keeps everything and never resends", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "送信済み" },
	});
	let finish!: () => void;
	const real = backend.client.submitToolchainAction.getMockImplementation()!;
	backend.client.submitToolchainAction.mockImplementationOnce(
		(event: { eventId: string; input: unknown }) =>
			new Promise((resolve) => {
				finish = () => resolve(real(event as never));
			}),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await waitFor(() => expect(finish).toBeTypeOf("function"));
	fireEvent.change(screen.getByLabelText("あなたの名前"), {
		target: { value: "追加の入力" },
	});
	await act(async () => finish());
	await screen.findByText("変更を適用しました");
	expect(backend.saved().general.agentName).toBe("送信済み");
	expect(backend.saved().general.userName).toBe("");
	expect(screen.getByLabelText("あなたの名前")).toHaveProperty(
		"value",
		"追加の入力",
	);
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", false);
	// Someone else changes the document: the next apply is a conflict, and nothing is lost.
	backend.setSaved({
		...backend.saved(),
		revision: backend.saved().revision + 5,
	});
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText(/別の画面で設定が変更されました/);
	expect(screen.getByLabelText("あなたの名前")).toHaveProperty(
		"value",
		"追加の入力",
	);
	expect(backend.sent).toHaveLength(2);
});

test("edits are checked against the registered field: foreign fields, bad values and paths are refused", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	const sentBefore = backend.client.submitToolchainAction.mock.calls.length;
	// The control cannot offer an unregistered choice; a long name is refused by maxLength.
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "x".repeat(41) },
	});
	expect((screen.getByLabelText("AIの名前") as HTMLInputElement).value).toBe(
		"",
	);
	expect(backend.client.submitToolchainAction.mock.calls.length).toBe(
		sentBefore,
	);
	expect(JSON.stringify(backend.saved())).not.toContain("x".repeat(41));
});

test("discard clears the shared draft from the review screen", async () => {
	open("conversation");
	await screen.findByLabelText("AIの名前");
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "maid" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("会話 / 口調");
	fireEvent.click(
		screen.getByRole("button", { name: "未適用の設定変更をすべて破棄" }),
	);
	await waitFor(() => expect(screen.queryByText("会話 / 口調")).toBeNull());
	fireEvent.click(screen.getByText("開く:conversation"));
	expect(
		((await screen.findByLabelText("口調")) as HTMLSelectElement).value,
	).toBe("butler");
});

test("the hub shows a pending draft of any screen it opens, never 'all saved' over a draft", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "maid" },
	});
	fireEvent.click(screen.getByText("開く:hub"));
	await screen.findByText("未適用の変更があります");
	expect(screen.queryByText("すべての変更を保存済み")).toBeNull();
	expect(screen.queryByRole("button", { name: "変更一覧を開く" })).toBeNull();
	expect(backend.sent).toHaveLength(0);
});

test("a refusal code of the settings adapter is explained, and the draft stays", async () => {
	const backend = open("conversation");
	await screen.findByLabelText("AIの名前");
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "sage" },
	});
	backend.client.submitToolchainAction.mockResolvedValueOnce({
		httpStatus: 200,
		view: {
			eventId: crypto.randomUUID(),
			status: "rejected",
			errorCode: "unset_not_allowed",
			createdAt: new Date().toISOString(),
		},
	});
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText(/この項目は空にできません/);
	expect(screen.getByLabelText("口調")).toHaveProperty("value", "sage");
});
