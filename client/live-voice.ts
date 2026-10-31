import { z } from "zod";
import {
	liveSnapshotSchema,
	type LiveEvent,
} from "../api/domains/live-voice/contracts";
import { json, callJson, type Transport } from "./transport";
export function liveVoiceClient(t: Transport) {
	const path = (id: string) => `/api/live/sessions/${encodeURIComponent(id)}`;
	return {
		liveModels: (signal: AbortSignal) =>
			callJson(
				t,
				z.object({ models: z.array(z.string()) }),
				"/api/live/models",
				{ signal },
			),
		liveCurrent: (id: string) =>
			callJson(
				t,
				liveSnapshotSchema.nullable(),
				`/api/live/conversations/${encodeURIComponent(id)}`,
			),
		liveStart: (requestId: string, conversationId: string, test = false) =>
			callJson(
				t,
				liveSnapshotSchema,
				"/api/live/sessions",
				json({ requestId, conversationId, test }),
			),
		liveStop: (id: string) =>
			callJson(t, liveSnapshotSchema.nullable(), `${path(id)}/stop`, json({})),
		liveMute: async (id: string, muted: boolean) => {
			await t.call(`${path(id)}/mute`, json({ muted }));
		},
		liveAudio: async (
			id: string,
			sequence: number,
			audio: string,
			signal?: AbortSignal,
		) => {
			await t.call(`${path(id)}/audio`, {
				...json({ sequence, audio }),
				signal,
			});
		},
		liveDisplayed: async (id: string, notice: string) => {
			await t.call(
				`${path(id)}/notices/${encodeURIComponent(notice)}/displayed`,
				json({}),
			);
		},
		liveStream: (id: string, signal: AbortSignal) =>
			t.call(`${path(id)}/stream`, { signal }),
	};
}
export const parseLiveEvent = (value: unknown): LiveEvent =>
	z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("state"), state: liveSnapshotSchema }),
			z.object({
				type: z.literal("audio"),
				sequence: z.number().int().positive(),
				audio: z.string().max(256000),
			}),
		])
		.parse(value);
