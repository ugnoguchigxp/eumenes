import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { queryRoots } from "../../queryKeys";
import { useDrawingArtifacts } from "./useDrawingArtifacts";

afterEach(cleanup);

test("saved drawing operations stay closed and a new operation opens the editor once", async () => {
	const old = { id: "old" };
	const open = vi.fn();
	const client = {
		identity: "test",
		drawingOperations: vi.fn(async () => [old]),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	renderHook(() => useDrawingArtifacts(client as never, open), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	await waitFor(() => expect(client.drawingOperations).toHaveBeenCalled());
	await waitFor(() =>
		expect(cache.getQueryData([queryRoots.drawingOperations, "test"])).toEqual([
			old,
		]),
	);
	expect(open).not.toHaveBeenCalled();
	act(() =>
		cache.setQueryData(
			[queryRoots.drawingOperations, "test"],
			[{ id: "new" }, old],
		),
	);
	await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
	act(() =>
		cache.setQueryData(
			[queryRoots.drawingOperations, "test"],
			[{ id: "new" }, old],
		),
	);
	expect(open).toHaveBeenCalledTimes(1);
});
