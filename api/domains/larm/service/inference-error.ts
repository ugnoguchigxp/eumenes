import { readBounded } from "../../../infrastructure/bounded-read";
export class LarmInferenceError extends Error {
	constructor(
		public status: number,
		public code?: string,
	) {
		super(`larm_inference_${status}`);
	}
}

/** Keep only bounded diagnostic fields, never response bodies or credentials. */
export async function providerError(
	response: Response,
	signal: AbortSignal,
	secrets: string[],
): Promise<{ errorCode?: string; errorMessage?: string }> {
	try {
		const bytes = await readBounded(response.body, {
			limit: 16384,
			tooLarge: "provider_error_too_large",
			missing: "invalid_provider_response",
			signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
		});
		const error = JSON.parse(new TextDecoder().decode(bytes))?.error;
		const errorCode =
			typeof error?.code === "string" &&
			/^[a-z][a-z0-9_]{0,100}$/.test(error.code)
				? error.code
				: undefined;
		let errorMessage =
			typeof error?.message === "string" ? error.message : undefined;
		if (errorMessage) {
			for (const secret of secrets)
				if (secret)
					errorMessage = errorMessage.replaceAll(secret, "[redacted]");
			errorMessage = errorMessage
				.replace(/bearer\s+(?!token\b)[^\s,;]+/gi, "Bearer [redacted]")
				// Diagnostic fields must remain single-line, printable text.
				// eslint-disable-next-line no-control-regex
				.replace(/[\u0000-\u001f\u007f]/g, " ")
				.slice(0, 512);
		}
		return { errorCode, errorMessage };
	} catch {
		return {};
	}
}
