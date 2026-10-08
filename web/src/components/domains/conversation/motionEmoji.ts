import type { AvatarMotion } from "../../../../../api/domains/delivery";
export const motionEmoji: Record<
	AvatarMotion,
	{ emoji: string; label: string }
> = {
	neutral: { emoji: "😐", label: "落ち着いた説明" },
	listening: { emoji: "👂", label: "寄り添って聞く" },
	thinking: { emoji: "🤔", label: "考える" },
	speaking: { emoji: "💬", label: "説明する" },
	curious: { emoji: "🧐", label: "興味・確認" },
	distant: { emoji: "💭", label: "思いを巡らせる" },
	downcast: { emoji: "😔", label: "悲しみに寄り添う" },
	greeting: { emoji: "👋", label: "挨拶" },
	agreeing: { emoji: "🙂", label: "同意" },
	joyful: { emoji: "😊", label: "喜び" },
	surprised: { emoji: "😮", label: "驚き" },
	shy: { emoji: "☺️", label: "照れ" },
	sleepy: { emoji: "😴", label: "眠気" },
};
