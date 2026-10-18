export const particleModelIds = [
	"cpu",
	"memory",
	"ssd",
	"backend",
	"external",
	"llm",
	"asr",
	"tts",
	"embedding",
	"attitude",
	"larm-core",
	"larm-cpu",
	"larm-memory",
	"larm-gpu",
] as const;
export type ParticleModelId = (typeof particleModelIds)[number];
