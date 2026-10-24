import type { DeliveryEmotion } from "../../../../../api/domains/delivery/contracts";
export const emotionEmoji: Record<
	Exclude<DeliveryEmotion, "none">,
	{ emoji: string; label: string }
> = {
	warmth: { emoji: "🙂", label: "親しみ" },
	joy: { emoji: "😊", label: "喜び" },
	empathy: { emoji: "🤍", label: "寄り添う" },
	curiosity: { emoji: "🧐", label: "興味" },
	surprise: { emoji: "😮", label: "驚き" },
	// Feelings an agency utterance carries (the same emoji the agency chose).
	enjoyment: { emoji: "😄", label: "楽しい" },
	wry: { emoji: "😏", label: "苦笑" },
	admiration: { emoji: "👏", label: "感心" },
	relief: { emoji: "😌", label: "安心" },
	shy: { emoji: "😳", label: "照れ" },
	confusion: { emoji: "😕", label: "困惑" },
	sadness: { emoji: "😢", label: "悲しい" },
	apologetic: { emoji: "🙏", label: "申し訳ない" },
	worry: { emoji: "😟", label: "心配" },
	dislike: { emoji: "😒", label: "嫌だ" },
	anger: { emoji: "😠", label: "怒り" },
};
