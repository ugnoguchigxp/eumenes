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
	const reader = response.body?.getReader();
	if (!reader) return {};
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
	deadline.addEventListener("abort", abort, { once: true });
	let text = "",
		size = 0;
	const decoder = new TextDecoder();
	try {
		deadline.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			deadline.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > 16384) return {};
			text += decoder.decode(value, { stream: true });
		}
		const error = JSON.parse(text + decoder.decode())?.error;
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
	} finally {
		deadline.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
