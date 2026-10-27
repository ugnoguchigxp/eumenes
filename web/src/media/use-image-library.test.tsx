import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import {
	deleteLibraryImage,
	imageLibraryKey,
	useImageLibrary,
} from "./use-image-library";
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

test("shared deletion checks the current library, updates it only after confirmation, and refreshes on failure", async () => {
	const cache = new QueryClient();
	const client = {
		identity: "a",
		deleteImage: vi.fn().mockResolvedValue({ id: "one", deleted: true }),
	} as unknown as EumenesClient;
	const key = imageLibraryKey(client);
	const data = {
		images: [
			{ id: "one", bytes: 50 },
			{ id: "two", bytes: 30 },
		],
		totalBytes: 80,
		maxBytes: 1000,
		targetBytes: 500,
	};
	cache.setQueryData(key, data);
	expect(await deleteLibraryImage(cache, client, "unknown")).toBe(false);
	expect(client.deleteImage).not.toHaveBeenCalled();
	expect(await deleteLibraryImage(cache, client, "one")).toBe(true);
	expect(cache.getQueryData(key)).toEqual({
		...data,
		images: [data.images[1]],
		totalBytes: 30,
	});
	vi.mocked(client.deleteImage).mockRejectedValueOnce(
		new Error("connection lost"),
	);
	expect(await deleteLibraryImage(cache, client, "two")).toBe(false);
	expect(cache.getQueryData(key)).toEqual({
		...data,
		images: [data.images[1]],
		totalBytes: 30,
	});
	expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
});
