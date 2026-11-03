import { readBounded } from "./bounded-read";
/** Host-built paths on the bound gateway; domain schemas remain at the caller. */
export function createMediaGateway<T, J>(
	connection: { baseUrl: string; credential: string },
	fetcher: typeof fetch,
	prefix: string,
	checkRefusal: (
		response: Response,
		path: string,
		waitable: boolean,
	) => Promise<void>,
	parse: (status: number, body: unknown) => T,
	parseJob: (body: unknown, id: string) => J,
) {
	async function call(
		path: string,
		init: RequestInit,
		signal: AbortSignal,
		parseBody = true,
		waitable = false,
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
			throw new Error(`${prefix}_connection_failed`);
		}
		if (!response.ok) {
			// A capacity refusal is thrown only for the request that starts work; it becomes a wait.
			await checkRefusal(response, path, waitable);
			throw new Error(
				response.status === 429 || response.status === 503
					? `${prefix}_busy`
					: response.status === 413
						? `${prefix}_input_too_large`
						: response.status === 400 ||
							  response.status === 415 ||
							  response.status === 422
							? `${prefix}_invalid_input`
							: response.status === 401 || response.status === 403
								? `${prefix}_auth_failed`
								: `${prefix}_upstream_failed`,
			);
		}
		if (!parseBody) {
			await response.body?.cancel();
			return { status: response.status, body: null };
		}
		const bytes = await readBounded(response.body, {
			limit: 8 * 1024 * 1024,
			missing: `${prefix}_invalid_response`,
			tooLarge: `${prefix}_invalid_response`,
			signal,
		});
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new Error(`${prefix}_invalid_response`);
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
				true,
				true,
			);
			return parse(r.status, r.body);
		},
		async status(id: string, signal: AbortSignal) {
			const r = await call(
				`/api/jobs/${encodeURIComponent(id)}`,
				{ method: "GET" },
				signal,
			);
			return parseJob(r.body, id);
		},
		async cancel(id: string, signal: AbortSignal) {
			await call(
				`/api/jobs/${encodeURIComponent(id)}/cancel`,
				{ method: "POST" },
				signal,
				false,
			);
		},
	};
}
