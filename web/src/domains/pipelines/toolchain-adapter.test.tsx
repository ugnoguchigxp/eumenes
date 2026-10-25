import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import {
	type BridgeResult,
	SpecialistBridgeContext,
	type SpecialistBridge,
} from "../toolchain-artifacts/specialist-bridge";
import { pipelinesWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

type SpecialistSession = NonNullable<SpecialistBridge["session"]>;
const work = (over: object = {}) => ({
	workRef: "work-1",
	sessionId: "s1",
	title: "天気",
	revision: 3,
	source: '{\n  "id": "weather",\n  "steps": []\n}',
	previousSource: "",
	rejected: null,
	issues: [],
	flow: { inputs: [], steps: [], answer: null },
	tests: [{ index: 0, utterance: "東京の天気" }],
	published: null,
	dirty: true,
	busy: false,
	...over,
});
const studioData = (over: object = {}) => ({
	work: work(),
	history: [
		{ toolchainId: "pipeline.a", title: "a", toolchainRevisionId: "ra" },
		{ toolchainId: "pipeline.b", title: "b", toolchainRevisionId: "rb" },
	],
	...over,
});
const session = (over: Partial<SpecialistSession> = {}): SpecialistSession => ({
	id: "sess-1",
	conversationId: "main",
	toolchainId: "pipeline.compose",
	toolchainRevisionId: "toolchain:pipeline.compose@1",
	title: "パイプライン制作",
	artifactRevisionId: "artifact:pipeline.studio@1",
	adapterRef: "adapter:pipelines@1",
	workRef: "work-1",
	state: "active",
	endReason: null,
	revision: 4,
	epoch: 1,
	activeRunId: null,
	dirty: true,
	busy: false,
	label: "天気",
	expiresAt: "2026-10-22T09:00:00.000Z",
	pendingSwitch: null,
	createdAt: "2026-10-22T08:00:00.000Z",
	updatedAt: "2026-10-22T08:00:00.000Z",
	...over,
});
const bridgeOf = (over: Partial<SpecialistBridge> = {}) => {
	const ok = { ok: true as const };
	const base = {
		session: null as SpecialistSession | null,
		command: vi.fn(async () => ok),
		stopRun: vi.fn(async () => ok),
		requestClose: vi.fn(async () => ok),
		retarget: vi.fn(
			async (_targetRef: string, _discard: boolean): Promise<BridgeResult> =>
				ok,
		),
		closeSession: vi.fn(async () => ok),
	} satisfies SpecialistBridge;
	return { ...base, ...over } as typeof base;
};

function setup(options: {
	studio?: unknown | (() => unknown);
	targetRef?: string;
	visible?: boolean;
	fail?: boolean;
	bridge?: SpecialistBridge | null;
	pipelines?: Partial<Record<"probe" | "select" | "fixture", unknown>>;
}) {
	const probe = vi.fn(async (_ref: string, _query: string) => ({
		ok: true as const,
		candidates: [],
		passages: [],
	}));
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => {
			if (options.fail) throw new Error("offline");
			return {
				revision: 5,
				data:
					typeof options.studio === "function"
						? options.studio()
						: (options.studio ?? studioData()),
			};
		}),
		pipelines: {
			probe: options.pipelines?.probe ?? probe,
			select:
				options.pipelines?.select ??
				vi.fn(async () => ({
					ok: true,
					chosen: "weather_fn",
					matched: true,
					next: null,
					inputs: null,
					code: null,
				})),
			fixture:
				options.pipelines?.fixture ??
				vi.fn(async () => ({
					ok: true,
					outcome: { passed: true, steps: [], failures: [] },
				})),
		},
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const context = {
		client,
		artifactRevisionId: "artifact:pipeline.studio@1",
		targetRef: options.targetRef,
		setTargetRef,
		visible: options.visible ?? true,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => pipelinesWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>
				<SpecialistBridgeContext.Provider value={options.bridge ?? null}>
					{children}
				</SpecialistBridgeContext.Provider>
			</QueryClientProvider>
		),
	});
	return { hook, client, cache, setTargetRef };
}
const event = (values: Record<string, string> = {}) => ({ values }) as never;
const binding = (eventAction: string) => ({ eventAction }) as never;
const ready = (h: ReturnType<typeof setup>) =>
	waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
const resource = (h: ReturnType<typeof setup>) =>
	h.hook.result.current.snapshot["pipeline-studio"] as never as {
		trial: unknown;
		work: { revision: number } | null;
		session: unknown;
		stoppable: boolean;
	};

test("the studio source becomes the pipeline-studio resource with the session's state", async () => {
	const h = setup({
		bridge: bridgeOf({
			session: session({ state: "suspended", activeRunId: "run-1" }),
		}),
	});
	await ready(h);
	expect(h.hook.result.current.snapshot["pipeline-studio"]).toMatchObject({
		kind: "pipeline-studio",
		revision: 5,
		work: { workRef: "work-1", revision: 3, dirty: true },
		history: [{ toolchainId: "pipeline.a" }, { toolchainId: "pipeline.b" }],
		session: { state: "suspended" },
		stoppable: true,
		trial: null,
	});
	expect(h.client.toolchainArtifactSource).toHaveBeenCalledWith(
		"artifact:pipeline.studio@1",
		"pipeline-studio",
		undefined,
		expect.any(AbortSignal),
	);
	h.cache.clear();
});

test("a session of another artifact is not shown on this studio", async () => {
	const h = setup({
		bridge: bridgeOf({
			session: session({ artifactRevisionId: "artifact:other@1" }),
		}),
	});
	await ready(h);
	expect(resource(h)).toMatchObject({ session: null, stoppable: false });
	h.cache.clear();
});

test("the studio is read again every second while a turn is running", async () => {
	let busy = true;
	const h = setup({ studio: () => studioData({ work: work({ busy }) }) });
	await waitFor(() =>
		expect(h.client.toolchainArtifactSource).toHaveBeenCalledTimes(1),
	);
	busy = false;
	await waitFor(
		() =>
			expect(
				h.client.toolchainArtifactSource.mock.calls.length,
			).toBeGreaterThan(1),
		{ timeout: 3000 },
	);
	h.cache.clear();
});

test("a hidden screen reads nothing; a failed or malformed read is an error", async () => {
	const hidden = setup({ visible: false });
	expect(hidden.client.toolchainArtifactSource).not.toHaveBeenCalled();
	expect(hidden.hook.result.current.phase.kind).toBe("loading");
	hidden.cache.clear();
	const failed = setup({ fail: true });
	await waitFor(() =>
		expect(failed.hook.result.current.phase.kind).toBe("error"),
	);
	failed.cache.clear();
	const malformed = setup({ studio: { work: 3, history: [] } });
	await waitFor(() =>
		expect(malformed.hook.result.current.phase.kind).toBe("error"),
	);
	malformed.cache.clear();
});

test("a probe is pending, then keeps its result for the draft it ran against", async () => {
	let release: (value: unknown) => void = () => {};
	const probe = vi.fn(
		(_ref: string, _query: string) =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const h = setup({ pipelines: { probe } });
	await ready(h);
	let receipt: unknown;
	let running: Promise<unknown> = Promise.resolve();
	act(() => {
		running = h.hook.result.current
			.local(binding("pipeline-probe"), event({ query: "天気" }))
			.then((r) => {
				receipt = r;
			});
	});
	await waitFor(() =>
		expect(resource(h).trial).toMatchObject({
			kind: "probe",
			query: "天気",
			pending: true,
			result: null,
		}),
	);
	expect(probe).toHaveBeenCalledWith("work-1", "天気");
	await act(async () => {
		release({ ok: true, candidates: [], passages: [] });
		await running;
	});
	expect(receipt).toEqual({ status: "accepted", message: "" });
	expect(resource(h).trial).toMatchObject({
		kind: "probe",
		pending: false,
		result: { ok: true },
	});
	h.cache.clear();
});

test("a trial result is dropped when the draft moves on", async () => {
	let revision = 3;
	const h = setup({ studio: () => studioData({ work: work({ revision }) }) });
	await ready(h);
	await act(async () => {
		await h.hook.result.current.local(
			binding("pipeline-select"),
			event({ utterance: "東京の天気は" }),
		);
	});
	expect(resource(h).trial).toMatchObject({
		kind: "select",
		result: { ok: true, matched: true },
	});
	revision = 4;
	await act(async () => {
		h.hook.result.current.refresh();
	});
	await waitFor(() => expect(resource(h).work?.revision).toBe(4));
	expect(resource(h).trial).toBeNull();
	h.cache.clear();
});

test("a fixture runs a known case; unknown and empty inputs are refused", async () => {
	const h = setup({});
	await ready(h);
	const { local } = h.hook.result.current;
	await act(async () => {
		expect(
			await local(binding("pipeline-fixture"), event({ test: "0" })),
		).toMatchObject({ status: "accepted" });
	});
	expect(h.client.pipelines.fixture).toHaveBeenCalledWith("work-1", 0);
	expect(resource(h).trial).toMatchObject({
		kind: "fixture",
		test: 0,
		result: { ok: true, outcome: { passed: true } },
	});
	for (const [action, values] of [
		["pipeline-fixture", { test: "7" }],
		["pipeline-fixture", { test: "x" }],
		["pipeline-probe", { query: "  " }],
		["pipeline-select", {}],
	] as const)
		expect(await local(binding(action), event(values))).toMatchObject({
			status: "rejected",
		});
	expect(h.client.pipelines.fixture).toHaveBeenCalledTimes(1);
	h.cache.clear();
});

test("a failed request is shown as the trial's result and the next trial replaces it", async () => {
	const probe = vi.fn(async () => {
		throw new Error("offline");
	});
	const h = setup({ pipelines: { probe } });
	await ready(h);
	await act(async () => {
		await h.hook.result.current.local(
			binding("pipeline-probe"),
			event({ query: "天気" }),
		);
	});
	expect(resource(h).trial).toMatchObject({
		kind: "probe",
		pending: false,
		result: { ok: false, code: "request_failed" },
	});
	await act(async () => {
		await h.hook.result.current.local(
			binding("pipeline-select"),
			event({ utterance: "x" }),
		);
	});
	expect(resource(h).trial).toMatchObject({ kind: "select" });
	h.cache.clear();
});

test("a trial without a draft is refused", async () => {
	const h = setup({ studio: studioData({ work: null }) });
	await ready(h);
	expect(
		await h.hook.result.current.local(
			binding("pipeline-probe"),
			event({ query: "天気" }),
		),
	).toMatchObject({ status: "rejected" });
	expect(h.client.pipelines.probe).not.toHaveBeenCalled();
	h.cache.clear();
});

test("opening sets the target; an unknown id is refused; empty returns to the draft", async () => {
	const h = setup({});
	await ready(h);
	const { local } = h.hook.result.current;
	expect(
		await local(binding("pipeline-open"), event({ toolchainId: "pipeline.b" })),
	).toMatchObject({ status: "accepted" });
	expect(h.setTargetRef).toHaveBeenLastCalledWith("pipeline.b");
	await local(binding("pipeline-open"), event({ toolchainId: "" }));
	expect(h.setTargetRef).toHaveBeenLastCalledWith(undefined);
	h.setTargetRef.mockClear();
	expect(
		await local(binding("pipeline-open"), event({ toolchainId: "zzz" })),
	).toMatchObject({ status: "rejected" });
	expect(
		await local(binding("pipeline-open"), {
			values: { toolchainId: 3 },
		} as never),
	).toMatchObject({ status: "rejected" });
	expect(await local(binding("pipeline-other"), event())).toMatchObject({
		status: "rejected",
	});
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.cache.clear();
});

test("while the specialist is active, opening a pipeline retargets it without discarding work", async () => {
	const bridge = bridgeOf({ session: session() });
	const h = setup({ bridge });
	await ready(h);
	await act(async () => {
		await h.hook.result.current.local(
			binding("pipeline-open"),
			event({ toolchainId: "pipeline.a" }),
		);
	});
	expect(bridge.retarget).toHaveBeenCalledWith("pipeline.a", false);
	expect(h.setTargetRef).toHaveBeenCalledWith(undefined);
	h.cache.clear();
	const refused = bridgeOf({
		session: session(),
		retarget: vi.fn(async () => ({
			ok: false as const,
			message: "公開していない案があります",
		})),
	});
	const r = setup({ bridge: refused });
	await ready(r);
	expect(
		await r.hook.result.current.local(
			binding("pipeline-open"),
			event({ toolchainId: "pipeline.a" }),
		),
	).toEqual({ status: "rejected", message: "公開していない案があります" });
	expect(r.setTargetRef).not.toHaveBeenCalled();
	r.cache.clear();
});

test("the screen's own operations go through the specialist bridge", async () => {
	const bridge = bridgeOf({ session: session() });
	const h = setup({ bridge });
	await ready(h);
	const { local } = h.hook.result.current;
	await act(async () => {
		await local(binding("pipeline-return"), event());
		await local(binding("pipeline-resume"), event());
		await local(binding("pipeline-stop"), event());
		await local(binding("pipeline-close"), event());
	});
	expect(bridge.command.mock.calls).toEqual([["return"], ["resume"]]);
	expect(bridge.stopRun).toHaveBeenCalledTimes(1);
	expect(bridge.requestClose).toHaveBeenCalledWith(
		"artifact:pipeline.studio@1",
	);
	// Resuming shows the draft again; returning keeps the view.
	expect(h.setTargetRef).toHaveBeenCalledTimes(1);
	h.cache.clear();
});

test("a refused command is a rejection; without a bridge the session operations are unavailable", async () => {
	const bridge = bridgeOf({
		session: session(),
		command: vi.fn(async () => ({
			ok: false as const,
			message: "処理中です",
		})),
	});
	const h = setup({ bridge });
	await ready(h);
	expect(
		await h.hook.result.current.local(binding("pipeline-resume"), event()),
	).toEqual({ status: "rejected", message: "処理中です" });
	h.cache.clear();
	const plain = setup({});
	await ready(plain);
	for (const action of ["pipeline-return", "pipeline-stop", "pipeline-close"])
		expect(
			await plain.hook.result.current.local(binding(action), event()),
		).toMatchObject({ status: "rejected" });
	plain.cache.clear();
});

test("a settled write reads the studio again, including a text that failed the format check", async () => {
	const h = setup({ bridge: bridgeOf({ session: session() }) });
	await ready(h);
	const before = h.client.toolchainArtifactSource.mock.calls.length;
	await act(async () => {
		await h.hook.result.current.settled(
			binding("pipeline-source-apply"),
			{
				resultRefs: [],
				receipt: { workRef: "work-1", state: "rejected", revision: 3 },
			} as never,
			{} as never,
			{},
		);
	});
	await waitFor(() =>
		expect(h.client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			before,
		),
	);
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.cache.clear();
});

test("a publish while the session is suspended closes it and shows the published pipeline", async () => {
	const suspended = bridgeOf({ session: session({ state: "suspended" }) });
	const h = setup({ bridge: suspended });
	await ready(h);
	await act(async () => {
		await h.hook.result.current.settled(
			binding("pipeline-publish"),
			{
				resultRefs: [],
				receipt: { state: "published", toolchainId: "pipeline.weather" },
			} as never,
			{} as never,
			{},
		);
	});
	expect(suspended.closeSession).toHaveBeenCalledTimes(1);
	expect(h.setTargetRef).toHaveBeenCalledWith("pipeline.weather");
	h.cache.clear();

	const active = bridgeOf({ session: session() });
	const a = setup({ bridge: active });
	await ready(a);
	await act(async () => {
		await a.hook.result.current.settled(
			binding("pipeline-publish"),
			{
				resultRefs: [],
				receipt: { state: "published", toolchainId: "pipeline.weather" },
			} as never,
			{} as never,
			{},
		);
	});
	expect(active.closeSession).not.toHaveBeenCalled();
	expect(a.setTargetRef).not.toHaveBeenCalled();
	a.cache.clear();
});

test("refusals name the code and the detail; other codes keep the host's wording", async () => {
	const h = setup({});
	await ready(h);
	const { describeRejection } = h.hook.result.current;
	expect(describeRejection?.("pipeline_invalid", [])).toBe(
		"パイプラインの検査を通りませんでした（pipeline_invalid）。",
	);
	expect(
		describeRejection?.("pipeline_invalid", [
			{ field: "/steps/0", message: "unknown_toolchain" },
		]),
	).toBe(
		"パイプラインの検査を通りませんでした（pipeline_invalid・/steps/0: unknown_toolchain）。",
	);
	expect(describeRejection?.("document_parse_failed", [])).toContain("JSON");
	expect(describeRejection?.("revision_conflict", [])).toContain("表示を更新");
	expect(describeRejection?.("work_busy", [])).toContain("制作中");
	expect(describeRejection?.("session_expired", [])).toContain("期限");
	expect(describeRejection?.("something_else", [])).toBeUndefined();
	expect(describeRejection?.(undefined, [])).toBeUndefined();
	h.cache.clear();
});

function drawStudio() {
	const studio = document.createElement("section");
	studio.className = "pipeline-studio";
	studio.scrollIntoView = vi.fn();
	document.body.append(studio);
	return studio;
}

test("focus shows the published pipeline's work, marks the studio for two seconds and viewing names the work", async () => {
	const { hook, setTargetRef, cache } = setup({ targetRef: "pipeline.a" });
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const studio = drawStudio();
	expect(pipelinesWebAdapter.viewing?.()).toBe("eumenes://pipeline/work-1");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const done = pipelinesWebAdapter.focus?.("pipeline.a");
	await vi.advanceTimersByTimeAsync(200);
	await expect(done).resolves.toBe(true);
	expect(setTargetRef).not.toHaveBeenCalled();
	expect(studio.getAttribute("data-resource-focus")).toBe("true");
	await vi.advanceTimersByTimeAsync(2_010);
	expect(studio.hasAttribute("data-resource-focus")).toBe(false);
	cache.clear();
});

test("focus with an empty target is the current draft; the screen is asked to leave a pipeline for it", async () => {
	const { hook, setTargetRef, cache } = setup({ targetRef: "pipeline.a" });
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	drawStudio();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const done = pipelinesWebAdapter.focus?.("");
	await vi.advanceTimersByTimeAsync(5_500);
	// The mock host does not feed the target back, so the draft never shows.
	await expect(done).resolves.toBe(false);
	expect(setTargetRef).toHaveBeenCalledWith(undefined);
	cache.clear();
});

test("the draft is focused when the studio already shows it", async () => {
	const { hook, setTargetRef, cache } = setup({});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	drawStudio();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const done = pipelinesWebAdapter.focus?.("");
	await vi.advanceTimersByTimeAsync(200);
	await expect(done).resolves.toBe(true);
	expect(setTargetRef).not.toHaveBeenCalled();
	cache.clear();
});

test("focus says no to a pipeline the studio does not list, and viewing is null without a work", async () => {
	const { hook, setTargetRef, cache } = setup({
		studio: studioData({ work: null }),
	});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(pipelinesWebAdapter.viewing?.()).toBeNull();
	await expect(pipelinesWebAdapter.focus?.("pipeline.zzz")).resolves.toBe(
		false,
	);
	expect(setTargetRef).not.toHaveBeenCalled();
	cache.clear();
});
