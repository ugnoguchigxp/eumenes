import { z } from "zod";
import { imageImportReceipt } from "../contracts/image-import";
import { json } from "./playground-http";

const statuses = [
	200, 201, 202, 400, 401, 403, 404, 409, 410, 413, 415, 429, 503, 507,
];
export class ImageImportError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		public readonly retryAfterMs = 1000,
	) {
		super(code);
	}
}

export function createImageImports(
	control: (
		path: string,
		signal: AbortSignal,
		init?: RequestInit,
		accepted?: number[],
	) => Promise<Response>,
	publicUrl: (path: string) => URL,
	identity: string,
) {
	async function read(response: Response, requestId: string) {
		const body = await json(response);
		const parsed = imageImportReceipt.safeParse(body);
		const retry = Number(response.headers.get("Retry-After") ?? 1);
		const retryAfterMs = Number.isFinite(retry)
			? Math.max(1000, Math.min(60_000, retry * 1000))
			: 1000;
		if (!parsed.success) {
			const error = z
				.object({ error: z.object({ code: z.string().min(1).max(128) }) })
				.safeParse(body);
			if (!error.success || response.ok)
				throw new Error("invalid_image_import_response");
			throw new ImageImportError(
				response.status,
				error.data.error.code,
				retryAfterMs,
			);
		}
		const receipt = parsed.data;
		if (
			receipt.requestId !== requestId ||
			receipt.statusUrl !== `/v1/image-imports/${requestId}` ||
			Date.parse(receipt.expiresAt) <= Date.parse(receipt.createdAt)
		)
			throw new Error("invalid_image_import_response");
		publicUrl(receipt.statusUrl);
		if (receipt.status === "succeeded" && !receipt.deleted) {
			const a = receipt.artifact;
			if (
				publicUrl(a.contentUrl).pathname !==
					`/v1/image-artifacts/${a.id}/content` ||
				a.mimeType !== `image/${a.format}` ||
				a.width > 2000 ||
				a.height > 2000 ||
				a.bytes > 20 * 1024 * 1024
			)
				throw new Error("invalid_image_import_response");
		}
		if (!response.ok && receipt.status !== "failed")
			throw new Error("invalid_image_import_response");
		return { receipt, retryAfterMs, httpStatus: response.status };
	}
	return {
		identity,
		async send(requestId: string, bytes: Uint8Array, signal: AbortSignal) {
			z.uuid().parse(requestId);
			const body = new FormData();
			body.append(
				"file",
				new Blob([new Uint8Array(bytes)], { type: "image/webp" }),
				"image.webp",
			);
			return read(
				await control(
					"/v1/image-artifacts/imports",
					signal,
					{ method: "POST", headers: { "Idempotency-Key": requestId }, body },
					statuses,
				),
				requestId,
			);
		},
		async read(requestId: string, signal: AbortSignal) {
			z.uuid().parse(requestId);
			return read(
				await control(
					`/v1/image-imports/${requestId}`,
					signal,
					undefined,
					statuses,
				),
				requestId,
			);
		},
	};
}
