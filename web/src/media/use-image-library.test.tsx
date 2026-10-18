import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { imageLibraryKey, useImageLibrary } from "./use-image-library";
afterEach(cleanup);

test("one authenticated library read is shared by multiple consumers, refreshed together and isolated by client", async () => {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const a = {
		identity: "a",
		imageLibrary: vi.fn(async () => ({ images: [] })),
	};
	const b = {
		identity: "b",
		imageLibrary: vi.fn(async () => ({ images: [] })),
	};
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() => [
			useImageLibrary(a as unknown as EumenesClient),
			useImageLibrary(a as unknown as EumenesClient),
			useImageLibrary(b as unknown as EumenesClient),
		],
		{ wrapper },
	);
	await waitFor(() =>
		expect(hook.result.current.every((query) => query.isSuccess)).toBe(true),
	);
	expect(a.imageLibrary).toHaveBeenCalledTimes(1);
	expect(b.imageLibrary).toHaveBeenCalledTimes(1);
	await act(async () => {
		await cache.invalidateQueries({ queryKey: imageLibraryKey(a) });
	});
	expect(a.imageLibrary).toHaveBeenCalledTimes(2);
	expect(b.imageLibrary).toHaveBeenCalledTimes(1);
});
