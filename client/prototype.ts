import { z } from "zod";
import {
	prototypePreview,
	worksImagePolicy,
	prototypeStatus,
	registration,
	trialInventoryView,
	type TrialRequest,
} from "../api/domains/prototype/contracts";
import {
	prototypeImageView,
	type PrototypeImageRequest,
} from "../api/domains/image/contracts";
import { callJson, type Transport } from "./transport";

export function prototypeClient(transport: Transport) {
	const path = "/api/prototypes";
	const url = (id: string) => path + "/" + encodeURIComponent(id);
	function post(body?: unknown): RequestInit {
		return {
			method: "POST",
			...(body === undefined
				? {}
				: {
						body: JSON.stringify(body),
						headers: { "Content-Type": "application/json" },
					}),
		};
	}
	return {
		worksImages: (id: string) =>
			callJson(transport, worksImagePolicy, url(id) + "/images"),
		worksImageGrant: (
			id: string,
			input: { expectedRevision: number; enabled: boolean; assetIds: string[] },
		) =>
			callJson(
				transport,
				worksImagePolicy,
				url(id) + "/images/grant",
				post(input),
			),
		worksImageAsset: async (id: string, asset: string) =>
			(
				await transport.call(
					url(id) + "/images/assets/" + encodeURIComponent(asset),
				)
			).blob(),
		worksImageGenerations: (id: string) =>
			callJson(
				transport,
				prototypeImageView.array(),
				url(id) + "/images/generations",
			),
		worksImageStart: (id: string, input: PrototypeImageRequest) =>
			callJson(
				transport,
				prototypeImageView,
				url(id) + "/images/generations",
				post(input),
			),
		worksImageStatus: (id: string, operation: string) =>
			callJson(
				transport,
				prototypeImageView,
				url(id) + "/images/generations/" + encodeURIComponent(operation),
			),
		worksImageCancel: (id: string, operation: string) =>
			callJson(
				transport,
				prototypeImageView,
				url(id) + "/images/generations/" + encodeURIComponent(operation),
				{ method: "DELETE" },
			),
		worksImageContent: async (id: string, operation: string) =>
			(
				await transport.call(
					url(id) +
						"/images/generations/" +
						encodeURIComponent(operation) +
						"/content",
				)
			).blob(),
		prototypes: () => callJson(transport, prototypeStatus, path),
		prototypeTrial: (input: TrialRequest) =>
			callJson(transport, registration, path + "/trial", post(input)),
		prototypeTrialInventory: (id: string) =>
			callJson(transport, trialInventoryView, url(id) + "/trial"),
		prototypeRegister: (folder: string) =>
			callJson(
				transport,
				registration,
				path + "/register",
				post({ path: folder }),
			),
		prototypeCreate: (name: string) =>
			callJson(transport, registration, path + "/create", post({ name })),
		prototypeMove: (id: string, folder: string) =>
			callJson(
				transport,
				registration,
				url(id) + "/move",
				post({ path: folder }),
			),
		prototypeRemove: (id: string) =>
			callJson(transport, z.object({ ok: z.literal(true) }), url(id), {
				method: "DELETE",
			}),
		prototypeOpen: (id: string) =>
			callJson(transport, prototypePreview, url(id) + "/open", post()),
		prototypePreview: (id: string) =>
			callJson(transport, prototypePreview, url(id) + "/preview"),
		prototypeRetry: (id: string) =>
			callJson(transport, prototypePreview, url(id) + "/retry", post()),
		prototypeStalled: (id: string, version: string) =>
			callJson(
				transport,
				prototypePreview,
				url(id) + "/stalled",
				post({ version }),
			),
		prototypeHide: (id: string) =>
			callJson(
				transport,
				z.object({ ok: z.literal(true) }),
				url(id) + "/hide",
				post(),
			),
	};
}
