import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useArtifactWorkspace } from "../artifact";
import {
	artifactIdOf,
	artifactVariantFromUrl,
	entryLabel,
	menuEntries,
	toolchainTabId,
	useToolchainArtifacts,
} from "./launcher";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const entry = {
	toolchainId: "timers.manage",
	toolchainRevisionId: "toolchain:timers.manage@2",
	artifactRevisionId: "artifact:timers.workspace@1",
	title: "タイマー",
	adapterRef: "adapter:timers@1",
};

function setup() {
	const client = {
		identity: "http://127.0.0.1:1",
		toolchainArtifacts: vi.fn(async () => [entry]),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() => {
			const workspace = useArtifactWorkspace();
			return {
				workspace,
				toolchain: useToolchainArtifacts(client as never, workspace.open),
			};
		},
		{ wrapper },
	);
	return { hook, client };
}

test("the tab id is a valid artifactId for the action host", () => {
	expect(toolchainTabId("artifact:timers.workspace@1")).toMatch(
		/^[A-Za-z0-9:_-]{1,80}$/,
	);
});

test("one entry reopens one tab; the saved timer is chosen inside it", async () => {
	const { hook } = setup();
	await waitFor(() =>
		expect(hook.result.current.toolchain.entries).toHaveLength(1),
	);
	const [first] = hook.result.current.toolchain.entries;
	act(() => hook.result.current.toolchain.openEntry(first!));
	act(() => hook.result.current.toolchain.openEntry(first!, "timer-1"));
	act(() => hook.result.current.toolchain.openEntry(first!));
	const tabs = hook.result.current.workspace.tabs;
	expect(tabs).toHaveLength(1);
	expect(tabs[0]).toMatchObject({
		kind: "toolchain",
		title: "タイマー",
		artifactRevisionId: "artifact:timers.workspace@1",
	});
	act(() => hook.result.current.workspace.setTarget(tabs[0]!.id, "timer-2"));
	expect(hook.result.current.workspace.tabs[0]).toMatchObject({
		targetRef: "timer-2",
	});
});

test("a target change inside a hidden tab never steals focus", async () => {
	const { hook } = setup();
	await waitFor(() =>
		expect(hook.result.current.toolchain.entries).toHaveLength(1),
	);
	act(() => {
		hook.result.current.toolchain.openEntry(
			hook.result.current.toolchain.entries[0]!,
		);
		hook.result.current.workspace.open({
			id: "md",
			title: "メモ",
			kind: "markdown",
			content: "x",
		});
	});
	const id = hook.result.current.workspace.tabs[0]!.id;
	act(() => hook.result.current.workspace.setTarget(id, "timer-9"));
	expect(hook.result.current.workspace.activeTabId).toBe("md");
});

test("a conversation result finds the registered artifact by its adapter", async () => {
	const { hook } = setup();
	await act(() =>
		hook.result.current.toolchain.openByAdapter("adapter:timers@1", "timer-3"),
	);
	expect(hook.result.current.workspace.tabs[0]).toMatchObject({
		targetRef: "timer-3",
	});
});

test("the variant comes from the artifactVariant query only", () => {
	expect(artifactVariantFromUrl("?artifactVariant=variant-b")).toBe(
		"variant-b",
	);
	expect(artifactVariantFromUrl("?x=1")).toBeUndefined();
	const { hook } = setup();
	vi.stubGlobal("location", { search: "?artifactVariant=variant-a" });
	return waitFor(() =>
		expect(hook.result.current.toolchain.entries).toHaveLength(1),
	).then(() => {
		act(() =>
			hook.result.current.toolchain.openEntry(
				hook.result.current.toolchain.entries[0]!,
			),
		);
		expect(hook.result.current.workspace.tabs[0]).toMatchObject({
			variantId: "variant-a",
		});
	});
});

const standalone = (
	id: string,
	label: string,
	group?: string,
	order?: number,
) => ({
	artifactRevisionId: `artifact:settings.${id}@1`,
	title: label,
	adapterRef: "adapter:settings@1",
	launcher: {
		label,
		...(group ? { group } : {}),
		...(order !== undefined ? { order } : {}),
	},
});

test("the menu keeps one entry per feature: grouped screens are reached through their hub", () => {
	const entries = [
		standalone("display", "表示", "使い方を変える"),
		standalone("hub", "設定", undefined, 10),
		entry,
	] as never;
	expect(menuEntries(entries).map((e) => entryLabel(e))).toEqual([
		"設定",
		"タイマー",
	]);
	expect(artifactIdOf("artifact:settings.display@1")).toBe("settings.display");
});

test("a navigate binding opens the artifact with that id, without the variant override", async () => {
	vi.stubGlobal("location", { search: "?artifactVariant=variant-b" });
	const client = {
		identity: "http://127.0.0.1:1",
		toolchainArtifacts: vi.fn(async () => [
			standalone("display", "表示", "使い方を変える"),
		]),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		() => {
			const workspace = useArtifactWorkspace();
			return {
				workspace,
				toolchain: useToolchainArtifacts(client as never, workspace.open),
			};
		},
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	let opened = false;
	await act(async () => {
		opened = await hook.result.current.toolchain.openById("settings.display");
	});
	expect(opened).toBe(true);
	expect(hook.result.current.workspace.tabs[0]).toMatchObject({
		title: "表示",
		artifactRevisionId: "artifact:settings.display@1",
	});
	expect(hook.result.current.workspace.tabs[0]).not.toHaveProperty("variantId");
	await act(async () => {
		opened = await hook.result.current.toolchain.openById("settings.unknown");
	});
	expect(opened).toBe(false);
});
