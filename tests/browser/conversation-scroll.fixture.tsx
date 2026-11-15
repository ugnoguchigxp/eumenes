/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- Match the keyboard-focusable production history region. */
import { useEffect, useState, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	Conversation,
	Message,
} from "../../api/domains/conversation/contracts";
import type { RunProgress } from "../../api/domains/dialogue/contracts";
import type { EumenesClient } from "../../client";
import { LiveMessageList } from "../../web/src/workspace/LiveMessageList";
import { useConversationScroll } from "../../web/src/workspace/useConversationScroll";
import "../../web/src/app.css";

let progress = (_next: RunProgress) => {};
const client = {
	identity: "scroll-fixture",
	watchRun: (_id, signal, update) =>
		new Promise<void>((resolve) => {
			progress = update;
			signal.addEventListener("abort", () => resolve(), { once: true });
		}),
} as EumenesClient;
const message = (index: number): Message => ({
	id: `m${index}`,
	conversationId: "main",
	runId: null,
	role: index % 2 ? "assistant" : "user",
	text: `発言 ${index}\n${"長い会話の表示と位置を確認します。".repeat(8)}`,
	createdAt: new Date(1_790_000_000_000 + index * 1000).toISOString(),
});
const controls = {
	append: () => {},
	grow: () => {},
	stream(text: string) {
		progress({ runId: "run", status: "running", text });
	},
};
declare global {
	interface Window {
		conversationScrollFixture: typeof controls;
	}
}
window.conversationScrollFixture = controls;
function Fixture() {
	const {
		historyRef,
		contentRef,
		showLatest,
		onHistoryScroll,
		followLatestIfPinned,
		scrollLatest,
	} = useConversationScroll();
	const [draft, setDraft] = useState("");
	const [height, setHeight] = useState(0);
	const [conversation, setConversation] = useState<Conversation>({
		id: "main",
		revision: 1,
		messages: Array.from({ length: 1000 }, (_, i) => message(i)),
	});
	useEffect(() => {
		controls.append = () =>
			setConversation((old) => ({
				...old,
				revision: old.revision + 1,
				messages: [...old.messages, message(old.messages.length)],
			}));
		controls.grow = () => setHeight((old) => old + 220);
	}, []);
	return (
		<section className="chat-panel" style={{ height: "100dvh", width: "100%" }}>
			<div
				className="chat-history"
				ref={historyRef}
				data-following-latest={!showLatest}
				onScroll={(event) => onHistoryScroll(event.currentTarget)}
				role="region"
				tabIndex={0}
				aria-label="会話履歴"
			>
				<div className="chat-history-content" ref={contentRef}>
					<LiveMessageList
						client={client}
						activeRunId="run"
						conversation={conversation}
						followLatestIfPinned={followLatestIfPinned}
						historyRef={historyRef}
						followLatest={!showLatest}
					/>
					<div data-testid="late-content" style={{ height, flexShrink: 0 }} />
				</div>
			</div>
			{showLatest && (
				<button className="latest-button" onClick={scrollLatest}>
					最新の発言へ ↓
				</button>
			)}
			<textarea
				aria-label="メッセージ"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				style={{ flexShrink: 0, height: 80 }}
			/>
		</section>
	);
}
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={new QueryClient()}>
			<Fixture />
		</QueryClientProvider>
	</StrictMode>,
);
