import type { TestInput } from "../contracts/playground";
import { code, json, post } from "./playground-http";

/** The image POST is sent once. Only known external error codes cross the boundary. */
export async function generateImageRequest(
	control: (
		path: string,
		signal: AbortSignal,
		init: RequestInit,
		accepted: number[],
		compressRequest: boolean,
	) => Promise<Response>,
	endpoint: string,
	input: TestInput,
	signal: AbortSignal,
) {
	try {
		const response = await control(
			endpoint,
			signal,
			post({
				prompt: input.text,
				model: input.model,
				width: input.width ?? 512,
				height: input.height ?? 512,
				format: input.format ?? "webp",
				seed: input.seed ?? 0,
			}),
			[200, 400, 409, 503],
			true,
		);
		if (response.status !== 200) {
			let failure: Record<string, unknown> = {};
			try {
				failure = await json(response);
			} catch {}
			const error = failure.error;
			const errorCode =
				typeof error === "string"
					? error
					: error && typeof error === "object" && "code" in error
						? error.code
						: failure.code;
			if (
				(response.status === 503 && errorCode === "image_model_unavailable") ||
				(response.status === 409 && errorCode === "media_variant_busy")
			)
				throw new Error(errorCode);
			throw new Error(`larm_http_${response.status}`);
		}
		return await json(response);
	} catch (error) {
		if (
			signal.aborted ||
			["network_unavailable", "deadline_exceeded"].includes(code(error))
		)
			throw new Error("generation_unknown");
		throw error;
	}
}
