import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiConnectionError, ApiError } from "../../../../client/transport";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { timerWebAdapter } from "./toolchain-adapter";

const REV = "artifact:timers.workspace@1";
const TIMER = "10000000-0000-4000-8000-000000000001";
const adapters = createWebAdapterRegistry([timerWebAdapter]);

const sourceBindings = [
	{
		source: "timer-setup",
		adapterRef: "adapter:timers@1",
		query: "query:timers.setup@1",
		target: "none",
	},
	{
		source: "timer-current",
		adapterRef: "adapter:timers@1",
		query: "query:timers.current@1",
		target: "required",
	},
	{
		source: "duration-question",
		adapterRef: "adapter:timers@1",
		query: "query:timers.question@1",
		target: "optional",
	},
];
const local = (eventAction: string, source: string) => ({
	actionId: `${eventAction}-${source}`,
	eventAction,
	source,
	inputSchemaRef: "builtin:emptyInput",
	effect: "local",
});
const write = (eventAction: string, operationId: string) => ({
	actionId: eventAction,
	eventAction,
	source: "timer-current",
	operationId,
	inputSchemaRef: "builtin:emptyInput",
	effect: "write",
});
const watch = { view: "timer-workspace", source: "timer-current" };
const ask = {
	view: "question",
	source: "duration-question",
	title: "所要時間の確認",
};
const artifact = {
	kind: "artifact",
	id: "timers.workspace",
	revision: 1,
	title: "タイマー（データドリブン）",
	defaultVariant: "standard",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: watch,
			questionDefinition: {
				view: "layout",
				direction: "stack",
				children: [watch, ask],
			},
		},
		{
			id: "variant-b",
			label: "格子",
			definition: { view: "layout", direction: "grid", children: [watch] },
		},
	],
	sourceBindings,
	actionBindings: [
		{
			actionId: "timer-start",
			eventAction: "timer-start",
			source: "timer-setup",
			operationId: "timers.start",
			inputSchemaRef: "builtin:timerHms",
			inputAdapterRef: "input:timer-hms@1",
			effect: "write",
		},
		write("timer-pause", "timers.pause"),
		write("timer-resume", "timers.resume"),
		write("timer-cancel", "timers.cancel"),
		{
			actionId: "answer",
			eventAction: "answer",
			source: "duration-question",
			answer: true,
			inputSchemaRef: "builtin:timerDurationAnswer",
			effect: "write",
		},
		local("clock-mode", "timer-setup"),
		local("clock-mode", "timer-current"),
		local("stopwatch-start", "timer-current"),
		local("timer-new", "timer-current"),
	],
};

function timerDto(extra: object = {}, seconds = 180) {
	const now = Date.now();
	return {
		id: TIMER,
		label: "タイマー",
		revision: 0,
		state: "active" as const,
		durationSeconds: seconds,
		remainingSeconds: seconds,
		startedAt: new Date(now).toISOString(),
		dueAt: new Date(now + seconds * 1000).toISOString(),
		cancelledAt: null,
		pausedAt: null,
		bodyExpired: false,
		conversationId: null,
		originRunId: null,
		originMessageId: null,
		errorCode: null,
		...extra,
	};
}
function result(action: string, timer = timerDto()) {
	return {
		version: 1,
		executionId: "e",
		artifactRevisionId: REV,
		outcome: "completed",
		resultRefs: [],
		artifactRefs: [],
		receipt: {
			kind: "timer_action",
			action,
			operationId: "20000000-0000-4000-8000-000000000001",
			serverNow: new Date().toISOString(),
			timer,
			...(action === "started"
				? { artifact: { kind: "timer", version: 1, timerId: timer.id } }
				: {}),
		},
	};
}
const accepted = (res: object) => ({
	httpStatus: 200,
	view: {
		eventId: "x",
		status: "accepted",
		createdAt: new Date().toISOString(),
		result: res,
	},
});

function makeClient(over: Record<string, unknown> = {}) {
	return {
		identity: "http://127.0.0.1:1",
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: REV,
			digest: "d",
			scopeRef: "scope:main",
		})),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: vi.fn(),
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
		answerToolchainInteraction: vi.fn(),
		timer: vi.fn(),
		timers: vi.fn(async () => ({
			serverNow: new Date().toISOString(),
			items: [],
			nextCursor: null,
		})),
		...over,
	};
}

function mount(
	client: ReturnType<typeof makeClient>,
	variantId?: string,
	initialTarget?: string,
) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const changed = vi.fn();
	function Host() {
		const [target, setTarget] = useState<string | undefined>(initialTarget);
		return (
			<ToolchainArtifactHost
				client={client as never}
				adapters={adapters}
				artifactRevisionId={REV}
				artifactId="tab"
				variantId={variantId}
				targetRef={target}
				onTargetChange={(ref) => {
					changed(ref);
					setTarget(ref);
				}}
			/>
		);
	}
	render(
		<QueryClientProvider client={cache}>
			<Host />
		</QueryClientProvider>,
	);
	return { changed, cache };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test("with no saved timer the one clock leaf shows the setup state and starting sends the raw h/m/s as the setup source", async () => {
	const submit = vi.fn(async (_event: object) => accepted(result("started")));
	const client = makeClient({
		submitToolchainAction: submit,
		timer: vi.fn(() => new Promise(() => {})),
	});
	const { changed } = mount(client);
	fireEvent.change(await screen.findByLabelText("分"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "30" } });
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await waitFor(() => expect(changed).toHaveBeenCalledWith(TIMER));
	expect(submit).toHaveBeenCalledOnce();
	expect(submit.mock.calls[0]![0]).toMatchObject({
		version: 1,
		artifactRevisionId: REV,
		source: "timer-setup",
		sourceRevision: 0,
		actionId: "timer-start",
		scopeRef: "scope:main",
		input: { hours: "00", minutes: "1", seconds: "30" },
	});
	expect(submit.mock.calls[0]![0]).not.toHaveProperty("targetRef");
	// The confirmed receipt keeps the clock visible while the first GET is pending.
	await screen.findByRole("button", { name: "停止する" });
	expect(screen.getByRole("timer")).toBeDefined();
	expect(screen.queryByText("読み込んでいます")).toBeNull();
	expect(sessionStorage.length).toBe(0);
});

test("clock binding measures the real request round trip before rendering", async () => {
	let mono = 100;
	vi.spyOn(performance, "now").mockImplementation(() => mono);
	const client = makeClient({
		timer: vi.fn(async () => {
			mono = 2100;
			return {
				serverNow: "2026-10-10T00:00:00Z",
				timer: timerDto(
					{ dueAt: "2026-10-10T00:00:03Z", startedAt: "2026-10-10T00:00:00Z" },
					3,
				),
				notification: null,
			};
		}),
	});
	mount(client, undefined, TIMER);
	await waitFor(() =>
		expect(screen.getByRole("timer").textContent).toBe("00:00:02"),
	);
	expect((client.timer as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(
		2,
	);
});

const paused = () =>
	timerDto({
		revision: 5,
		state: "paused",
		pausedAt: new Date().toISOString(),
	});
/** The timer service answers with the state the last accepted pause left behind. */
function activeClient(
	server: { paused: boolean },
	over: Record<string, unknown> = {},
) {
	return makeClient({
		timer: vi.fn(async () => ({
			serverNow: new Date().toISOString(),
			timer: server.paused ? paused() : timerDto({ revision: 4 }),
			notification: null,
		})),
		...over,
	});
}

test("pause goes to the registered action with the saved timer as target and its revision", async () => {
	const server = { paused: false };
	const submit = vi.fn(async (_event: object) => {
		server.paused = true;
		return accepted(result("paused", paused()));
	});
	const client = activeClient(server, { submitToolchainAction: submit });
	mount(client, undefined, TIMER);
	fireEvent.click(await screen.findByRole("button", { name: "停止する" }));
	await screen.findByRole("button", { name: "再開する" });
	expect(submit.mock.calls[0]![0]).toMatchObject({
		source: "timer-current",
		sourceRevision: 4,
		targetRef: TIMER,
		actionId: "timer-pause",
		input: {},
	});
});

test("a lost answer is shown as unknown, not failed, and the retry reuses the same event", async () => {
	const server = { paused: false };
	const submit = vi
		.fn()
		.mockRejectedValueOnce(new ApiConnectionError())
		.mockImplementationOnce(async () => {
			server.paused = true;
			return accepted(result("paused", paused()));
		});
	const client = activeClient(server, { submitToolchainAction: submit });
	mount(client, undefined, TIMER);
	fireEvent.click(await screen.findByRole("button", { name: "停止する" }));
	await screen.findByText(/操作の結果を確認できていません/);
	expect(screen.queryByRole("alert")).toBeNull();
	expect(sessionStorage.length).toBe(1);
	fireEvent.click(screen.getByRole("button", { name: "停止する" }));
	await screen.findByRole("button", { name: "再開する" });
	expect(submit.mock.calls[1]![0]).toEqual(submit.mock.calls[0]![0]);
	expect(sessionStorage.length).toBe(0);
});

test("a confirmed conflict is shown as a failure, rereads the timer and never resends", async () => {
	const submit = vi.fn(async (_event: object) => ({
		httpStatus: 200,
		view: {
			eventId: "x",
			status: "rejected",
			errorCode: "revision_conflict",
			createdAt: new Date().toISOString(),
		},
	}));
	const client = activeClient(
		{ paused: false },
		{ submitToolchainAction: submit },
	);
	mount(client, undefined, TIMER);
	fireEvent.click(await screen.findByRole("button", { name: "停止する" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("alert").textContent).toMatch(/状態が変わりました/);
	await waitFor(() =>
		expect(
			(client.timer as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeGreaterThan(1),
	);
	expect(submit).toHaveBeenCalledOnce();
	expect(sessionStorage.length).toBe(0);
});

test("invalid input is explained in Japanese and nothing is kept", async () => {
	const submit = vi.fn(async (_event: object) => {
		throw new ApiError(422, "invalid_input", "r", undefined, {
			error: "invalid_input",
			fieldErrors: [{ field: "durationSeconds", message: "too_small" }],
		});
	});
	mount(makeClient({ submitToolchainAction: submit }));
	fireEvent.change(await screen.findByLabelText("分"), {
		target: { value: "0" },
	});
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "0" } });
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await screen.findByText("時間は1秒〜24時間で入力してください");
	expect(screen.queryByText("too_small")).toBeNull();
	expect(sessionStorage.length).toBe(0);
});

test("stopwatch and mode changes stay local", async () => {
	const submit = vi.fn();
	mount(makeClient({ submitToolchainAction: submit }));
	fireEvent.click(
		await screen.findByRole("button", { name: "ストップウォッチ" }),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("heading", { name: "ストップウォッチ" }),
		).toBeDefined(),
	);
	expect(submit).not.toHaveBeenCalled();
});

test("an open question swaps in the question definition and a worded answer reaches the interactions API", async () => {
	const answer = vi.fn(async () => ({}));
	const interaction = {
		id: "i1",
		conversationId: "main",
		status: "waiting_input",
		revision: 2,
		chainRevisionId: "toolchain:timers.manage@2",
		artifactRevisionId: REV,
		question: {
			questionId: "40000000-0000-4000-8000-000000000001",
			prompt: "何分のタイマーにしますか？",
			inputSchemaRef: "builtin:timerDurationAnswer",
			revision: 2,
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		},
		questionCount: 1,
		receiptRef: null,
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const client = makeClient({
		toolchainInteractions: vi.fn(async () => [interaction]),
		answerToolchainInteraction: answer,
	});
	mount(client);
	await screen.findByText("何分のタイマーにしますか？");
	const box = screen.getByLabelText("回答");
	fireEvent.change(box, { target: { value: "3" } });
	fireEvent.click(screen.getByRole("button", { name: "回答する" }));
	await screen.findByText(/単位を付けて入力してください/);
	expect(answer).not.toHaveBeenCalled();
	fireEvent.change(box, { target: { value: "3分" } });
	fireEvent.click(screen.getByRole("button", { name: "回答する" }));
	await waitFor(() => expect(answer).toHaveBeenCalledOnce());
	expect(answer.mock.calls[0]).toEqual([
		"i1",
		expect.objectContaining({
			questionId: "40000000-0000-4000-8000-000000000001",
			expectedRevision: 2,
			input: { durationSeconds: 180 },
		}),
	]);
});

test("the variant is chosen by id; an unknown one is an error, not a silent default", async () => {
	mount(makeClient(), "variant-b");
	await screen.findByRole("timer");
	cleanup();
	mount(makeClient(), "no-such-variant");
	await screen.findByText("指定された表示バリアントが見つかりません。");
});

test("an unsent operation left by a reload is reconciled with its own id, not restarted", async () => {
	const event = {
		version: 1,
		eventId: "50000000-0000-4000-8000-000000000001",
		eventCreatedAt: new Date().toISOString(),
		eventExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
		artifactId: "tab",
		artifactRevisionId: REV,
		source: "timer-setup",
		sourceRevision: 0,
		actionId: "timer-start",
		scopeRef: "scope:main",
		input: { hours: "0", minutes: "3", seconds: "0" },
	};
	sessionStorage.setItem(
		"eumenes.toolchain-outbox.v1:http://127.0.0.1:1",
		JSON.stringify([{ event, status: "indeterminate" }]),
	);
	const lookup = vi.fn(async () => ({
		eventId: event.eventId,
		status: "accepted",
		createdAt: new Date().toISOString(),
		result: result("started"),
	}));
	const client = makeClient({ toolchainAction: lookup });
	mount(client);
	await screen.findByText(/前回の操作の結果を確認し/);
	expect(lookup).toHaveBeenCalledWith(event.eventId, expect.anything());
	expect(client.submitToolchainAction).not.toHaveBeenCalled();
	expect(sessionStorage.length).toBe(0);
});

test("an operation issued under another scope is dropped with a notice", async () => {
	sessionStorage.setItem(
		"eumenes.toolchain-outbox.v1:http://127.0.0.1:1",
		JSON.stringify([
			{
				event: {
					version: 1,
					eventId: "50000000-0000-4000-8000-000000000002",
					eventCreatedAt: new Date().toISOString(),
					eventExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
					artifactId: "tab",
					artifactRevisionId: REV,
					source: "timer-setup",
					sourceRevision: 0,
					actionId: "timer-start",
					scopeRef: "scope:other",
					input: {},
				},
				status: "indeterminate",
			},
		]),
	);
	const client = makeClient();
	mount(client);
	await screen.findByText(/以前の操作を照合できていません/);
	expect(client.toolchainAction).not.toHaveBeenCalled();
	expect(client.submitToolchainAction).not.toHaveBeenCalled();
});

test("an expired timer body is a message, not a clock", async () => {
	const client = makeClient({
		timer: vi.fn(async () => ({
			serverNow: new Date().toISOString(),
			timer: timerDto({ bodyExpired: true }),
			notification: null,
		})),
	});
	mount(client, undefined, TIMER);
	await screen.findByText("このタイマーの表示期限が過ぎました");
});

test("the unknown-outcome message goes away once the host reconciles the operation", async () => {
	const server = { paused: false };
	const submit = vi.fn(async (_event: object) => {
		server.paused = true;
		throw new ApiConnectionError();
	});
	const lookup = vi.fn(async (_id: string, _signal?: AbortSignal) => ({
		eventId: "x",
		status: "accepted",
		createdAt: new Date().toISOString(),
		result: result("paused", paused()),
	}));
	const client = activeClient(server, {
		submitToolchainAction: submit,
		toolchainAction: lookup,
	});
	mount(client, undefined, TIMER);
	fireEvent.click(await screen.findByRole("button", { name: "停止する" }));
	await screen.findByText(/操作の結果を確認できていません/);
	await waitFor(() => expect(lookup).toHaveBeenCalled(), { timeout: 6000 });
	await waitFor(() =>
		expect(screen.queryByText(/操作の結果を確認できていません/)).toBeNull(),
	);
	await screen.findByRole("button", { name: "再開する" });
	expect(submit).toHaveBeenCalledOnce();
});
