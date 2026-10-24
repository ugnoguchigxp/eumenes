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
const artifact = artifactDefinitionV1.parse(bundle.artifacts[0]);
const revision = "artifact:agency.todos@1";
const adapters = createWebAdapterRegistry([todosWebAdapter]);
const row: TodoPage["rows"][number] = {
	id: "one",
	title: "依頼 <script>alert(1)</script> *強調*",
	status: "todo",
	outcome: null,
	summary: null,
	pipeline: true,
	archived: false,
	updatedAt: "2026-10-24T00:00:00.000Z",
};
function page(query: TodoQuery): TodoPage {
	const states =
		query.state === "active"
			? (["todo", "done"] as const)
			: (["archived"] as const);
	return {
		...query,
		rows: states.map((state) => ({
			...row,
			id: `${state}-${query.pageIndex}`,
			title: `${state} ${query.pageIndex} の仕事`,
			status: state === "todo" ? ("waiting" as const) : ("done" as const),
			outcome: state === "todo" ? null : ("succeeded" as const),
			summary: state === "todo" ? "どの曲調にしますか" : "作成できました",
			archived: state === "archived",
		})),
		counts: { todo: 12, done: 11, archived: 28 },
		total: query.state === "active" ? 23 : 28,
	};
}
function setup(
	readWork: (query: TodoQuery, signal?: AbortSignal) => Promise<TodoPage>,
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
	render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client}
				adapters={adapters}
				artifactRevisionId={revision}
				artifactId="todos"
				conversationId="main"
			/>
		</QueryClientProvider>,
	);
	return client;
}

test("todo and done are rows of one table with one pagination and a changing state", async () => {
	const read = vi.fn(async (query: TodoQuery) => page(query));
	setup(read);
	await screen.findByText("todo 0 の仕事");
	await screen.findByText("done 0 の仕事");
	const table = screen.getByRole("table");
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent),
	).toEqual(["依頼内容", "状態"]);
	expect(within(table).getAllByRole("row")).toHaveLength(3);
	expect(within(table).getByText("todo")).toBeTruthy();
	expect(within(table).getByText("done")).toBeTruthy();
	expect(screen.getAllByRole("combobox")).toHaveLength(1);
	// The outcome and the one-line summary are the only result the screen shows; a waiting TODO shows its question.
	expect(screen.getByText("完了：作成できました")).toBeTruthy();
	expect(screen.getByText("確認待ち：どの曲調にしますか")).toBeTruthy();
	expect(screen.queryByText("archived 0 の仕事")).toBeNull();
	expect(screen.queryByRole("button", { name: /詳細/ })).toBeNull();
	expect(document.querySelector(".ds-todo-workspace time")).toBeNull();
	fireEvent.click(
		screen.getByRole("button", { name: "todo・doneの次のページ" }),
	);
	await screen.findByText("todo 1 の仕事");
	await screen.findByText("done 1 の仕事");
	fireEvent.change(
		screen.getByRole("combobox", { name: "todo・doneの表示件数" }),
		{ target: { value: "25" } },
	);
	await waitFor(() =>
		expect(read).toHaveBeenLastCalledWith(
			{ state: "active", pageIndex: 0, pageSize: 25 },
			expect.any(AbortSignal),
		),
	);
	await screen.findByText("todo 0 の仕事");
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "更新" }).hasAttribute("disabled"),
		).toBe(false),
	);
	const before = read.mock.calls.length;
	// The same execution remains one row as its reporting state changes.
	read.mockResolvedValueOnce({
		...page({ state: "active", pageIndex: 0, pageSize: 25 }),
		rows: [
			{
				...row,
				id: "todo-0",
				title: "todo 0 の仕事",
				status: "done",
				outcome: "succeeded",
			},
		],
	});
	fireEvent.click(screen.getByRole("button", { name: "更新" }));
	await screen.findByText("todo 0 の仕事");
	await waitFor(() =>
		expect(
			within(screen.getByRole("table")).queryByText("todo", { exact: true }),
		).toBeNull(),
	);
	expect(read.mock.calls.length).toBe(before + 1);
	expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
	expect(within(screen.getByRole("table")).getByText("done")).toBeTruthy();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "archived" }));
	await screen.findByText("archived 0 の仕事");
	expect(screen.getAllByRole("table")).toHaveLength(1);
	expect(screen.queryByText("todo 0 の仕事")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "報告済みの次のページ" }));
	await screen.findByText("archived 1 の仕事");
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
	fireEvent.mouseDown(screen.getByRole("tab", { name: "archived" }));
	await screen.findByText("archived 0 の仕事");
	expect(pending.every((p) => p.signal?.aborted)).toBe(true);
	await act(async () => {
		for (const p of pending) p.finish(page(p.query));
	});
	expect(screen.queryByText("todo 0 の仕事")).toBeNull();
	expect(screen.queryByText("done 0 の仕事")).toBeNull();
});

test("the combined empty table remains visible; a failed read can recover without a modal or HTML execution", async () => {
	const empty = (query: TodoQuery): TodoPage => ({
		...page(query),
		rows: [],
		total: 0,
		counts: { todo: 0, done: 0, archived: 0 },
	});
	const read = vi.fn(async (query: TodoQuery) => empty(query));
	setup(read);
	await screen.findByText("進行中・未報告の仕事はありません。");
	read.mockRejectedValueOnce(new Error("offline"));
	fireEvent.click(screen.getByRole("button", { name: "更新" }));
	await screen.findByRole("alert");
	expect(screen.queryByText("進行中・未報告の仕事はありません。")).toBeNull();
	read.mockResolvedValueOnce({
		...page({ state: "active", pageIndex: 0, pageSize: 10 }),
		rows: [row],
	});
	fireEvent.click(screen.getByRole("button", { name: "更新" }));
	await screen.findByText(row.title);
	expect(document.querySelector(".ds-todo-workspace script")).toBeNull();
	expect(document.querySelector(".ds-todo-workspace time")).toBeNull();
	expect(screen.queryByRole("dialog")).toBeNull();
});
