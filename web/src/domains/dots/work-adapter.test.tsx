import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PropsWithChildren } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { useDotsWork } from "./work-adapter";
afterEach(cleanup);
test("selection is host issued and an old detail response cannot replace the newly selected work", async () => {
	let resolveOld: (value: unknown) => void = () => {};
	const old = new Promise((resolve) => {
		resolveOld = resolve;
	});
	const client = {
		identity: crypto.randomUUID(),
		subscribeChanges: vi.fn(() => () => {}),
		toolchainArtifactSource: vi.fn(
			async (_artifact: string, source: string, target?: string) => {
				if (source === "dots-jobs")
					return {
						revision: 0,
						data: {
							items: [
								{ ref: "one", title: "古い仕事", state: "active", revision: 1 },
								{
									ref: "two",
									title: "現在の仕事",
									state: "completed",
									revision: 2,
								},
							],
							nextOffset: null,
						},
					};
				if (source === "dots-work" && target === "one") return old;
				if (source === "dots-work")
					return {
						revision: 2,
						data: {
							task: {
								id: "two",
								title: "現在の仕事",
								state: "completed",
								revision: 2,
								result: { summary: "届いた結果", evidenceRefs: ["e"] },
								completionConditions: [],
								stopIntent: null,
							},
							question: null,
							sessions: [],
						},
					};
				if (source === "dots-activity")
					return { revision: 0, data: { commands: [] } };
				return {
					revision: 0,
					data: {
						enabled: false,
						connection: null,
						project: null,
					},
				};
			},
		),
	};
	const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		}),
		setTargetRef = vi.fn();
	const initial = {
		client,
		artifactRevisionId: "artifact:dots.workspace@3",
		artifact: { sourceBindings: [] },
		visible: true,
		targetRef: "one",
		setTargetRef,
	} as unknown as AdapterHostContext;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook((context) => useDotsWork(context), {
		initialProps: initial,
		wrapper,
	});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	let receipt;
	await act(async () => {
		receipt = await hook.result.current.local(
			{ eventAction: "work-select" } as never,
			{ values: { taskRef: "unknown" } } as never,
		);
	});
	expect(receipt).toMatchObject({ status: "rejected" });
	expect(setTargetRef).not.toHaveBeenCalled();
	hook.rerender({ ...initial, targetRef: "two" });
	await waitFor(() =>
		expect(hook.result.current.snapshot["dots-work"]).toMatchObject({
			work: { title: "現在の仕事", canCancel: false },
		}),
	);
	await act(async () => {
		resolveOld({
			revision: 1,
			data: {
				task: {
					id: "one",
					title: "古い仕事",
					state: "active",
					revision: 1,
					completionConditions: [],
				},
				question: null,
				sessions: [],
			},
		});
	});
	expect(hook.result.current.snapshot["dots-work"]).toMatchObject({
		work: { title: "現在の仕事" },
	});
	cache.clear();
});
