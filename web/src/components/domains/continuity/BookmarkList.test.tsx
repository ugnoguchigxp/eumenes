import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { user } from "./user";
import { afterEach, expect, test } from "vitest";
import { ApiError } from "../../../../../client/transport";
import { BookmarkList } from "./BookmarkList";
import { bookmarkFixture, fakeContinuityClient } from "./fake-client";

afterEach(cleanup);
function setup(client: ReturnType<typeof fakeContinuityClient>) {
	const queries = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queries}>
			<BookmarkList client={client} conversationId="main" />
		</QueryClientProvider>,
	);
	return queries;
}

test("inactive bookmarks are hidden by default and shown on request", async () => {
	const client = fakeContinuityClient([
		bookmarkFixture({ id: "a", text: "有効なもの" }),
		bookmarkFixture({ id: "i", text: "止めたもの", status: "inactive" }),
	]);
	setup(client);
	await screen.findByText("有効なもの");
	expect(screen.queryByText("止めたもの")).toBeNull();
	await user.click(screen.getByLabelText("無効化済みも表示"));
	await screen.findByText("止めたもの");
	expect(client.list).toHaveBeenLastCalledWith(
		"main",
		{ includeInactive: true },
		expect.anything(),
	);
	expect(screen.getAllByRole("button", { name: "訂正" })).toHaveLength(1);
});

test("shows origin, revision and no forbidden wording", async () => {
	const client = fakeContinuityClient([
		bookmarkFixture({
			origin: "user_edited",
			revision: 3,
			kind: "open_question",
		}),
	]);
	setup(client);
	await screen.findByText("未決事項");
	expect(screen.getByText(/ユーザー編集/)).toBeTruthy();
	expect(screen.getByText(/版3/)).toBeTruthy();
	expect(document.body.textContent).not.toMatch(/忘れる|削除/);
});

test("revise sends expectedRevision and the list shows the server value", async () => {
	const client = fakeContinuityClient([bookmarkFixture({ revision: 2 })]);
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "訂正" }));
	await user.clear(screen.getByLabelText("訂正後の文面"));
	await user.type(screen.getByLabelText("訂正後の文面"), "直した文面");
	await user.selectOptions(screen.getByLabelText("種類"), "decision");
	await user.click(screen.getByRole("button", { name: "訂正を保存" }));
	await screen.findByText("直した文面", { selector: "p" });
	expect(client.revise).toHaveBeenCalledWith("main", "b0", {
		requestId: expect.any(String),
		expectedRevision: 2,
		kind: "decision",
		text: "直した文面",
	});
	expect(screen.queryByLabelText("訂正後の文面")).toBeNull();
	expect(screen.getByText(/ユーザー編集/)).toBeTruthy();
});

test("revise conflict keeps the input, refetches and shows guidance", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	client.revise.mockRejectedValueOnce(new ApiError(409, "revision_conflict"));
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "訂正" }));
	await user.clear(screen.getByLabelText("訂正後の文面"));
	await user.type(screen.getByLabelText("訂正後の文面"), "競合した編集");
	const before = client.list.mock.calls.length;
	await user.click(screen.getByRole("button", { name: "訂正を保存" }));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"最新の状態を確認",
	);
	expect(screen.getByLabelText("訂正後の文面")).toHaveProperty(
		"value",
		"競合した編集",
	);
	await waitFor(() =>
		expect(client.list.mock.calls.length).toBeGreaterThan(before),
	);
});

test("deactivate removes the item from the active list but keeps it as inactive", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "無効化" }));
	await screen.findByText("しおりはありません。");
	expect(client.deactivate).toHaveBeenCalledWith("main", "b0", {
		requestId: expect.any(String),
		expectedRevision: 1,
	});
	await user.click(screen.getByLabelText("無効化済みも表示"));
	await screen.findByText("既存のしおり");
	expect(screen.getByText("無効化済み", { selector: ".badge" })).toBeTruthy();
});

test("deactivate failure shows an error; retry reuses requestId", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	client.deactivate.mockRejectedValueOnce(new ApiError(503, "busy"));
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "無効化" }));
	expect((await screen.findByRole("alert")).textContent).toContain("busy");
	await user.click(screen.getByRole("button", { name: "無効化" }));
	await screen.findByText("しおりはありません。");
	const [first, second] = client.deactivate.mock.calls;
	expect(first?.[2].requestId).toBe(second?.[2].requestId);
});

test("load error is shown", async () => {
	const client = fakeContinuityClient();
	client.list.mockRejectedValue(new ApiError(500, "boom"));
	setup(client);
	expect(
		(await screen.findByRole("alert", {}, { timeout: 4000 })).textContent,
	).toContain("boom");
});

test("source viewer shows original text and status; history viewer lists events", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	client.source.mockResolvedValueOnce({
		bookmarkId: "b0",
		sourceMessageId: "m1",
		sourceDigest: "digest",
		status: "changed",
		message: { id: "m1", role: "user", text: "今の原文", createdAt: "x" },
	});
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "出典" }));
	await screen.findByText("今の原文");
	expect(screen.getByText(/変更あり/)).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "履歴" }));
	await screen.findByText(/最初の文面/);
});

test("source missing is shown as 欠落", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	client.source.mockResolvedValueOnce({
		bookmarkId: "b0",
		sourceMessageId: "m1",
		sourceDigest: "digest",
		status: "missing",
		message: null,
	});
	setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "出典" }));
	await screen.findByText(/欠落/);
});

test("a revise form opened before another writer's update cannot overwrite it", async () => {
	const client = fakeContinuityClient([bookmarkFixture()]);
	const queries = setup(client);
	await screen.findByText("既存のしおり");
	await user.click(screen.getByRole("button", { name: "訂正" }));
	await user.clear(screen.getByLabelText("訂正後の文面"));
	await user.type(screen.getByLabelText("訂正後の文面"), "古い版からの編集");
	client.list.mockResolvedValue({
		conversationId: "main",
		stateRevision: 2,
		bookmarks: [bookmarkFixture({ revision: 2, text: "他で更新された文面" })],
	});
	await queries.invalidateQueries();
	await screen.findByText(/最新の文面/);
	expect(screen.getByRole("button", { name: "訂正を保存" })).toHaveProperty(
		"disabled",
		true,
	);
	expect(client.revise).not.toHaveBeenCalled();
	await user.click(
		screen.getByRole("button", { name: "最新の版から編集し直す" }),
	);
	expect(screen.getByLabelText("訂正後の文面")).toHaveProperty(
		"value",
		"他で更新された文面",
	);
});
