import { afterEach, expect, test, vi } from "vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { todosWebAdapter } from "./toolchain-adapter";
import { artifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import {
	todoSourceQuery,
	type TodoPage,
	type TodoQuery,
} from "../../../../api/domains/agent-runtime/contracts";
import { createClient } from "../../../../client";

afterEach(cleanup);
const bundle = JSON.parse(
	readFileSync(
		"api/domains/capabilities/bundles/agency-todos-screen.bundle.json",
		"utf8",
	),
);
const artifact = artifactDefinitionV1.parse(bundle.artifacts.at(-1));
const revision = "artifact:agency.todos@4";
const adapters = createWebAdapterRegistry([todosWebAdapter]);
const row: TodoPage["rows"][number] = {
	id: "one",
	request: "依頼 <script>alert(1)</script> *強調*",
	status: "todo",
	outcome: null,
	summary: null,
	pipeline: true,
	archived: false,
	updatedAt: "2026-10-24T00:00:00.000Z",
};
/** Open work asks a question (`todo`) or runs (`run`); the archive holds what finished. */
function page(query: TodoQuery): TodoPage {
	const states =
		query.state === "active"
			? (["todo", "run"] as const)
			: (["archived"] as const);
	return {
		...query,
		rows: states.map((state) => ({
			...row,
			id: `${state}-${query.pageIndex}`,
			request: `${state} ${query.pageIndex} の仕事`,
			status:
				state === "todo"
					? ("waiting" as const)
					: state === "run"
						? ("todo" as const)
						: ("done" as const),
			outcome: state === "archived" ? ("succeeded" as const) : null,
			summary:
				state === "todo"
					? "どの曲調にしますか"
					: state === "archived"
						? "作成できました"
						: null,
			archived: state === "archived",
		})),
		counts: { todo: 23, archived: 28 },
		total: query.state === "active" ? 23 : 28,
	};
}
const accepted = {
	httpStatus: 200,
	view: {
		eventId: "x",
		status: "accepted" as const,
		createdAt: new Date().toISOString(),
		result: {
			version: 1 as const,
			executionId: "e",
			artifactRevisionId: revision,
			outcome: "completed" as const,
			resultRefs: [],
			artifactRefs: [],
			receipt: { todoId: "run-0" },
		},
	},
};
function setup(
	readWork: (query: TodoQuery, signal?: AbortSignal) => Promise<TodoPage>,
	visible = true,
) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const client = {
		...createClient("http://127.0.0.1:4444"),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: revision,
			digest: "fixture",
			scopeRef: "scope:fixture",
		})),
		toolchainArtifacts: vi.fn(async () => [
			{
				artifactRevisionId: revision,
				title: artifact.title,
				adapterRef: "adapter:task-execution@1",
				launcher: artifact.launcher,
			},
		]),
		submitToolchainAction: vi.fn(async (_event: object) => accepted),
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
		toolchainArtifactSource: vi.fn(
			async (
				_revision: string,
				_source: string,
				_target?: string,
				signal?: AbortSignal,
				params?: unknown,
			) => {
				const input = todoSourceQuery.parse(params);
				return {
					revision: 200,
					data: await readWork(
						{
							state: input.state,
							pageIndex: input.pageIndex,
							pageSize: input.pageSize,
						},
						signal,
					),
				};
			},
		),
	};
	const content = (shown: boolean) => (
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client}
				adapters={adapters}
				artifactRevisionId={revision}
				artifactId="todos"
				conversationId="main"
				visible={shown}
			/>
		</QueryClientProvider>
	);
	const view = render(content(visible));
	return { client, show: (shown: boolean) => view.rerender(content(shown)) };
}

test("open work is one paged table with an archive button on each row; the archive is apart", async () => {
	const read = vi.fn(async (query: TodoQuery) => page(query));
	setup(read);
	await screen.findByText("todo 0 の仕事");
	await screen.findByText("run 0 の仕事");
	const table = screen.getByRole("table");
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent),
	).toEqual(["依頼内容", "状態", "操作"]);
	expect(within(table).getAllByRole("row")).toHaveLength(3);
	expect(within(table).getAllByText("todo", { exact: true })).toHaveLength(2);
	expect(
		within(table).getAllByRole("button", { name: /をアーカイブ$/ }),
	).toHaveLength(2);
	expect(screen.getAllByRole("combobox")).toHaveLength(1);
	// A waiting TODO shows its question; no result is shown for open work.
	expect(screen.getByText("確認待ち：どの曲調にしますか")).toBeTruthy();
	expect(screen.queryByText("archived 0 の仕事")).toBeNull();
	expect(read.mock.calls.every(([query]) => query.state === "active")).toBe(
		true,
	);
	expect(screen.queryByRole("button", { name: /詳細/ })).toBeNull();
	expect(document.querySelector(".ds-todo-workspace time")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "進行中の次のページ" }));
	await screen.findByText("todo 1 の仕事");
	fireEvent.change(screen.getByRole("combobox", { name: "進行中の表示件数" }), {
		target: { value: "25" },
	});
	await waitFor(() =>
		expect(read).toHaveBeenLastCalledWith(
			{ state: "active", pageIndex: 0, pageSize: 25 },
			expect.any(AbortSignal),
		),
	);
	await screen.findByText("todo 0 の仕事");
	fireEvent.mouseDown(screen.getByRole("tab", { name: "アーカイブ" }));
	await screen.findByText("archived 0 の仕事");
	expect(screen.getAllByRole("table")).toHaveLength(1);
	expect(screen.queryByText("todo 0 の仕事")).toBeNull();
	// The outcome and the one-line summary are the only result the screen shows.
	expect(screen.getByText("完了：作成できました")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /をアーカイブ$/ })).toBeNull();
	expect(read).toHaveBeenLastCalledWith(
		{ state: "archived", pageIndex: 0, pageSize: 20 },
		expect.any(AbortSignal),
	);
	expect(
		screen.queryByRole("button", { name: "アーカイブの次のページ" }),
	).toBeNull();
	expect(screen.queryByRole("combobox")).toBeNull();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "進行中" }));
	await screen.findByText("todo 0 の仕事");
	expect(read).toHaveBeenLastCalledWith(
		{ state: "active", pageIndex: 0, pageSize: 25 },
		expect.any(AbortSignal),
	);
});

test("archiving asks first; once confirmed it sends the archive and reads the page again", async () => {
	const read = vi.fn(async (query: TodoQuery) => page(query));
	const { client } = setup(read);
	await screen.findByText("run 0 の仕事");
	fireEvent.click(
		screen.getByRole("button", { name: "「run 0 の仕事」をアーカイブ" }),
	);
	const dialog = await screen.findByRole("dialog");
	expect(
		within(dialog).getByText("実行中の仕事を止めてアーカイブしますか"),
	).toBeTruthy();
	// Cancelling sends nothing.
	fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(client.submitToolchainAction).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "「run 0 の仕事」をアーカイブ" }),
	);
	const reads = read.mock.calls.length;
	fireEvent.click(
		within(await screen.findByRole("dialog")).getByRole("button", {
			name: "止めてアーカイブ",
		}),
	);
	await waitFor(() =>
		expect(client.submitToolchainAction).toHaveBeenCalledTimes(1),
	);
	expect(client.submitToolchainAction.mock.calls[0]![0]).toMatchObject({
		artifactRevisionId: revision,
		source: "agency-todos",
		actionId: "archive",
		input: { todoId: "run-0" },
	});
	await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
});

test("switching to archived cancels the pending combined read and ignores its late response", async () => {
	const pending: Array<{
		finish: (value: TodoPage) => void;
		signal?: AbortSignal;
		query: TodoQuery;
	}> = [];
	setup((query, signal) =>
		query.state === "archived"
			? Promise.resolve(page(query))
			: new Promise((resolve) => {
					pending.push({ finish: resolve, query, signal });
				}),
	);
	await waitFor(() => expect(pending).toHaveLength(1));
	fireEvent.mouseDown(screen.getByRole("tab", { name: "アーカイブ" }));
	await screen.findByText("archived 0 の仕事");
	expect(pending.every((p) => p.signal?.aborted)).toBe(true);
	await act(async () => {
		for (const p of pending) p.finish(page(p.query));
	});
	expect(screen.queryByText("todo 0 の仕事")).toBeNull();
	expect(screen.queryByText("run 0 の仕事")).toBeNull();
});

test("the combined empty table remains visible; a failed read can recover without a modal or HTML execution", async () => {
	const empty = (query: TodoQuery): TodoPage => ({
		...page(query),
		rows: [],
		total: 0,
		counts: { todo: 0, archived: 0 },
	});
	const read = vi.fn(async (query: TodoQuery) => empty(query));
	setup(read);
	await screen.findByText("進行中の仕事はありません。");
	read.mockRejectedValueOnce(new Error("offline"));
	fireEvent.click(screen.getByRole("button", { name: "更新" }));
	await screen.findByRole("alert");
	expect(screen.queryByText("進行中の仕事はありません。")).toBeNull();
	read.mockResolvedValueOnce({
		...page({ state: "active", pageIndex: 0, pageSize: 10 }),
		rows: [row],
	});
	fireEvent.click(screen.getByRole("button", { name: "更新" }));
	await screen.findByText(row.request);
	expect(document.querySelector(".ds-todo-workspace script")).toBeNull();
	expect(document.querySelector(".ds-todo-workspace time")).toBeNull();
	expect(screen.queryByRole("dialog")).toBeNull();
});

test("a hidden artifact reads no TODOs and reads only active work when shown", async () => {
	const read = vi.fn(async (query: TodoQuery) => page(query));
	const view = setup(read, false);
	await screen.findByRole("tab", { name: "進行中" });
	expect(read).not.toHaveBeenCalled();
	view.show(true);
	await screen.findByText("todo 0 の仕事");
	expect(read.mock.calls.every(([query]) => query.state === "active")).toBe(
		true,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "アーカイブ" }));
	await screen.findByText("archived 0 の仕事");
	expect(read).toHaveBeenLastCalledWith(
		{ state: "archived", pageIndex: 0, pageSize: 20 },
		expect.any(AbortSignal),
	);
});
