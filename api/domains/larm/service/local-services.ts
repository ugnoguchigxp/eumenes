import { readBounded } from "../../../infrastructure/bounded-read";
import {
	localServiceLease,
	type LocalServiceLease,
	type LocalServicesPort,
} from "../contracts/local-services";
export function createLocalServices(options: {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}): LocalServicesPort {
	const base = new URL(options.baseUrl);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("invalid_local_service_url");
	async function request(
		path: string,
		method: string,
		signal: AbortSignal,
		body?: unknown,
		key?: string,
	) {
		const r = await (options.fetch ?? fetch)(
			`${options.baseUrl.replace(/\/$/, "")}${path}`,
			{
				method,
				signal,
				redirect: "error",
				headers: {
					authorization: `Bearer ${options.token}`,
					"content-type": "application/json",
					...(key ? { "Idempotency-Key": key } : {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
		);
		if (!r.ok) {
			await r.body?.cancel();
			throw new Error(`local_service_http_${r.status}`);
		}
		return r;
	}
	async function lease(
		path: string,
		method: string,
		signal: AbortSignal,
		body?: unknown,
		key?: string,
	) {
		const r = await request(path, method, signal, body, key);
		const bytes = await readBounded(r.body, {
			limit: 131072,
			missing: "local_service_empty",
			tooLarge: "local_service_too_large",
			signal,
		});
		return localServiceLease.parse(JSON.parse(new TextDecoder().decode(bytes)));
	}
	const same = (value: LocalServiceLease, expected: LocalServiceLease) => {
		if (
			["id", "serviceId", "revision", "generation", "bootEpoch"].some(
				(k) =>
					value[k as keyof LocalServiceLease] !==
					expected[k as keyof LocalServiceLease],
			)
		)
			throw new Error("local_service_binding_changed");
		return value;
	};
	return {
		async ensure(service, key, signal) {
			const value = await lease(
				`/v1/local-services/${encodeURIComponent(service)}/leases`,
				"POST",
				signal,
				{},
				key,
			);
			if (value.serviceId !== service)
				throw new Error("local_service_identity_mismatch");
			return value;
		},
		resolve: async (expected, signal) =>
			same(
				await lease(
					`/v1/local-service-leases/${encodeURIComponent(expected.id)}`,
					"GET",
					signal,
				),
				expected,
			),
		renew: async (expected, signal) =>
			same(
				await lease(
					`/v1/local-service-leases/${encodeURIComponent(expected.id)}/renew`,
					"POST",
					signal,
					{ generation: expected.generation, bootEpoch: expected.bootEpoch },
				),
				expected,
			),
		async release(id) {
			const r = await request(
				`/v1/local-service-leases/${encodeURIComponent(id)}`,
				"DELETE",
				AbortSignal.timeout(10000),
			);
			await r.body?.cancel();
		},
	};
}
