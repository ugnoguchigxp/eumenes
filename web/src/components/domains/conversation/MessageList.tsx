import type {
	Conversation,
	Message,
} from "../../../../../api/domains/conversation/contracts";
import type { SpeechDelivery } from "../../../../../api/domains/delivery";
import { acceptedEmotion } from "../../../../../api/domains/delivery";
import { emotionEmoji } from "./emotionEmoji";
import { renderSafeMarkdown } from "./markdownRenderer";
export function MessageList({
	conversation,
	streaming,
	replayingId,
	onReplay,
	agentName,
}: {
	conversation: Conversation | undefined;
	streaming?: string;
	replayingId?: string | null;
	onReplay?: (message: Pick<Message, "id" | "text" | "runId">) => void;
	agentName?: string;
}) {
	const assistantLabel = agentName || "Eumenes";
	return (
		<div className="messages" aria-live="polite">
			{conversation?.messages.length ? (
				conversation.messages.map((message) => (
					<article
						key={message.id}
						className={`message message-${message.role}`}
					>
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
									replayingId === message.id ? "読み上げを停止" : "読み上げ直す"
								}
								title={
									replayingId === message.id ? "読み上げを停止" : "読み上げ直す"
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
							<div
								className="markdown-content"
								dangerouslySetInnerHTML={{
									__html: renderSafeMarkdown(message.text),
								}}
							/>
						) : (
							<p>{message.text}</p>
						)}
					</article>
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
}

function EmotionIcon({ delivery }: { delivery?: SpeechDelivery }) {
	const emotion = delivery ? acceptedEmotion(delivery) : null;
	if (!emotion) return null;
	const { emoji, label } = emotionEmoji[emotion];
	return (
		<span
			className="message-emotion"
			data-emotion={emotion}
			data-emotion-source="laya"
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
