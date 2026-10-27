import {
	previewResultSchema,
	replaySentencesSchema,
	voiceTurnSchema,
	type InputTiming,
	type ChunkGap,
	type ReplayPlayed,
} from "../api/domains/voice-dialogue/contracts";
import { avatarMotionSchema } from "../api/domains/delivery/contracts";
import { z } from "zod";
import { callJson, json, withQuery, type Transport } from "./transport";

const voiceSessionSchema = z.object({
	sessionId: z.string(),
	generation: z.number().int(),
});
const voiceStoppedSchema = z.object({ stopped: z.literal(true) });
export function voiceDialogueClient(transport: Transport) {
	return {
		identity: transport.identity,
		voiceStart: (sessionId: string, generation: number) =>
			callJson(
				transport,
				voiceSessionSchema,
				"/api/voice/sessions",
				json({ sessionId, generation }),
			),
		voiceStop: (sessionId: string, generation: number) =>
			callJson(
				transport,
				voiceStoppedSchema,
				"/api/voice/sessions/stop",
				json({ sessionId, generation }),
			),
		voiceSend: async (
			sessionId: string,
			generation: number,
			sequence: number,
			utteranceId: string,
			wav: Uint8Array,
		) => {
			return callJson(transport, voiceTurnSchema, "/api/voice/turns", {
				method: "POST",
				headers: {
					"Content-Type": "audio/wav",
					"X-Session-Id": sessionId,
					"X-Generation": String(generation),
					"X-Sequence": String(sequence),
					"X-Utterance-Id": utteranceId,
				},
				body: new Uint8Array(wav),
			});
		},
		voicePreview: async (
			sessionId: string,
			generation: number,
			id: string,
			wav: Uint8Array,
			signal: AbortSignal,
		) => {
			return callJson(transport, previewResultSchema, "/api/voice/preview", {
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
		},
		voiceCommit: async (
			id: string,
			revision: number,
			viewing?:
				| { artifactRevisionId: string; targetRef: string }
				| { resource: string },
			timing?: InputTiming,
		) =>
			callJson(
				transport,
				voiceTurnSchema,
				`/api/voice/turns/${encodeURIComponent(id)}/commit`,
				json({
					revision,
					...(viewing ? { viewing } : {}),
					...(timing ? { timing } : {}),
				}),
			),
		voiceTurn: async (id: string) =>
			callJson(
				transport,
				voiceTurnSchema,
				`/api/voice/turns/${encodeURIComponent(id)}`,
			),
		voiceAudio: async (id: string, index?: number) =>
			new Uint8Array(
				await (
					await transport.call(
						withQuery(`/api/voice/turns/${encodeURIComponent(id)}/audio`, {
							index,
						}),
					)
				).arrayBuffer(),
			),
		voicePlayed: async (
			id: string,
			index?: number,
			gap?: Partial<ChunkGap> & { audible?: boolean },
		) =>
			callJson(
				transport,
				voiceTurnSchema,
				withQuery(`/api/voice/turns/${encodeURIComponent(id)}/played`, {
					index,
				}),
				json(gap ?? {}),
			),
		replayPlayed: (played: ReplayPlayed) =>
			callJson(
				transport,
				z.object({ recorded: z.boolean() }),
				"/api/voice/replay/played",
				json(played),
			),
		replaySentences: async (text: string): Promise<string[]> =>
			(
				await callJson(
					transport,
					replaySentencesSchema,
					"/api/voice/replay/sentences",
					json({ text }),
				)
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
			messageId?: string,
		) => {
			const response = await transport.call("/api/voice/replay/audio", {
				...json({
					text,
					...(runId ? { runId } : {}),
					...(messageId ? { messageId } : {}),
				}),
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
				style?: string | null;
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
			callJson(
				transport,
				voiceTurnSchema,
				`/api/voice/turns/${encodeURIComponent(id)}/cancel`,
				json({}),
			),
	};
}
export type VoiceDialogueClient = ReturnType<typeof voiceDialogueClient>;
