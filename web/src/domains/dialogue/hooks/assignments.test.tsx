import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../../client";
import { useArtifactWorkspace } from "../../artifact";
import { useToolchainArtifacts } from "../../toolchain-artifacts/launcher";
import { queryRoots } from "../../../queryKeys";
import { useAssignmentArtifacts } from "./assignments";

type Listed = {
	assignment: string;
	adapterRef: string;
	at: number;
	targetRef?: string;
};

/** The status as the server sends it: `at` is when the toolchain took the work. */
const startedAt = (offsetMs: number) => Date.now() + offsetMs;

function setup(initial: Listed[], open = vi.fn()) {
	let assignments = initial;
	const client = {
		identity: "assignments-fixture",
		agencyStatus: vi.fn(async () => ({ assignments })),
	} as unknown as EumenesClient;
	const cache = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	renderHook(() => useAssignmentArtifacts(client, "main", open), { wrapper });
	const change = async (next: Listed[]) => {
		assignments = next;
		const calls = (client.agencyStatus as ReturnType<typeof vi.fn>).mock.calls
			.length;
		await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
		await waitFor(() =>
			expect(client.agencyStatus).toHaveBeenCalledTimes(calls + 1),
		);
	};
	// The first status is in the cache.
	const loaded = () =>
		waitFor(() =>
			expect(
				cache.getQueryData([
					queryRoots.dialogue,
					client.identity,
					"main",
					"agency-status",
				]),
			).toBeDefined(),
		);
	return { client, open, change, loaded };
}

const music = () => ({
	assignment: "a1",
	adapterRef: "adapter:music@1",
	at: startedAt(1000),
});

test("opens the screen of an assignment that appeared after the page loaded, once", async () => {
	const h = setup([]);
	await h.loaded();
	expect(h.open).not.toHaveBeenCalled();
	const first = music();
	await h.change([first]);
	await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
	expect(h.open).toHaveBeenCalledWith("adapter:music@1", undefined);
	// The same assignment listed again (or still listed on the next change) opens nothing more.
	await h.change([first]);
	await h.change([
		first,
		{
			assignment: "a2",
			adapterRef: "adapter:image@1",
			at: startedAt(2000),
			targetRef: "img-1",
		},
	]);
	await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
	expect(h.open).toHaveBeenLastCalledWith("adapter:image@1", "img-1");
});

test("opens nothing for what started before the page loaded", async () => {
	const old = { ...music(), at: startedAt(-60_000) };
	const h = setup([old]);
	await h.loaded();
	await h.change([old]);
	expect(h.open).not.toHaveBeenCalled();
});

test("opens an assignment that started after the page loaded even when the first status read already lists it", async () => {
	// The user asked on this page and the toolchain took the work before the status was first read.
	const h = setup([music()]);
	await h.loaded();
	await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
	expect(h.open).toHaveBeenCalledWith("adapter:music@1", undefined);
	await h.change([music()]);
	expect(h.open).toHaveBeenCalledOnce();
});

test("through the launcher: the registered screen of the adapter opens once, and an adapter with no screen (Claude Code) opens nothing", async () => {
	let assignments: Listed[] = [];
	const client = {
		identity: "assignments-launcher-fixture",
		agencyStatus: vi.fn(async () => ({ assignments })),
		toolchainArtifacts: vi.fn(async () => [
			{
				toolchainId: "music.create",
				toolchainRevisionId: "toolchain:music.create@1",
				artifactRevisionId: "artifact:music.generation@1",
				title: "音楽",
				adapterRef: "adapter:music@1",
			},
		]),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() => {
			const workspace = useArtifactWorkspace();
			const { openByAdapter } = useToolchainArtifacts(client, workspace.open);
			useAssignmentArtifacts(client, "main", openByAdapter);
			return workspace;
		},
		{ wrapper },
	);
	await waitFor(() =>
		expect(
			cache.getQueryData([
				queryRoots.dialogue,
				client.identity,
				"main",
				"agency-status",
			]),
		).toBeDefined(),
	);
	const change = async (next: Listed[]) => {
		assignments = next;
		const calls = (client.agencyStatus as ReturnType<typeof vi.fn>).mock.calls
			.length;
		await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
		await waitFor(() =>
			expect(client.agencyStatus).toHaveBeenCalledTimes(calls + 1),
		);
	};
	const claude = {
		assignment: "a0",
		adapterRef: "adapter:claude-code-task@1",
		at: startedAt(1000),
	};
	const song = music();
	await change([claude]);
	await waitFor(() => expect(client.toolchainArtifacts).toHaveBeenCalled());
	expect(hook.result.current.tabs).toEqual([]);
	await change([claude, song]);
	await waitFor(() => expect(hook.result.current.tabs).toHaveLength(1));
	expect(hook.result.current.tabs[0]).toMatchObject({
		kind: "toolchain",
		artifactRevisionId: "artifact:music.generation@1",
	});
	await change([claude, song]);
	expect(hook.result.current.tabs).toHaveLength(1);
});
