import { voiceTurnSchema } from "../api/domains/voice-dialogue/contracts";
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
