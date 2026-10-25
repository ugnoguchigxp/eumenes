import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	renderHook,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import { changeRoots, queryRoots } from "../../queryKeys";
import {
	type AdapterHostContext,
	createWebAdapterRegistry,
} from "../toolchain-artifacts/registry";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { boardFixture } from "./fixtures";
import { kanbanWebAdapter, sharedKanbanWebAdapter } from "./toolchain-adapter";

const REV = "artifact:kanban.board@1";
const adapters = createWebAdapterRegistry([kanbanWebAdapter]);

const write = (eventAction: string, operationId: string) => ({
	actionId: eventAction,
	eventAction,
	source: "kanban",
	operationId,
	inputSchemaRef: `schema:${eventAction}@1`,
	effect: "write",
});
const artifact = {
	kind: "artifact",
	id: "kanban.board",
	revision: 1,
	title: "タスクボード",
	defaultVariant: "standard",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: {
				view: "kanban-board",
				source: "kanban",
				title: "タスクボード",
			},
		},
	],
	sourceBindings: [
		{
			source: "kanban",
			adapterRef: "adapter:kanban@1",
			query: "query:kanban.board@1",
			target: "none",
		},
	],
	actionBindings: [
		write("kanban-add", "kanban.add"),
		write("kanban-move", "kanban.move"),
		write("kanban-run", "kanban.run"),
	],
};
const accepted = {
	httpStatus: 200,
	view: {
		eventId: "x",
		status: "accepted",
		createdAt: new Date().toISOString(),
		result: {
			version: 1,
			executionId: "e",
			artifactRevisionId: REV,
			outcome: "completed",
			resultRefs: [],
			artifactRefs: [],
			receipt: { kind: "kanban_receipt" },
		},
	},
};

function makeClient(over: Record<string, unknown> = {}) {
	return {
		identity: "http://127.0.0.1:1",
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: REV,
			digest: "d",
			scopeRef: "scope:main",
		})),
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 7,
			data: boardFixture,
		})),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: vi.fn(async (_event: object) => accepted),
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
		answerToolchainInteraction: vi.fn(),
		...over,
	};
}
function mount(client: ReturnType<typeof makeClient>) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client as never}
				adapters={adapters}
				artifactRevisionId={REV}
				artifactId="tab"
			/>
		</QueryClientProvider>,
	);
	return cache;
}
const settle = () =>
	waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeNull());

beforeEach(() => sessionStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const card of document.querySelectorAll("[data-card-id]")) card.remove();
});

test("the board is read from the kanban source and drawn by the registered view", async () => {
	const client = makeClient();
	mount(client);
	await screen.findByRole("heading", { name: "タスクボード" });
	expect(client.toolchainArtifactSource).toHaveBeenCalledWith(
		REV,
		"kanban",
		undefined,
		expect.anything(),
	);
	expect(screen.getAllByRole("article")).toHaveLength(6);
});

test("adding goes through the outbox with the board revision and reads the board again", async () => {
	const client = makeClient();
	mount(client);
	fireEvent.click(await screen.findByRole("button", { name: "タスクを追加" }));
	fireEvent.change(screen.getByLabelText("タイトル"), {
		target: { value: "新しい作業" },
	});
	fireEvent.change(screen.getByLabelText("依頼内容"), {
		target: { value: "手順を直す" },
	});
	fireEvent.click(screen.getByRole("button", { name: "追加" }));
	await waitFor(() =>
		expect(client.submitToolchainAction).toHaveBeenCalledOnce(),
	);
	expect(client.submitToolchainAction.mock.calls[0]?.[0]).toMatchObject({
		version: 1,
		artifactRevisionId: REV,
		source: "kanban",
		sourceRevision: 7,
		actionId: "kanban-add",
		scopeRef: "scope:main",
		input: { title: "新しい作業", prompt: "手順を直す" },
	});
	await waitFor(() =>
		expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(1),
	);
	await settle();
});

test("moving sends decimal-string revision and an empty beforeCardId for the end of the column", async () => {
	const client = makeClient();
	mount(client);
	const card = await screen.findByRole("article", {
		name: "README の手順修正",
	});
	fireEvent.click(within(card).getByRole("button", { name: "移動" }));
	fireEvent.click(screen.getByRole("radio", { name: "Done・Blocker" }));
	fireEvent.click(screen.getByRole("button", { name: "移動する" }));
	await waitFor(() =>
		expect(client.submitToolchainAction).toHaveBeenCalledOnce(),
	);
	expect(client.submitToolchainAction.mock.calls[0]?.[0]).toMatchObject({
		actionId: "kanban-move",
		input: {
			cardId: "a",
			expectedRevision: "2",
			column: "finished",
			beforeCardId: "",
		},
	});
});

test("a revision conflict is worded in Japanese and the board is read again", async () => {
	const client = makeClient({
		submitToolchainAction: vi.fn(async () => ({
			httpStatus: 200,
			view: {
				eventId: "x",
				status: "rejected",
				errorCode: "revision_conflict",
				createdAt: new Date().toISOString(),
			},
		})),
	});
	mount(client);
	const card = await screen.findByRole("article", {
		name: "README の手順修正",
	});
	fireEvent.click(within(card).getByRole("button", { name: "実行" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("他の操作でタスクの状態が変わりました");
	await waitFor(() =>
		expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(1),
	);
});

test("kanban error codes are worded for people", async () => {
	for (const [code, text] of [
		["kanban_card_busy", "実行中のため"],
		["kanban_not_runnable", "状態を追えない"],
		["kanban_queue_paused", "実行キューが停止中"],
		["kanban_card_not_found", "見つかりません"],
	] as const) {
		const client = makeClient({
			submitToolchainAction: vi.fn(async () => {
				throw new ApiError(409, code);
			}),
		});
		mount(client);
		const card = await screen.findByRole("article", {
			name: "README の手順修正",
		});
		fireEvent.click(within(card).getByRole("button", { name: "実行" }));
		expect((await screen.findByRole("alert")).textContent).toContain(text);
		cleanup();
	}
});

test("the kanban root is refreshed by backend change events", () => {
	expect(changeRoots).toContain(queryRoots.kanban);
});

test("an unreadable board shows the error and no board", async () => {
	const client = makeClient({
		toolchainArtifactSource: vi.fn(async () => {
			throw new Error("down");
		}),
	});
	mount(client);
	await screen.findByText(
		"タスクボードを取得できません。接続を確認してください。",
	);
	expect(screen.queryByRole("article")).toBeNull();
});

function mountBoard(targetRef?: string) {
	const setTargetRef = vi.fn();
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 7,
			data: boardFixture,
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		({ target }: { target?: string }) =>
			sharedKanbanWebAdapter.useArtifact({
				client,
				artifact,
				artifactRevisionId: REV,
				targetRef: target,
				setTargetRef,
				visible: true,
			} as unknown as AdapterHostContext),
		{
			initialProps: { target: targetRef },
			wrapper: ({ children }: { children: React.ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	return { hook, setTargetRef, cache };
}

/** The card the board draws. */
function drawCard(cardId: string) {
	const element = document.createElement("div");
	element.setAttribute("data-card-id", cardId);
	element.scrollIntoView = vi.fn();
	document.body.append(element);
	return element;
}

test("both adapter versions name the same board resource", () => {
	expect(kanbanWebAdapter.focus).toBe(sharedKanbanWebAdapter.focus);
	expect(sharedKanbanWebAdapter.adapterRef).toBe("adapter:kanban@2");
});

test("focus inspects the card, marks it for two seconds and viewing names it", async () => {
	const { hook, setTargetRef, cache } = mountBoard();
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const card = drawCard("d");
	expect(sharedKanbanWebAdapter.viewing?.()).toBeNull();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let done: Promise<boolean> | undefined;
	await act(async () => {
		done = sharedKanbanWebAdapter.focus?.("d");
		await vi.advanceTimersByTimeAsync(200);
	});
	await expect(done).resolves.toBe(true);
	expect(setTargetRef).toHaveBeenCalledWith("d");
	expect(card.getAttribute("data-resource-focus")).toBe("true");
	// The host feeds the inspected card back as the screen's target.
	hook.rerender({ target: "d" });
	expect(sharedKanbanWebAdapter.viewing?.()).toBe(
		"eumenes://code.task/kanban%3Ad",
	);
	await vi.advanceTimersByTimeAsync(2_010);
	expect(card.hasAttribute("data-resource-focus")).toBe(false);
	cache.clear();
});

test("focus says no to a card the board lacks", async () => {
	const { hook, setTargetRef, cache } = mountBoard();
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const unknown = sharedKanbanWebAdapter.focus?.("missing");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(unknown).resolves.toBe(false);
	expect(setTargetRef).not.toHaveBeenCalled();
	cache.clear();
});
