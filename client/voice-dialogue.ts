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
		voiceTurn: async (id: string) =>
			voiceTurnSchema.parse(
				await (
					await transport.call(`/api/voice/turns/${encodeURIComponent(id)}`)
				).json(),
			),
		voiceAudio: async (id: string) =>
			new Uint8Array(
				await (
					await transport.call(
						`/api/voice/turns/${encodeURIComponent(id)}/audio`,
					)
				).arrayBuffer(),
			),
		voicePlayed: async (id: string) =>
			voiceTurnSchema.parse(
				await (
					await transport.call(
						`/api/voice/turns/${encodeURIComponent(id)}/played`,
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
