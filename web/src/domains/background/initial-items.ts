import type { SpatialItem } from "./contracts";

/** Twelve accepted shape samples. This is not a discovered machine/provider inventory. */
export const initialSpatialItems: readonly SpatialItem[] = [
	["mac-cpu", "CPU", "cpu"],
	["mac-memory", "Memory", "memory"],
	["mac-ssd", "SSD", "ssd"],
	["mac-network", "Network", "network"],
	["sample-llm", "LLM", "llm"],
	["sample-asr", "ASR", "asr"],
	["sample-tts", "TTS", "tts"],
	["sample-embedding", "Embedding", "embedding"],
	["sample-attitude", "態度判定", "attitude"],
	["sample-language", "言語判定", "language"],
	["sample-image", "画像生成", "image"],
	["sample-music", "楽曲生成", "music"],
].map(([id, label, model], i) => {
	const phase =
		i < 4 ? (i / 4 + 0.125) * Math.PI * 2 : ((i - 4) / 8 + 0.065) * Math.PI * 2;
	const radius = i < 4 ? 3.7 : 8.4;
	return {
		id: id!,
		label: label!,
		model: model!,
		position: [Math.cos(phase) * radius, Math.sin(phase) * radius, 0] as const,
		orbit: { radius, phase, speed: i < 4 ? 1 : 0.75 },
		state: {
			health: "unknown",
			activity: "idle",
			stale: false,
			source: "unconfirmed",
		},
	};
});
