import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { DialogueClient } from "../../../../../client/dialogue";
import { useSpecialistCommand, useSpecialistSession, useSubmit } from "..";

afterEach(cleanup);

function setup(session: unknown) {
	const client = {
		identity: crypto.randomUUID(),
		specialistSession: vi.fn(async () => ({ session })),
		specialistCommand: vi.fn(async () => ({})),
		submit: vi.fn(async (input: { requestId: string }) => ({
			id: input.requestId,
		})),
	} as unknown as DialogueClient & {
		specialistSession: ReturnType<typeof vi.fn>;
		specialistCommand: ReturnType<typeof vi.fn>;
		submit: ReturnType<typeof vi.fn>;
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	return { client, cache, wrapper };
}

test("the session query returns the live session or null", async () => {
	const live = setup({ id: "s1", revision: 2 });
	const hook = renderHook(() => useSpecialistSession(live.client, "main"), {
		wrapper: live.wrapper,
	});
	await waitFor(() =>
		expect(hook.result.current.data).toEqual({ id: "s1", revision: 2 }),
	);
	expect(live.client.specialistSession).toHaveBeenCalledWith("main");
	const none = setup(null);
	const empty = renderHook(() => useSpecialistSession(none.client, "main"), {
		wrapper: none.wrapper,
	});
	await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
	expect(empty.result.current.data).toBeNull();
});

test("a command carries the session revision and keeps its request id when repeated", async () => {
	const h = setup({ id: "s1", revision: 2 });
	const hook = renderHook(() => useSpecialistCommand(h.client, "main"), {
		wrapper: h.wrapper,
	});
	h.client.specialistCommand.mockRejectedValueOnce(new Error("offline"));
	await act(async () => {
		await hook.result.current
			.mutateAsync({ session: { id: "s1", revision: 2 }, kind: "return" })
			.catch(() => {});
	});
	await act(async () => {
		await hook.result.current.mutateAsync({
			session: { id: "s1", revision: 2 },
			kind: "return",
		});
	});
	const [first, second] = h.client.specialistCommand.mock.calls;
	expect(first?.[0]).toBe("s1");
	expect(first?.[1]).toBe("return");
	expect(first?.[2]).toMatchObject({ expectedRevision: 2 });
	expect(second?.[2].requestId).toBe(first?.[2].requestId);
	await act(async () => {
		await hook.result.current.mutateAsync({
			session: { id: "s1", revision: 3 },
			kind: "return",
		});
	});
	expect(h.client.specialistCommand.mock.calls[2]?.[2].requestId).not.toBe(
		first?.[2].requestId,
	);
});

test("a submit carries the viewed saved work only when there is one", async () => {
	const h = setup(null);
	const hook = renderHook(() => useSubmit(h.client, "main"), {
		wrapper: h.wrapper,
	});
	await act(async () => {
		await hook.result.current.mutateAsync({
			text: "直して",
			attachmentIds: [],
		});
	});
	expect(h.client.submit.mock.calls[0]?.[0]).not.toHaveProperty("viewing");
	const viewing = {
		artifactRevisionId: "artifact:ui.studio@1",
		targetRef: "c1",
	};
	await act(async () => {
		await hook.result.current.mutateAsync({
			text: "直して",
			attachmentIds: [],
			viewing,
		});
	});
	expect(h.client.submit.mock.calls[1]?.[0]).toMatchObject({ viewing });
});
