import type { Conversation } from "../../../../../api/domains/conversation/contracts";
import { renderSafeMarkdown } from "./markdownRenderer";
export function MessageList({
	conversation,
}: {
	conversation: Conversation | undefined;
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
					</article>
				))
			) : (
				<p className="empty">
					まだ会話はありません。声か文字で話しかけてください。
				</p>
			)}
		</div>
	);
}
