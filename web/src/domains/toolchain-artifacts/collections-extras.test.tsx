import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { createWebAdapterRegistry } from "./registry";
import { ToolchainArtifactHost } from "./ToolchainArtifactHost";

const REV = "artifact:jobs.screen@1";
const ADAPTER = "adapter:jobs@1";
const TOKEN = "tok-one-time-0123";

const artifact = {
	kind: "artifact",
	id: "jobs.screen",
	revision: 1,
	title: "ジョブ",
	defaultVariant: "standard",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: {
				view: "collection-workspace",
				source: "jobs",
				title: "ジョブ",
			},
		},
	],
	sourceBindings: [
		{
			source: "jobs",
			adapterRef: ADAPTER,
			query: "query:jobs.list@1",
			target: "none",
		},
		{
			source: "kinds",
			adapterRef: ADAPTER,
			query: "query:jobs.kinds@1",
			target: "none",
		},
	],
	collections: [
		{
			source: "jobs",
			title: "ジョブ",
			rowKey: "id",
			columns: [
				{ key: "name", label: "名前" },
				{ key: "state", label: "状態", format: "badge" },
			],
			rowActions: [],
			refreshWhile: { key: "state", in: ["running"] },
			create: {
				actionId: "start",
				fields: [
					{
						fieldId: "name",
						label: "名前",
						control: "text",
						defaultValue: "新しいジョブ",
					},
					{
						fieldId: "kind",
						label: "種類",
						control: "select",
						optionsSource: "query:jobs.kinds@1",
						required: true,
					},
				],
			},
		},
	],
	actionBindings: [
		{
			actionId: "start",
			eventAction: "start",
			source: "jobs",
			operationId: "jobs.start",
			inputSchemaRef: "builtin:emptyInput",
			effect: "write",
			label: "開始",
		},
	],
} as unknown as ArtifactDefinitionV1;

function setup(rows: Array<{ id: string; name: string; state: string }>) {
	const receipt = { localToken: TOKEN };
	const submit = vi.fn(async (event: { eventId: string; input: unknown }) => ({
		httpStatus: 200,
		view: {
			eventId: event.eventId,
			status: "accepted",
			createdAt: new Date().toISOString(),
			result: {
				version: 1,
				executionId: "e",
				artifactRevisionId: REV,
				outcome: "completed",
				resultRefs: [],
				artifactRefs: [],
				receipt,
			},
		},
	}));
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: REV,
			digest: "d",
			scopeRef: "scope:main",
		})),
		toolchainArtifacts: vi.fn(async () => []),
		toolchainArtifactSource: vi.fn(async (_r: string, source: string) =>
			source === "kinds"
				? {
						revision: 0,
						data: {
							options: [
								{ value: "a", label: "種類A" },
								{ value: "b", label: "種類B" },
							],
						},
					}
				: { revision: 0, data: rows },
		),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: submit,
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
	};
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ToolchainArtifactHost
				client={client as never}
				adapters={createWebAdapterRegistry([])}
				artifactRevisionId={REV}
				artifactId="tab"
			/>
		</QueryClientProvider>,
	);
	return { client, submit };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test("a form starts from its registered default and offers the choices of its options source", async () => {
	const { submit } = setup([]);
	const form = await screen.findByRole("form", { name: "開始" });
	expect(
		(form.querySelector("input[type=text]") as HTMLInputElement).value,
	).toBe("新しいジョブ");
	await screen.findByRole("option", { name: "種類B" });
	// A value outside the source's choices is refused before anything is sent.
	fireEvent.submit(form);
	await screen.findByText("種類を入力してください。");
	fireEvent.change(form.querySelector("select")!, { target: { value: "b" } });
	fireEvent.submit(form);
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	expect(submit.mock.calls[0]![0].input).toEqual({
		name: "新しいジョブ",
		kind: "b",
	});
});

test("a one-time value of a settled write is shown once, can be copied, and is gone after closing", async () => {
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	setup([]);
	const form = await screen.findByRole("form", { name: "開始" });
	await screen.findByRole("option", { name: "種類A" });
	fireEvent.change(form.querySelector("select")!, { target: { value: "a" } });
	fireEvent.submit(form);
	const dialog = await screen.findByRole("dialog");
	expect(dialog.textContent).toContain(TOKEN);
	expect(dialog.textContent).toContain("閉じると再表示できません");
	fireEvent.click(screen.getByRole("button", { name: "コピー" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
	expect(sessionStorage.length).toBe(0);
	fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(document.body.textContent).not.toContain(TOKEN);
	vi.unstubAllGlobals();
});

test("the list is re-read every few seconds only while a watched row is in the watched state", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const running = setup([{ id: "j1", name: "実行中", state: "running" }]);
	await screen.findByText("実行中");
	const before = running.client.toolchainArtifactSource.mock.calls.filter(
		(c) => c[1] === "jobs",
	).length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3100);
	});
	expect(
		running.client.toolchainArtifactSource.mock.calls.filter(
			(c) => c[1] === "jobs",
		).length,
	).toBeGreaterThan(before);
	cleanup();
	const idle = setup([{ id: "j2", name: "終了済み", state: "done" }]);
	await screen.findByText("終了済み");
	const reads = () =>
		idle.client.toolchainArtifactSource.mock.calls.filter(
			(c) => c[1] === "jobs",
		).length;
	const start = reads();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(reads()).toBe(start);
});
