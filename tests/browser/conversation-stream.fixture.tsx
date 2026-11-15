import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "../../client";
import type { RunProgress } from "../../api/domains/dialogue/contracts";
import type { Conversation } from "../../api/domains/conversation/contracts";
import { LiveMessageList } from "../../web/src/workspace/LiveMessageList";

const connections: Array<{
	controller: ReadableStreamDefaultController<Uint8Array>;
	open: boolean;
}> = [];
const encoder = new TextEncoder();
// The browser receives real incremental SSE bytes; only its network peer is scripted.
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input), location.href);
	if (!url.pathname.endsWith("/stream"))
		throw new Error("unexpected_fixture_request");
	let connection: (typeof connections)[number];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			connection = { controller, open: true };
			connections.push(connection);
			init?.signal?.addEventListener(
				"abort",
				() => {
					if (connection.open) {
						connection.open = false;
						controller.close();
					}
				},
				{ once: true },
			);
		},
		cancel() {
			connection.open = false;
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream" },
	});
};
Object.defineProperty(window, "fetch", {
	value: fixtureFetch,
	configurable: true,
});

let adopt = (_text: string) => {};
const controls = {
	count: () => connections.length,
	send(index: number, value: RunProgress) {
		const connection = connections[index];
		if (connection?.open)
			connection.controller.enqueue(
				encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
			);
	},
	disconnect(index: number) {
		const connection = connections[index]!;
		if (connection.open) {
			connection.open = false;
			connection.controller.error(new Error("fixture_disconnect"));
		}
	},
	adopt: (text: string) => adopt(text),
};
declare global {
	interface Window {
		conversationStreamFixture: typeof controls;
	}
}
window.conversationStreamFixture = controls;

const client = createClient(location.origin);
const cache = new QueryClient();
function Fixture() {
	const [conversation, setConversation] = useState<Conversation>({
		id: "main",
		revision: 1,
		messages: [
			{
				id: "user",
				conversationId: "main",
				role: "user",
				text: "会話の続きをお願いします。",
				runId: "run",
				createdAt: "2026-11-15T00:00:00Z",
			},
		],
	});
	useEffect(() => {
		adopt = (text) =>
			setConversation((previous) => ({
				...previous,
				revision: previous.revision + 1,
				messages: [
					...previous.messages,
					{
						id: "answer",
						conversationId: "main",
						role: "assistant",
						text,
						runId: "run",
						createdAt: "2026-11-15T00:00:01Z",
					},
				],
			}));
		return () => {
			adopt = () => {};
		};
	}, []);
	return (
		<main>
			<LiveMessageList
				client={client}
				activeRunId="run"
				conversation={conversation}
				followLatestIfPinned={() => {}}
			/>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={cache}>
		<Fixture />
	</QueryClientProvider>,
);
