import {
	readyStatusSchema,
	statusResponseSchema,
} from "../api/domains/larm/contracts";
import {
	playbackScreenSchema,
	imageInputSchema,
	type ScreenDetails,
} from "../api/domains/inference/contracts";
import { callJson, json, type Transport } from "./transport";
export function larmClient(transport: Transport) {
	return {
		identity: transport.identity,
		/** Reports the screen; the answer says whether it is the one screen that plays sound. */
		screenPresence: async (
			id: string,
			revision: number,
			active: boolean,
			sentAt: number,
			signal?: AbortSignal,
			details: ScreenDetails = {},
		) =>
			callJson(
				transport,
				playbackScreenSchema,
				`/api/inference/screen/${encodeURIComponent(id)}`,
				{
					...json({ revision, active, sentAt, ...details }, "PUT"),
					keepalive: true,
					signal,
				},
			),
		playbackScreen: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				playbackScreenSchema,
				`/api/inference/screen/${encodeURIComponent(id)}`,
				{ signal },
			),
		imageInput: async (signal?: AbortSignal) =>
			callJson(transport, imageInputSchema, "/api/inference/image-input", {
				signal,
			}),
		status: async () =>
			callJson(transport, statusResponseSchema, "/api/status"),
		connectLarm: async () =>
			callJson(transport, readyStatusSchema, "/api/larm/connect", {
				method: "POST",
			}),
	};
}
