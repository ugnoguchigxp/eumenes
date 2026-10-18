import type { SpatialItem } from "./contracts";

/** Adopted 14 shapes; missing measurements remain explicitly unconfirmed. */
export const initialSpatialItems: readonly SpatialItem[] = [
	["mac-cpu", "CPU", "cpu"],
	["mac-memory", "Memory", "memory"],
	["mac-ssd", "SSD", "ssd"],
	["eumenes-backend", "Eumenes Backend", "backend"],
	["external", "外部連携", "external"],
	["sample-llm", "LLM", "llm"],
	["sample-asr", "ASR", "asr"],
	["sample-tts", "TTS", "tts"],
	["sample-embedding", "Embedding", "embedding"],
	["sample-attitude", "態度判定", "attitude"],
	["larm-core", "LARM Core", "larm-core"],
	["larm-cpu", "LARM CPU", "larm-cpu"],
	["larm-memory", "LARM Memory", "larm-memory"],
	["larm-gpu", "LARM GPU", "larm-gpu"],
].map(([id, label, model], i) => {
	const phase =
		i < 10 ? (i / 10) * Math.PI * 2 + 0.2 : ((i - 10) / 4) * Math.PI * 2 + 0.65;
	const radius = i < 10 ? 6.7 : 10.7;
	return {
		id: id!,
		label: label!,
		model: model!,
		position: [Math.cos(phase) * radius, Math.sin(phase) * radius, 0] as const,
		orbit: { radius, phase, speed: i < 10 ? 1 : 0.75 },
		state: {
			health: "unknown",
			activity: "idle",
			stale: false,
			source: "unconfirmed",
		},
	};
});
