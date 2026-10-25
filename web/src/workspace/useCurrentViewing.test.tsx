import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
	createWebAdapterRegistry,
	type WebArtifactAdapter,
} from "../domains/toolchain-artifacts/registry";
import { queryRoots } from "../queryKeys";
import { useCurrentViewing, useViewingUri } from "./useCurrentViewing";

afterEach(cleanup);

const shown = vi.fn<() => string | null>(() => null);
const adapter = {
	adapterRef: "adapter:test@1",
	useArtifact: () => {
		throw new Error("not rendered here");
	},
	viewing: shown,
} as unknown as WebArtifactAdapter;
const adapters = createWebAdapterRegistry([adapter]);
const toolchainTab = (artifactRevisionId: string) =>
	({
		id: "t",
		kind: "toolchain",
		title: "画面",
		artifactRevisionId,
	}) as const;

function mount(active: Parameters<typeof useViewingUri>[0]) {
	const cache = new QueryClient();
	cache.setQueryData(
		[queryRoots.toolchainArtifacts, "id", "list"],
		[
			{
				artifactRevisionId: "artifact:test.screen@1",
				adapterRef: adapter.adapterRef,
			},
		],
	);
	// A saved item's own query under the same root is not the catalog.
	cache.setQueryData([queryRoots.toolchainArtifacts, "id", "item"], [{}]);
	return renderHook(() => useViewingUri(active, adapters), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
}

test("the visible registered screen's viewing() names what is shown, read when called", () => {
	shown.mockReturnValue("eumenes://image/i1");
	const view = mount(toolchainTab("artifact:test.screen@1"));
	expect(view.result.current()).toBe("eumenes://image/i1");
	shown.mockReturnValue(null);
	expect(view.result.current()).toBeNull();
});

test("a tab whose artifact has no adapter in the catalog, or no tab, names nothing", () => {
	shown.mockReturnValue("eumenes://image/i1");
	expect(mount(toolchainTab("artifact:other@1")).result.current()).toBeNull();
	expect(mount(null).result.current()).toBeNull();
	expect(
		mount({
			id: "m",
			kind: "markdown",
			title: "m",
			content: "",
		}).result.current(),
	).toBeNull();
});

test("an OpenUI tab that is not a screen of resources names nothing", () => {
	expect(
		mount({
			id: "other",
			kind: "openui",
			title: "x",
			definition: "{}",
		}).result.current(),
	).toBeNull();
});

test("the specialist's saved work still wins the message's viewing, then the recognition still", () => {
	const saved = { artifactRevisionId: "artifact:timer@1", targetRef: "t1" };
	const specialist = vi.fn(() => saved);
	const view = renderHook(() =>
		useCurrentViewing(specialist, toolchainTab("artifact:other@1")),
	);
	expect(view.result.current()).toEqual(saved);
	const none = renderHook(() =>
		useCurrentViewing(() => undefined, {
			...toolchainTab("artifact:object-recognition.workspace@1"),
			targetRef: "still-1",
		}),
	);
	expect(none.result.current()).toEqual({
		artifactRevisionId: "artifact:object-recognition.workspace@1",
		targetRef: "still-1",
	});
});
