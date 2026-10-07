import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test } from "vitest";
import type { ConversationClient } from "../../../../../client/conversation";
import { useConversation } from "..";

const clients: QueryClient[] = [];
afterEach(() => {
	for (const client of clients) client.clear();
	clients.length = 0;
});
test("conversation hook reads backend state with an isolated query cache", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	clients.push(client);
	const api: ConversationClient = {
		identity: "http://127.0.0.1:8787",
		conversation: async (id) => ({ id, revision: 1, messages: [] }),
	};
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const result = renderHook(() => useConversation(api, "main"), { wrapper });
	await waitFor(() => expect(result.result.current.data?.revision).toBe(1));
	result.unmount();
});
