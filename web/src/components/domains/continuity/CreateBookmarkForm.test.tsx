import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { user } from "./user";
import { afterEach, expect, test } from "vitest";
import { ApiError } from "../../../../../client/transport";
import { BookmarkList } from "./BookmarkList";
import { CreateBookmarkForm } from "./CreateBookmarkForm";
import { fakeContinuityClient } from "./fake-client";

afterEach(cleanup);
const messages = [
	{ id: "m1", text: "  来週までに仕様を固める  " },
	{ id: "m2", text: "予算は変えない" },
];
function setup(client = fakeContinuityClient()) {
	const queries = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queries}>
			<CreateBookmarkForm
				client={client}
				conversationId="main"
				messages={messages}
			/>
			<BookmarkList client={client} conversationId="main" />
		</QueryClientProvider>,
	);
	return client;
}

test("creating through the form sends the payload and refetches the list", async () => {
	const client = setup();
	await screen.findByText("しおりはありません。");
	expect(screen.getByLabelText("保存する文面")).toHaveProperty(
		"value",
		"来週までに仕様を固める",
	);
	await user.selectOptions(screen.getByLabelText("元の発言"), "m2");
	await user.selectOptions(screen.getByLabelText("種類"), "decision");
	expect(screen.getByLabelText("保存する文面")).toHaveProperty(
		"value",
		"予算は変えない",
	);
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	await screen.findByRole("status");
	expect(client.create).toHaveBeenCalledTimes(1);
	expect(client.create).toHaveBeenCalledWith("main", {
		requestId: expect.any(String),
		sourceMessageId: "m2",
		kind: "decision",
		text: "予算は変えない",
	});
	expect(
		await screen.findByText("予算は変えない", { selector: "p" }),
	).toBeTruthy();
	expect(screen.getByText("決定・制約", { selector: "strong" })).toBeTruthy();
	expect(client.list.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("a failed save shows an error and never a success message; retry of the same payload reuses requestId", async () => {
	const client = fakeContinuityClient();
	const create = client.create.getMockImplementation();
	client.create.mockRejectedValueOnce(new ApiError(503, "busy"));
	setup(client);
	await screen.findByText("しおりはありません。");
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	expect((await screen.findByRole("alert")).textContent).toContain("busy");
	expect(screen.queryByRole("status")).toBeNull();
	client.create.mockImplementation(create as never);
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	await screen.findByRole("status");
	const [first, second] = client.create.mock.calls;
	expect(first?.[1].requestId).toBe(second?.[1].requestId);
});

test("a changed payload gets a new requestId", async () => {
	const client = fakeContinuityClient();
	client.create.mockRejectedValue(new ApiError(503, "busy"));
	setup(client);
	await screen.findByText("しおりはありません。");
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	await screen.findByRole("alert");
	await user.selectOptions(screen.getByLabelText("種類"), "open_question");
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	await waitFor(() => expect(client.create).toHaveBeenCalledTimes(2));
	const [first, second] = client.create.mock.calls;
	expect(first?.[1].requestId).not.toBe(second?.[1].requestId);
});

test("409 keeps the input, refetches, and asks the user to re-check", async () => {
	const client = fakeContinuityClient();
	client.create.mockRejectedValueOnce(new ApiError(409, "request_conflict"));
	setup(client);
	await screen.findByText("しおりはありません。");
	const before = client.list.mock.calls.length;
	await user.clear(screen.getByLabelText("保存する文面"));
	await user.type(screen.getByLabelText("保存する文面"), "編集した文面");
	await user.click(screen.getByRole("button", { name: "しおりを保存" }));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"最新の状態を確認",
	);
	expect(screen.getByLabelText("保存する文面")).toHaveProperty(
		"value",
		"編集した文面",
	);
	await waitFor(() =>
		expect(client.list.mock.calls.length).toBeGreaterThan(before),
	);
	expect(screen.queryByRole("status")).toBeNull();
});
