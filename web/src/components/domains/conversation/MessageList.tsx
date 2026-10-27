import { AttachmentImages } from "./AttachmentImages";
import type { EumenesClient } from "../../../../../client";
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
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { emotionEmoji } from "./emotionEmoji";
import { renderSafeMarkdown } from "./markdownRenderer";
const PAGE_SIZE = 20;
const ANNOUNCE_LIMIT = 500;

/** A settled answer is announced in full; a very long one is cut with a pointer back to the text. */
function completionAnnouncement(text: string) {
	return text.length <= ANNOUNCE_LIMIT
		? `回答が完了しました。${text}`
		: `回答が完了しました。${text.slice(0, ANNOUNCE_LIMIT)}…続きは会話欄で確認できます。`;
}

export const MessageList = memo(function MessageList({
	conversation,
	client,
	streaming,
	replayingId,
	onReplay,
	agentName,
	renderInsideMessage,
	renderFollowingMessage,
	renderHiddenMessage,
	editableId,
	editingId,
	editedIds,
	onEdit,
	onOpenResource,
}: {
	conversation: Conversation | undefined;
	client?: EumenesClient;
	streaming?: string;
	replayingId?: string | null;
	onReplay?: (message: Pick<Message, "id" | "text" | "runId">) => void;
	agentName?: string;
	renderInsideMessage?: (message: Message) => ReactNode;
	renderFollowingMessage?: (message: Message) => ReactNode;
	/** Shown in the place of an input the list does not display (`presentation: "artifact"`). */
	renderHiddenMessage?: (message: Message) => ReactNode;
	/** The latest utterance, while it can still be edited. */
	editableId?: string;
	/** The utterance the composer is editing: shown faded. */
	editingId?: string;
	/** Utterances sent again after an edit. */
	editedIds?: ReadonlySet<string>;
	onEdit?: () => void;
	/** A link to a resource (`eumenes://`) in an answer; such a link opens the resource, it never navigates. */
	onOpenResource?: (uri: string) => void;
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
			text: completionAnnouncement(lastAssistantText),
		});
	}, [conversation, lastAssistantId, lastAssistantText, streaming]);
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const messages = conversation?.messages ?? [];
	const all = messages.filter((message) => message.presentation !== "artifact");
	const hidden = Math.max(0, all.length + (streaming ? 1 : 0) - visibleCount);
	const firstVisible = hidden ? all[hidden] : all[0];
	// Inputs that are not displayed keep their place, so what is shown for them stays in order.
	const rows = !hidden
		? messages
		: firstVisible
			? messages.slice(messages.indexOf(firstVisible))
			: [];
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
					onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
				>
					さらに20件表示
				</button>
			)}
			{rows.map((message) => (
				<MessageRow
					key={message.id}
					message={message}
					client={client}
					assistantLabel={assistantLabel}
					editing={message.id === editingId}
					replaying={message.id === replayingId}
					edited={!!editedIds?.has(message.id)}
					onReplay={onReplay}
					onEdit={message.id === editableId ? onEdit : undefined}
					onOpenResource={onOpenResource}
					renderInsideMessage={renderInsideMessage}
					renderFollowingMessage={renderFollowingMessage}
					renderHiddenMessage={renderHiddenMessage}
				/>
			))}
			{!all.length && !streaming && (
				<p className="empty">
					まだ会話はありません。声か文字で話しかけてください。
				</p>
			)}
			{streaming && (
				<article className="message message-assistant" aria-busy="true">
					<small>{assistantLabel}</small>
					<p>{streaming}</p>
				</article>
			)}
		</div>
	);
});

/** One input or answer; `onEdit` is given only to the editable one. It re-renders only when its own props change, so a streamed token does not touch the settled rows. */
const MessageRow = memo(function MessageRow({
	message,
	client,
	assistantLabel,
	editing,
	replaying,
	edited,
	onReplay,
	onEdit,
	onOpenResource,
	renderInsideMessage,
	renderFollowingMessage,
	renderHiddenMessage,
}: {
	message: Message;
	client?: EumenesClient;
	assistantLabel: string;
	editing: boolean;
	replaying: boolean;
	edited: boolean;
	onReplay?: (message: Pick<Message, "id" | "text" | "runId">) => void;
	onEdit?: () => void;
	onOpenResource?: (uri: string) => void;
	renderInsideMessage?: (message: Message) => ReactNode;
	renderFollowingMessage?: (message: Message) => ReactNode;
	renderHiddenMessage?: (message: Message) => ReactNode;
}) {
	if (message.presentation === "artifact")
		return <>{renderHiddenMessage?.(message)}</>;
	return (
		<>
			<article
				className={`message message-${message.role}${editing ? " message-editing" : ""}`}
			>
				<small className="message-author">
					{message.attribution?.displayName ??
						(message.role === "user" ? "あなた" : assistantLabel)}
					{message.role === "assistant" && (
						<EmotionIcon delivery={message.delivery} />
					)}
				</small>
				{message.role === "assistant" && onReplay && (
					<button
						type="button"
						className="message-replay"
						aria-label={replaying ? "読み上げを停止" : "読み上げ直す"}
						title={replaying ? "読み上げを停止" : "読み上げ直す"}
						aria-pressed={replaying}
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
							{replaying ? (
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
				{client && message.attachments?.length ? (
					<AttachmentImages client={client} attachments={message.attachments} />
				) : null}
				{onEdit && (
					<button
						type="button"
						className="message-edit"
						aria-label="編集"
						title="編集"
						onClick={onEdit}
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
							<path d="M12 20h9" />
							<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
						</svg>
					</button>
				)}
				{message.role === "assistant" ? (
					<MarkdownContent
						text={message.text}
						onOpenResource={onOpenResource}
					/>
				) : (
					<p>{message.text}</p>
				)}
				{edited && <small className="message-edited">編集済み</small>}
				{renderInsideMessage?.(message)}
			</article>
			{renderFollowingMessage?.(message)}
		</>
	);
});

const RESOURCE_LINK = /^eumenes:/i;

const MarkdownContent = memo(function MarkdownContent({
	text,
	onOpenResource,
}: {
	text: string;
	onOpenResource?: (uri: string) => void;
}) {
	const html = useMemo(() => renderSafeMarkdown(text), [text]);
	return (
		// Links are handled by delegation: the HTML is a string, so it has no handlers of its own.
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
		<div
			className="markdown-content"
			onClick={(event) => {
				if (!(event.target instanceof Element)) return;
				const href = event.target.closest("a")?.getAttribute("href");
				if (!href || !RESOURCE_LINK.test(href)) return;
				event.preventDefault();
				onOpenResource?.(href);
			}}
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
