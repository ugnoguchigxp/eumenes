import type {
	Conversation,
	Message,
} from "../../../../../api/domains/conversation/contracts";
import {
	acceptedEmotion,
	type SpeechDelivery,
} from "../../../../../api/domains/delivery/contracts";
import {
	type ReactNode,
	Fragment,
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { emotionEmoji } from "./emotionEmoji";
import { renderSafeMarkdown } from "./markdownRenderer";
const VISIBLE_LIMIT = 200;

export const MessageList = memo(function MessageList({
	conversation,
	streaming,
	replayingId,
	onReplay,
	agentName,
	renderFollowingMessage,
}: {
	conversation: Conversation | undefined;
	streaming?: string;
	replayingId?: string | null;
	onReplay?: (message: Pick<Message, "id" | "text" | "runId">) => void;
	agentName?: string;
	renderFollowingMessage?: (message: Message) => ReactNode;
}) {
	const assistantLabel = agentName || "Eumenes";
	// Streaming text is not announced; a settled answer is, once per message id.
	// Messages present on first load are history and stay silent.
	const lastAssistant = conversation?.messages
		.filter((message) => message.role === "assistant")
		.at(-1);
	const lastAssistantId = lastAssistant?.id ?? null;
	const lastAssistantText = lastAssistant?.text ?? "";
	const announced = useRef<string | null | undefined>(undefined);
	const [announcement, setAnnouncement] = useState<{
		id: string;
		text: string;
	} | null>(null);
	useEffect(() => {
		if (!conversation) return;
		if (announced.current === undefined) {
			announced.current = lastAssistantId;
			return;
		}
		if (streaming || !lastAssistantId || lastAssistantId === announced.current)
			return;
		announced.current = lastAssistantId;
		setAnnouncement({
			id: lastAssistantId,
			text: lastAssistantText.slice(0, 80),
		});
	}, [conversation, lastAssistantId, lastAssistantText, streaming]);
	const [showAll, setShowAll] = useState(false);
	const all = conversation?.messages ?? [];
	const hidden = showAll ? 0 : Math.max(0, all.length - VISIBLE_LIMIT);
	const visibleMessages = hidden ? all.slice(hidden) : all;
	return (
		<div className="messages">
			<output
				key={announcement?.id}
				className="visually-hidden"
				aria-live="polite"
			>
				{announcement?.text}
			</output>
			{hidden > 0 && (
				<button
					type="button"
					className="messages-older"
					onClick={() => setShowAll(true)}
				>
					以前の会話を表示
				</button>
			)}
			{all.length ? (
				visibleMessages.map((message) => (
					<Fragment key={message.id}>
						<article className={`message message-${message.role}`}>
							<small className="message-author">
								{message.role === "user" ? "あなた" : assistantLabel}
								{message.role === "assistant" && (
									<EmotionIcon delivery={message.delivery} />
								)}
							</small>
							{message.role === "assistant" && onReplay && (
								<button
									type="button"
									className="message-replay"
									aria-label={
										replayingId === message.id
											? "読み上げを停止"
											: "読み上げ直す"
									}
									title={
										replayingId === message.id
											? "読み上げを停止"
											: "読み上げ直す"
									}
									aria-pressed={replayingId === message.id}
									onClick={() => onReplay(message)}
								>
									<svg
										viewBox="0 0 24 24"
										width="16"
										height="16"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										{replayingId === message.id ? (
											<rect x="6" y="6" width="12" height="12" rx="1.5" />
										) : (
											<>
												<path d="M11 5 6 9H3v6h3l5 4z" />
												<path d="M15.5 8.5a5 5 0 0 1 0 7" />
												<path d="M18.5 5.5a9 9 0 0 1 0 13" />
											</>
										)}
									</svg>
								</button>
							)}
							{message.role === "assistant" ? (
								<MarkdownContent text={message.text} />
							) : (
								<p>{message.text}</p>
							)}
						</article>
						{renderFollowingMessage?.(message)}
					</Fragment>
				))
			) : !streaming ? (
				<p className="empty">
					まだ会話はありません。声か文字で話しかけてください。
				</p>
			) : null}
			{streaming && (
				<article className="message message-assistant" aria-busy="true">
					<small>{assistantLabel}</small>
					<p>{streaming}</p>
				</article>
			)}
		</div>
	);
});

const MarkdownContent = memo(function MarkdownContent({
	text,
}: {
	text: string;
}) {
	const html = useMemo(() => renderSafeMarkdown(text), [text]);
	return (
		<div
			className="markdown-content"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
});

function EmotionIcon({ delivery }: { delivery?: SpeechDelivery }) {
	const emotion = delivery ? acceptedEmotion(delivery) : null;
	if (!emotion) return null;
	const { emoji, label } = emotionEmoji[emotion];
	return (
		<span
			className="message-emotion"
			data-emotion={emotion}
			data-emotion-source={delivery?.source}
			// Emoji is text and has no image URL.
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
			role="img"
			aria-label={label}
			title={label}
		>
			{emoji}
		</span>
	);
}
