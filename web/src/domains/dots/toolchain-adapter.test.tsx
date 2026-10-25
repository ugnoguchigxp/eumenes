import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PropsWithChildren } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { dotsMessagingWebAdapter } from "./toolchain-adapter";
afterEach(cleanup);
function setup() {
	const state = {
		connections: [{ id: "conn", title: "接続先", enabled: true }],
		events: [
			{
				connectionRef: "conn",
				subscribed: true,
				expiresAt: Date.now() + 600000,
				messaging: { enabled: true, revision: 1, verifiedAt: null },
			},
		],
	};
	const client = {
		identity: crypto.randomUUID(),
		subscribeChanges: vi.fn(() => () => {}),
		dotsConfiguration: vi.fn(async () => state),
		openDotsMessageConversation: vi.fn(async () => ({ id: "thread" })),
		sendDotsMessage: vi.fn(async () => ({ id: "message" })),
		dotsMessageConversation: vi.fn(),
		configureDotsMessaging: vi.fn(),
		cancelDotsMessage: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifact: { sourceBindings: [{ source: "dots" }] },
		visible: true,
		conversationId: "chat",
		setTargetRef: vi.fn(),
	} as unknown as AdapterHostContext;
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => dotsMessagingWebAdapter.useArtifact(context), {
		wrapper,
	});
	async function local(
		action: string,
		values: Record<string, string | boolean> = {},
	) {
		let result: unknown;
		await act(async () => {
			result = await hook.result.current.local(
				{ eventAction: action } as never,
				{ id: crypto.randomUUID(), values } as never,
			);
		});
		return result as { status: string };
	}
	return { client, hook, context, local };
}
test("unknown send outcomes retain one request id and never auto-resend", async () => {
	const h = setup();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await h.local("dots-message-select", { connectionRef: "conn" });
	h.client.sendDotsMessage.mockRejectedValueOnce(new Error("lost response"));
	expect((await h.local("dots-message-send", { text: "相談" })).status).toBe(
		"rejected",
	);
	expect(h.client.sendDotsMessage).toHaveBeenCalledTimes(1);
	expect(
		(await h.local("dots-message-send", { text: "別の相談" })).status,
	).toBe("rejected");
	expect(h.client.sendDotsMessage).toHaveBeenCalledTimes(1);
	expect((await h.local("dots-message-send", { text: "相談" })).status).toBe(
		"accepted",
	);
	expect(h.client.openDotsMessageConversation).toHaveBeenCalledTimes(1);
	expect(h.client.sendDotsMessage.mock.calls[0]).toEqual(
		h.client.sendDotsMessage.mock.calls[1],
	);
});
