import type { InferencePort } from "../../inference";

/** Saved settings for the harness tests: a conversation model resource of a connection kind, and how the route picks it. */
export type Snapshot = ReturnType<
	NonNullable<InferencePort["snapshotInTransaction"]>
>;
export type Kind = "openai-compatible" | "codex-sdk" | "claude-agent-sdk";

export const CONNECTION = "00000000-0000-4000-8000-000000000001";
export const RESOURCE = "00000000-0000-4000-8000-000000000002";
export const OTHER = "00000000-0000-4000-8000-000000000003";

/** Saved settings with a conversation model resource of `kind`, as the route picks it (or as it is left). */
export function settings(
	options: {
		mode?: "larm-preferred" | "larm-only" | "cloud-only";
		kind?: Kind;
		enabled?: boolean;
		fallbackId?: string | null;
		purpose?: "llm" | "asr";
	} = {},
): Snapshot {
	const mode = options.mode ?? "larm-only";
	const route = (m: typeof mode) => ({
		mode: m,
		cloudAllowed: m !== "larm-only",
		fallbackId:
			options.fallbackId === undefined ? RESOURCE : options.fallbackId,
		epoch: 0,
	});
	return {
		general: { agentName: "", userName: "", persona: "butler" },
		voice: { autoSpeak: false },
		routes: {
			llm: route(mode),
			asr: route("larm-preferred"),
			tts: route("larm-preferred"),
		},
		connections: [
			{
				id: CONNECTION,
				kind: options.kind ?? "codex-sdk",
				name: "c",
				enabled: options.enabled ?? true,
				epoch: 0,
			},
		],
		resources: [
			{
				id: RESOURCE,
				connectionId: CONNECTION,
				purpose: options.purpose ?? "llm",
				model: "m",
				contextWindow: 32768,
			},
		],
	} as unknown as Snapshot;
}
