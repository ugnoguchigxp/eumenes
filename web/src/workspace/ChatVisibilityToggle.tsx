import { Button } from "@eumenes/design-system";
import "./ChatVisibilityToggle.css";

/** Hides the chat so the background can be watched and touched; the conversation keeps running. */
export function ChatVisibilityToggle({
	hidden,
	onToggle,
}: {
	hidden: boolean;
	onToggle: () => void;
}) {
	const label = hidden ? "チャットを表示" : "チャットを隠す";
	return (
		<Button
			type="button"
			variant="secondary"
			size="icon"
			className="chat-visibility-trigger"
			aria-label={label}
			aria-pressed={hidden}
			title={label}
			onClick={onToggle}
		>
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
				{!hidden && <path d="M3 3l18 18" />}
			</svg>
		</Button>
	);
}
