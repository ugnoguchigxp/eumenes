export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
export class ApiConnectionError extends TypeError {
	constructor() {
		super("api_connection_failed");
	}
}
export function createTransport(baseUrl: string, token?: string) {
	const base = new URL(baseUrl);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password
	)
		throw new Error("invalid_api_url");
	if (!["127.0.0.1", "localhost"].includes(base.hostname))
		throw new Error("loopback_api_required");
	return {
		identity: base.origin,
		async call(path: string, init: RequestInit = {}) {
			const response = await fetch(new URL(path, base), {
				...init,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...init.headers,
				},
				cache: "no-store",
			}).catch((error: unknown) => {
				if (error instanceof TypeError && !init.signal?.aborted)
					throw new ApiConnectionError();
				throw error;
			});
			if (!response.ok) {
				const error = (await response
					.json()
					.catch(() => ({ error: `HTTP ${response.status}` }))) as {
					error?: string;
				};
				throw new ApiError(
					response.status,
					error.error ?? `HTTP ${response.status}`,
				);
			}
			return response;
		},
	};
}
export type Transport = ReturnType<typeof createTransport>;
export const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
