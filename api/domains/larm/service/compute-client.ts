import { createHash } from "node:crypto";

/** Only safe classifications escape this client; upstream text is never an Error message. */
export class ComputeHttpError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly retryAfterMs: number | null = null,
	) {
		super(code);
	}
}
export type ComputeClientOptions = {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
};

type Transport = ReturnType<
	typeof import("./compute-transport").createComputeTransport
>;

export function createComputeClient(
	options: ComputeClientOptions,
): Transport & {
	binding: string;
	prepare(signal: AbortSignal): Promise<void>;
} {
	const base = new URL(options.baseUrl);
	function checked(value: string) {
		const u = new URL(value);
		if (
			!["http:", "https:"].includes(u.protocol) ||
			u.origin !== base.origin ||
			u.username ||
			u.password ||
			u.search ||
			u.hash
		)
			throw new ComputeHttpError("compute_origin_mismatch", 503);
		return u.href.replace(/\/$/, "");
	}
	checked(base.href);
	const binding = createHash("sha256")
		.update(JSON.stringify([base.origin, options.token]))
		.digest("hex");
	let instance: Transport | undefined;
	async function transport(signal: AbortSignal) {
		signal.throwIfAborted();
		if (instance) return instance;
		const { createComputeTransport } = await import("./compute-transport");
		signal.throwIfAborted();
		return (instance ??= createComputeTransport(options, base, checked));
	}
	return {
		binding,
		async prepare(signal) {
			await transport(signal);
		},
		async discover(signal) {
			return (await transport(signal)).discover(signal);
		},
		async submit(url, body, key, signal) {
			return (await transport(signal)).submit(url, body, key, signal);
		},
		async get(url, id, signal) {
			return (await transport(signal)).get(url, id, signal);
		},
		async cancel(url, id, signal) {
			return (await transport(signal)).cancel(url, id, signal);
		},
		async delete(url, id, signal) {
			return (await transport(signal)).delete(url, id, signal);
		},
		async artifact(url, id, artifact, signal) {
			return (await transport(signal)).artifact(url, id, artifact, signal);
		},
	};
}
