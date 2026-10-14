import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { useClaudeCodeArtifacts } from "./useClaudeCodeArtifacts";

function setup(initial: { requests: number; activity?: string }) {
	let state = initial;
	const client = {
		identity: "claude-code-fixture",
		terminals: vi.fn(async () => ({
			available: true,
			revision: 1,
			limit: 4,
			requests: state.requests,
			sessions: [
				{
					id: "s1",
					title: "Claude Code 1",
					status: "running",
					run: 1,
					activity: state.activity,
					startedAt: "2026-10-14T00:00:00Z",
				},
			],
		})),
	} as unknown as EumenesClient;
	const cache = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const open = vi.fn();
	const chime = vi.fn();
	renderHook(() => useClaudeCodeArtifacts(client, open, chime), { wrapper });
	const change = async (next: typeof state) => {
		state = next;
		const calls = (client.terminals as ReturnType<typeof vi.fn>).mock.calls
			.length;
		await cache.invalidateQueries({ queryKey: [queryRoots.terminals] });
		await waitFor(() =>
			expect(client.terminals).toHaveBeenCalledTimes(calls + 1),
		);
	};
	return { client, open, chime, change };
}

test("opens the screen only for a request handed over after the page loaded", async () => {
	const h = setup({ requests: 2, activity: "working" });
	await waitFor(() => expect(h.client.terminals).toHaveBeenCalledOnce());
	expect(h.open).not.toHaveBeenCalled();
	await h.change({ requests: 2, activity: "working" });
	expect(h.open).not.toHaveBeenCalled();
	await h.change({ requests: 3, activity: "working" });
	await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
});

test("chimes when work finishes or the session starts waiting, not for the loaded state", async () => {
	const h = setup({ requests: 0, activity: "idle" });
	await waitFor(() => expect(h.client.terminals).toHaveBeenCalledOnce());
	await h.change({ requests: 0, activity: "working" });
	expect(h.chime).not.toHaveBeenCalled();
	await h.change({ requests: 0, activity: "idle" });
	await waitFor(() => expect(h.chime).toHaveBeenCalledOnce());
	await h.change({ requests: 0, activity: "waiting" });
	await waitFor(() => expect(h.chime).toHaveBeenCalledTimes(2));
	await h.change({ requests: 0, activity: "waiting" });
	expect(h.chime).toHaveBeenCalledTimes(2);
});
