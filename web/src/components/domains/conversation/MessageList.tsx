import type { Conversation } from "../../../../../api/domains/conversation/contracts";
import { renderSafeMarkdown } from "./markdownRenderer";
export function MessageList({
	conversation,
	streaming,
	onOpenArtifact,
}: {
	conversation: Conversation | undefined;
	streaming?: string;
	onOpenArtifact?: (message: { id: string; text: string }) => void;
}) {
	return (
		<div className="messages" aria-live="polite">
			{conversation?.messages.length ? (
				conversation.messages.map((message) => (
					<article
						key={message.id}
						className={`message message-${message.role}`}
					>
						<small>{message.role === "user" ? "あなた" : "Eumenes"}</small>
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
						{message.role === "assistant" && onOpenArtifact && (
							<button
								type="button"
								className="artifact-open"
								onClick={() => onOpenArtifact(message)}
							>
								パネルで開く
							</button>
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
					<small>Eumenes</small>
					<p>{streaming}</p>
				</article>
			)}
		</div>
	);
}
