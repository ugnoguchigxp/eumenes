import { voiceTurnSchema } from "../api/domains/voice-dialogue/contracts";
import { avatarMotionSchema } from "../api/domains/delivery";
import type { Transport } from "./transport";
import { json } from "./transport";
export function voiceDialogueClient(transport: Transport) {
	return {
		identity: transport.identity,
		voiceStart: async (sessionId: string, generation: number) =>
			await (
				await transport.call(
					"/api/voice/sessions",
					json({ sessionId, generation }),
				)
			).json(),
		voiceStop: async (sessionId: string, generation: number) =>
			await (
				await transport.call(
					"/api/voice/sessions/stop",
					json({ sessionId, generation }),
				)
			).json(),
		voiceSend: async (
			sessionId: string,
			generation: number,
			sequence: number,
			utteranceId: string,
			wav: Uint8Array,
		) => {
			return voiceTurnSchema.parse(
				await (
					await transport.call("/api/voice/turns", {
						method: "POST",
						headers: {
							"Content-Type": "audio/wav",
							"X-Session-Id": sessionId,
							"X-Generation": String(generation),
							"X-Sequence": String(sequence),
							"X-Utterance-Id": utteranceId,
						},
						body: new Uint8Array(wav),
					})
				).json(),
			);
		},
		voicePreview: async (
			sessionId: string,
			generation: number,
			id: string,
			wav: Uint8Array,
			signal: AbortSignal,
		) => {
			const response = await transport.call("/api/voice/preview", {
				method: "POST",
				signal,
				headers: {
					"Content-Type": "audio/wav",
					"X-Session-Id": sessionId,
					"X-Generation": String(generation),
					"X-Sequence": "1",
					"X-Utterance-Id": id,
				},
				body: new Uint8Array(wav),
			});
			return (await response.json()) as { utteranceId: string; text: string };
		},
		voiceTurn: async (id: string) =>
			voiceTurnSchema.parse(
				await (
					await transport.call(`/api/voice/turns/${encodeURIComponent(id)}`)
				).json(),
			),
		voiceAudio: async (id: string, index?: number) =>
			new Uint8Array(
				await (
					await transport.call(
						`/api/voice/turns/${encodeURIComponent(id)}/audio${index === undefined ? "" : `?index=${index}`}`,
					)
				).arrayBuffer(),
			),
		voicePlayed: async (id: string, index?: number) =>
			voiceTurnSchema.parse(
				await (
					await transport.call(
						`/api/voice/turns/${encodeURIComponent(id)}/played${index === undefined ? "" : `?index=${index}`}`,
						json({}),
					)
				).json(),
			),
		replaySentences: async (text: string): Promise<string[]> =>
			(
				(await (
					await transport.call("/api/voice/replay/sentences", json({ text }))
				).json()) as { sentences: string[] }
			).sentences,
		replayAudio: async (text: string, signal?: AbortSignal) =>
			new Uint8Array(
				await (
					await transport.call("/api/voice/replay/audio", {
						...json({ text }),
						signal,
					})
				).arrayBuffer(),
			),
		replaySpeech: async (
			text: string,
			signal?: AbortSignal,
			runId?: string,
		) => {
			const response = await transport.call("/api/voice/replay/audio", {
				...json({ text, ...(runId ? { runId } : {}) }),
				signal,
			});
			const motion = avatarMotionSchema.safeParse(
				response.headers.get("X-Avatar-Motion"),
			);
			return {
				wav: new Uint8Array(await response.arrayBuffer()),
				motion: motion.success ? motion.data : ("neutral" as const),
			};
		},
		voiceSample: async (
			voice: {
				voice?: string;
				style?: string;
				speed?: number;
				pitchScale?: number;
				intonationScale?: number;
			},
			signal?: AbortSignal,
		) =>
			new Uint8Array(
				await (
					await transport.call("/api/voice/sample", {
						...json(voice),
						signal,
					})
				).arrayBuffer(),
			),
		voiceCancel: async (id: string) =>
			voiceTurnSchema.parse(
				await (
					await transport.call(
						`/api/voice/turns/${encodeURIComponent(id)}/cancel`,
						json({}),
					)
				).json(),
			),
	};
}
export type VoiceDialogueClient = ReturnType<typeof voiceDialogueClient>;
