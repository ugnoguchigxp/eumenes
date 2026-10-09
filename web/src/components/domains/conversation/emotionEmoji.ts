import type { Emotion } from "../../../../../api/domains/delivery/contracts";
export const emotionEmoji: Record<
	Exclude<Emotion, "none">,
	{ emoji: string; label: string }
> = {
	warmth: { emoji: "🙂", label: "親しみ" },
	joy: { emoji: "😊", label: "喜び" },
	empathy: { emoji: "🤍", label: "寄り添う" },
	curiosity: { emoji: "🧐", label: "興味" },
	surprise: { emoji: "😮", label: "驚き" },
};
