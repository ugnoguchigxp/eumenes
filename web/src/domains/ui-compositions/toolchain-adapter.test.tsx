import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import {
	SpecialistBridgeContext,
	type SpecialistBridge,
} from "../toolchain-artifacts/specialist-bridge";
import { uiCompositionsWebAdapter } from "./toolchain-adapter";

afterEach(cleanup);

type SpecialistSession = NonNullable<SpecialistBridge["session"]>;
const work = (over: object = {}) => ({
	workRef: "work-1",
	sessionId: "s1",
	title: "来場者アンケート",
	definition: { view: "text-block", title: "見出し" },
	revision: 3,
	savedRef: null,
	savedRevision: null,
	dirty: true,
	busy: false,
	canUndo: true,
	canRedo: false,
	...over,
});
const studioData = (over: object = {}) => ({
	kind: "ui-studio",
	work: work(),
	viewing: null,
	history: [
		{ id: "a", title: "作品a", updatedAt: 1 },
		{ id: "b", title: "作品b", updatedAt: 2 },
	],
	...over,
});
const session = (over: Partial<SpecialistSession> = {}): SpecialistSession => ({
	id: "sess-1",
	conversationId: "main",
	toolchainId: "ui.compose",
	toolchainRevisionId: "toolchain:ui.compose@2",
	title: "UI自由制作",
	artifactRevisionId: "artifact:ui.studio@1",
	adapterRef: "adapter:ui-compositions@1",
	workRef: "work-1",
	state: "active",
	endReason: null,
	revision: 4,
	epoch: 1,
	activeRunId: null,
	dirty: true,
	busy: false,
	label: "来場者アンケート",
	expiresAt: "2026-10-18T09:00:00.000Z",
	pendingSwitch: null,
	createdAt: "2026-10-17T09:00:00.000Z",
	updatedAt: "2026-10-17T09:00:00.000Z",
	...over,
});
const bridgeOf = (over: Partial<SpecialistBridge> = {}) => {
	const ok = { ok: true as const };
	const base = {
		session: null as SpecialistSession | null,
		command: vi.fn(async () => ok),
		stopRun: vi.fn(async () => ok),
		requestClose: vi.fn(async () => ok),
		closeSession: vi.fn(async () => ok),
	} satisfies SpecialistBridge;
	return { ...base, ...over } as typeof base;
};

function setup(options: {
	studio?: unknown | (() => unknown);
	form?: { revision: number; data: unknown };
	targetRef?: string;
	visible?: boolean;
	fail?: boolean;
	bridge?: SpecialistBridge | null;
}) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async (_rev: string, source: string) => {
			if (options.fail) throw new Error("offline");
			if (source === "ui-studio")
				return {
					revision: 5,
					data:
						typeof options.studio === "function"
							? options.studio()
							: (options.studio ?? studioData()),
				};
			return options.form ?? { revision: 2, data: { kind: "form" } };
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const context = {
		client,
		artifactRevisionId: "artifact:ui.studio@1",
		targetRef: options.targetRef,
		setTargetRef,
		visible: options.visible ?? true,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => uiCompositionsWebAdapter.useArtifact(context), {
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

test("the studio source becomes the ui-studio resource with the session's state", async () => {
	const bridge = bridgeOf({
		session: session({ state: "suspended", activeRunId: "run-1" }),
	});
	const h = setup({ bridge });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(h.hook.result.current.snapshot["ui-studio"]).toMatchObject({
		kind: "ui-studio",
		revision: 5,
		work: { workRef: "work-1", revision: 3, dirty: true },
		viewing: null,
		history: [{ id: "a" }, { id: "b" }],
		session: { state: "suspended", expiresAt: "2026-10-18T09:00:00.000Z" },
		stoppable: true,
	});
	expect(h.hook.result.current.targetOf("ui-studio")).toBeUndefined();
	h.cache.clear();
});

test("a session of another artifact is not shown on this studio", async () => {
	const h = setup({
		bridge: bridgeOf({
			session: session({ artifactRevisionId: "artifact:other@1" }),
		}),
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(h.hook.result.current.snapshot["ui-studio"]).toMatchObject({
		session: null,
		stoppable: false,
	});
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

test("a hidden screen reads nothing and stays loading; a failed or malformed read is an error", async () => {
	const hidden = setup({ visible: false });
	expect(hidden.client.toolchainArtifactSource).not.toHaveBeenCalled();
	expect(hidden.hook.result.current.phase.kind).toBe("loading");
	hidden.cache.clear();
	const failed = setup({ fail: true });
	await waitFor(() =>
		expect(failed.hook.result.current.phase.kind).toBe("error"),
	);
	failed.cache.clear();
	const malformed = setup({ studio: { kind: "ui-studio", work: 3 } });
	await waitFor(() =>
		expect(malformed.hook.result.current.phase.kind).toBe("error"),
	);
	malformed.cache.clear();
});

test("a viewed saved work reads its form; nothing is read for the draft", async () => {
	const draft = setup({});
	await waitFor(() =>
		expect(draft.hook.result.current.phase.kind).toBe("ready"),
	);
	expect(draft.client.toolchainArtifactSource).not.toHaveBeenCalledWith(
		"artifact:ui.studio@1",
		"composition-form",
		expect.anything(),
		expect.anything(),
	);
	draft.cache.clear();

	const saved = setup({
		targetRef: "a",
		studio: studioData({
			viewing: { id: "a", title: "作品a", definition: {}, savedRevision: 2 },
		}),
	});
	await waitFor(() =>
		expect(
			saved.hook.result.current.snapshot["composition-form"],
		).toMatchObject({
			kind: "form",
			revision: 2,
		}),
	);
	expect(saved.hook.result.current.targetOf("composition-form")).toBe("a");
	expect(saved.client.toolchainArtifactSource).toHaveBeenCalledWith(
		"artifact:ui.studio@1",
		"ui-studio",
		"a",
		expect.any(AbortSignal),
	);
	saved.cache.clear();
});

test("selecting sets the target; an unknown id or a non-string id is refused; empty returns to the draft", async () => {
	const h = setup({});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const { local } = h.hook.result.current;
	expect(await local(binding("ui-select"), event({ id: "b" }))).toMatchObject({
		status: "accepted",
	});
	expect(h.setTargetRef).toHaveBeenLastCalledWith("b");
	await local(binding("ui-select"), event({ id: "" }));
	expect(h.setTargetRef).toHaveBeenLastCalledWith(undefined);
	h.setTargetRef.mockClear();
	expect(await local(binding("ui-select"), event({ id: "zzz" }))).toMatchObject(
		{
			status: "rejected",
		},
	);
	expect(
		await local(binding("ui-select"), { values: { id: 3 } } as never),
	).toMatchObject({ status: "rejected" });
	expect(await local(binding("ui-other"), event())).toMatchObject({
		status: "rejected",
	});
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.cache.clear();
});

test("the screen's own operations go through the specialist bridge", async () => {
	const bridge = bridgeOf({ session: session() });
	const h = setup({ bridge });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const { local } = h.hook.result.current;
	await act(async () => {
		await local(binding("ui-return"), event());
		await local(binding("ui-resume"), event());
		await local(binding("ui-discard"), event());
		await local(binding("ui-stop"), event());
		await local(binding("ui-close"), event());
	});
	expect(bridge.command.mock.calls).toEqual([
		["return"],
		["resume"],
		["discard"],
	]);
	expect(bridge.stopRun).toHaveBeenCalledTimes(1);
	expect(bridge.requestClose).toHaveBeenCalledWith("artifact:ui.studio@1");
	// Resuming and discarding show the draft again; returning keeps the view.
	expect(h.setTargetRef).toHaveBeenCalledTimes(2);
	h.cache.clear();
});

test("a refused command is shown as a rejection and changes nothing", async () => {
	const bridge = bridgeOf({
		session: session(),
		command: vi.fn(async () => ({
			ok: false as const,
			message: "保存処理中です",
		})),
	});
	const h = setup({ bridge });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(
		await h.hook.result.current.local(binding("ui-discard"), event()),
	).toEqual({ status: "rejected", message: "保存処理中です" });
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.cache.clear();
});

test("without a bridge the session operations are unavailable", async () => {
	const h = setup({});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	for (const action of ["ui-return", "ui-stop", "ui-close"])
		expect(
			await h.hook.result.current.local(binding(action), event()),
		).toMatchObject({ status: "rejected" });
	h.cache.clear();
});

test("a save while the session is suspended closes it and shows the saved work", async () => {
	const result = {
		resultRefs: [{ owner: "ui-compositions", id: "saved-1" }],
	} as never;
	const suspended = bridgeOf({ session: session({ state: "suspended" }) });
	const h = setup({ bridge: suspended });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await act(async () => {
		await h.hook.result.current.settled(
			binding("ui-save"),
			result,
			{} as never,
			{},
		);
	});
	expect(suspended.closeSession).toHaveBeenCalledTimes(1);
	expect(h.setTargetRef).toHaveBeenCalledWith("saved-1");
	h.cache.clear();

	const active = bridgeOf({ session: session() });
	const a = setup({ bridge: active });
	await waitFor(() => expect(a.hook.result.current.phase.kind).toBe("ready"));
	await act(async () => {
		await a.hook.result.current.settled(
			binding("ui-save"),
			result,
			{} as never,
			{},
		);
		await a.hook.result.current.settled(
			binding("ui-undo"),
			result,
			{} as never,
			{},
		);
	});
	expect(active.closeSession).not.toHaveBeenCalled();
	expect(a.setTargetRef).not.toHaveBeenCalled();
	a.cache.clear();
});

test("ending an idle session refreshes the preview without a screen action", async () => {
	const bridge = bridgeOf({ session: session() });
	let ended = false;
	const h = setup({
		bridge,
		studio: () => studioData({ work: ended ? null : work() }),
	});
	await waitFor(() =>
		expect(h.hook.result.current.snapshot["ui-studio"]).toMatchObject({
			work: { workRef: "work-1" },
		}),
	);
	ended = true;
	bridge.session = null;
	h.hook.rerender();
	await waitFor(() =>
		expect(h.hook.result.current.snapshot["ui-studio"]).toMatchObject({
			work: null,
		}),
	);
	h.cache.clear();
});
