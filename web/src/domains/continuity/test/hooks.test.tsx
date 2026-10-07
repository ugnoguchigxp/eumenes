import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test } from "vitest";
import {
	bookmarkFixture,
	fakeContinuityClient,
} from "../../../components/domains/continuity/fake-client";
import {
	continuityKey,
	useBookmarks,
	useCreateBookmark,
	useOperationRequestId,
} from "..";

const queries: QueryClient[] = [];
afterEach(() => {
	for (const q of queries) q.clear();
	queries.length = 0;
});
function wrapperFor(client: QueryClient) {
	queries.push(client);
	return ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}
const newClient = () =>
	new QueryClient({ defaultOptions: { queries: { retry: false } } });

test("query keys differ per identity and conversation and nest under the continuity prefix", async () => {
	const qc = newClient();
	const wrapper = wrapperFor(qc);
	const a = fakeContinuityClient(
		[bookmarkFixture({ text: "A" })],
		"http://127.0.0.1:1",
	);
	const b = fakeContinuityClient(
		[bookmarkFixture({ text: "B" })],
		"http://127.0.0.1:2",
	);
	const one = renderHook(() => useBookmarks(a, "c1"), { wrapper });
	const two = renderHook(() => useBookmarks(b, "c1"), { wrapper });
	const three = renderHook(() => useBookmarks(a, "c2"), { wrapper });
	await waitFor(() => expect(one.result.current.data).toBeTruthy());
	await waitFor(() => expect(two.result.current.data).toBeTruthy());
	await waitFor(() => expect(three.result.current.data).toBeTruthy());
	expect(one.result.current.data?.bookmarks[0]?.text).toBe("A");
	expect(two.result.current.data?.bookmarks[0]?.text).toBe("B");
	const keys = qc
		.getQueryCache()
		.getAll()
		.map((q) => q.queryKey);
	expect(new Set(keys.map((k) => JSON.stringify(k))).size).toBe(3);
	expect(continuityKey("http://127.0.0.1:1", "c1")).toEqual([
		"continuity",
		"http://127.0.0.1:1",
		"c1",
	]);
	expect(keys).toContainEqual([
		"continuity",
		"http://127.0.0.1:1",
		"c1",
		"list",
		false,
	]);
	expect(a.list).toHaveBeenCalledWith(
		"c1",
		{ includeInactive: false },
		expect.anything(),
	);
	expect(a.list).toHaveBeenCalledWith(
		"c2",
		{ includeInactive: false },
		expect.anything(),
	);
});

test("a successful mutation invalidates only queries of its conversation", async () => {
	const qc = newClient();
	const wrapper = wrapperFor(qc);
	const client = fakeContinuityClient();
	const c1 = renderHook(() => useBookmarks(client, "c1"), { wrapper });
	renderHook(() => useBookmarks(client, "c2"), { wrapper });
	const mutation = renderHook(() => useCreateBookmark(client, "c1"), {
		wrapper,
	});
	await waitFor(() => expect(c1.result.current.data).toBeTruthy());
	await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
	await act(() =>
		mutation.result.current.mutateAsync({
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "x",
		}),
	);
	await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
	expect(client.list.mock.calls.at(-1)?.[0]).toBe("c1");
});

test("useOperationRequestId is stable for the same payload and renews on change or reset", () => {
	const { result } = renderHook(() => useOperationRequestId());
	const first = result.current.idFor({ a: 1 });
	expect(result.current.idFor({ a: 1 })).toBe(first);
	const second = result.current.idFor({ a: 2 });
	expect(second).not.toBe(first);
	result.current.reset();
	expect(result.current.idFor({ a: 2 })).not.toBe(second);
});
