import {
	videoAdmission,
	videoList,
	videoMetadataView,
	videoRequestView,
	videoServiceInfo,
	videoWorkspace,
	type VideoInput,
} from "../api/domains/video/contracts";
import { callJson, json, type Transport } from "./transport";

const base = "/api/videos";
const request = (id: string) => `${base}/generations/${encodeURIComponent(id)}`;
const saved = (id: string) => `${base}/${encodeURIComponent(id)}`;

export function videoClient(t: Transport) {
	return {
		videoAdmission: (signal?: AbortSignal) =>
			callJson(t, videoAdmission, base + "/admission", { signal }),
		videoWorkspace: (signal?: AbortSignal) =>
			callJson(t, videoWorkspace, base + "/workspace", { signal }),
		videoService: (signal?: AbortSignal) =>
			callJson(t, videoServiceInfo, base + "/service", { signal }),
		videoList: (signal?: AbortSignal) =>
			callJson(t, videoList, base, { signal }),
		videoMetadata: (id: string, signal?: AbortSignal) =>
			callJson(t, videoMetadataView, saved(id) + "/metadata", { signal }),
		videoContent: async (id: string, signal?: AbortSignal) =>
			(await t.call(saved(id) + "/content", { signal })).blob(),
		generateVideo: (id: string, input: VideoInput) =>
			callJson(t, videoRequestView, base + "/generations", {
				...json(input),
				headers: { "Content-Type": "application/json", "Idempotency-Key": id },
			}),
		reconcileVideo: (id: string) =>
			callJson(t, videoRequestView, request(id) + "/reconcile", {
				method: "POST",
			}),
		cancelVideo: (id: string) =>
			callJson(t, videoRequestView, request(id), { method: "DELETE" }),
		deleteVideo: (id: string) => t.call(saved(id), { method: "DELETE" }),
	};
}
