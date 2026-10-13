import { readBounded } from "../../../infrastructure/bounded-read";
import {
	acceptedJob,
	detectionResult,
	jobResult,
	type Connection,
} from "../contracts";
export function recognitionGateway(
	connection: Connection,
	fetcher: typeof fetch = fetch,
) {
	async function call(
		path: string,
		init: RequestInit,
		signal: AbortSignal,
		parseBody = true,
	) {
		let response: Response;
		try {
			response = await fetcher(new URL(path, connection.baseUrl), {
				...init,
				signal,
				redirect: "error",
				headers: { Authorization: `Bearer ${connection.credential}` },
			});
		} catch {
			throw new Error("recognition_connection_failed");
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				response.status === 429 || response.status === 503
					? "recognition_busy"
					: response.status === 413
						? "recognition_input_too_large"
						: response.status === 400 ||
							  response.status === 415 ||
							  response.status === 422
							? "recognition_invalid_input"
							: response.status === 401 || response.status === 403
								? "recognition_auth_failed"
								: "recognition_upstream_failed",
			);
		}
		if (!parseBody) {
			await response.body?.cancel();
			return { status: response.status, body: null };
		}
		const bytes = await readBounded(response.body, {
			limit: 8 * 1024 * 1024,
			missing: "recognition_invalid_response",
			tooLarge: "recognition_invalid_response",
			signal,
		});
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new Error("recognition_invalid_response");
		}

		return { status: response.status, body };
	}
	return {
		async analyze(file: File, signal: AbortSignal) {
			const form = new FormData();
			form.append("file", file);
			const r = await call(
				"/api/analyze",
				{ method: "POST", body: form },
				signal,
			);
			const parsed =
				r.status === 202
					? acceptedJob.safeParse(r.body)
					: detectionResult.safeParse(r.body);
			if (!parsed.success) throw new Error("recognition_invalid_response");
			// Ignore statusUrl: paths are host-built on the bound gateway, not arbitrary URLs.
			return parsed.data;
		},
		async status(id: string, signal: AbortSignal) {
			const r = await call(
				`/api/jobs/${encodeURIComponent(id)}`,
				{ method: "GET" },
				signal,
			);
			const parsed = jobResult.safeParse(r.body);
			if (!parsed.success || (parsed.data.id && parsed.data.id !== id))
				throw new Error("recognition_invalid_response");
			return parsed.data;
		},
		async cancel(id: string, signal: AbortSignal) {
			// A successful cancel POST is a request; terminal state is confirmed by GET.
			await call(
				`/api/jobs/${encodeURIComponent(id)}/cancel`,
				{ method: "POST" },
				signal,
				false,
			);
		},
	};
}
