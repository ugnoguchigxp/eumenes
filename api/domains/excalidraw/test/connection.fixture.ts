import { createLocalServices, type LocalServiceLease } from "../../larm";
import type { Drawing, Scene } from "../contracts";
export function drawingFixture() {
	const requests: Array<{
		path: string;
		method: string;
		headers: Headers;
		body: unknown;
	}> = [];
	const leases = new Map<string, LocalServiceLease>(),
		documents = new Map<string, Drawing[]>(),
		saved = new Map<string, { body: string; result: unknown }>();
	let generation = 1,
		failSave = false,
		deleteRoute = true,
		bindingChanged = false,
		delay: Promise<void> | null = null,
		cold = true,
		polls = 0;
	const fetcher = (async (
		url: string | URL | Request,
		init: RequestInit = {},
	) => {
		const u = new URL(String(url)),
			method = init.method ?? "GET",
			headers = new Headers(init.headers);
		const body = init.body ? JSON.parse(String(init.body)) : null;
		requests.push({ path: u.pathname, method, headers, body });
		const reply = (value: unknown, status = 200) =>
			Response.json(value, { status });
		if (u.pathname.startsWith("/v1/")) {
			if (headers.get("authorization") !== `Bearer ${"consumer-".repeat(5)}`)
				return reply({ error: "unauthorized" }, 401);
			if (method === "POST" && u.pathname.endsWith("/leases")) {
				if (delay) await delay;
				const lease: LocalServiceLease = {
					id: crypto.randomUUID(),
					serviceId: "excalidraw-host",
					revision: "a".repeat(64),
					generation,
					bootEpoch: `boot-${generation}`,
					expiresAt: new Date(Date.now() + 120000).toISOString(),
					status: cold ? "starting" : "ready",
					...(cold ? {} : { endpoint: "http://127.0.0.1:18792/" }),
				};
				leases.set(lease.id, lease);
				return reply(lease);
			}
			const id = u.pathname.split("/")[3]!,
				lease = leases.get(id);
			if (!lease) return reply({}, 404);
			if (method === "DELETE") {
				lease.status = "released";
				delete lease.endpoint;
				return reply({});
			}
			if (bindingChanged)
				return reply({ ...lease, generation: lease.generation + 1 });
			if (lease.status === "starting" && ++polls >= 2) {
				lease.status = "ready";
				lease.endpoint = "http://127.0.0.1:18792/";
				cold = false;
			}
			lease.expiresAt = new Date(Date.now() + 120000).toISOString();
			return reply(lease);
		}
		if (
			headers.get("authorization") !== `Bearer ${"business-".repeat(5)}` ||
			headers.has("origin") ||
			headers.has("cookie") ||
			headers.get("host") !== "127.0.0.1:18790"
		)
			return reply({ error: "unauthorized" }, 401);
		const id = u.pathname.split("/")[3];
		// The requested deletion contract: JSON confirmation, 404 once gone.
		if (method === "DELETE") {
			// An older host has no delete route and answers a plain-text 404.
			if (!deleteRoute) return new Response("Not Found", { status: 404 });
			if (failSave) return reply({ error: "storage_error" }, 503);
			if (!id || !documents.delete(id))
				return reply({ error: "document_not_found" }, 404);
			return reply({ id, deleted: true });
		}
		if (method === "POST" || method === "PUT") {
			if (failSave && method === "PUT")
				return reply({ error: "storage_error" }, 503);
			const key = headers.get("Idempotency-Key");
			if (!key) return reply({}, 400);
			const prior = saved.get(key);
			if (prior)
				return prior.body === JSON.stringify(body)
					? reply(prior.result, method === "POST" ? 201 : 200)
					: reply({ error: "idempotency_conflict" }, 409);
			const versions = id ? documents.get(id) : undefined;
			if (id && !versions) return reply({}, 404);
			const old = versions?.at(-1);
			if (old && body.expectedRevision !== old.revision)
				return reply({ error: "revision_conflict" }, 409);
			const value: Drawing = {
				id: id ?? crypto.randomUUID(),
				title: body.title,
				revision: (old?.revision ?? 0) + 1,
				scene: body.scene as Scene,
			};
			documents.set(value.id, [...(versions ?? []), value]);
			const result = {
				id: value.id,
				title: value.title,
				revision: value.revision,
				owner: "fixture-eumenes",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			saved.set(key, { body: JSON.stringify(body), result });
			return reply(result, method === "POST" ? 201 : 200);
		}
		const versions = documents.get(id!);
		if (!versions) return reply({}, 404);
		const version = u.searchParams.get("revision");
		return reply(
			version
				? versions.find((v) => v.revision === Number(version))
				: versions.at(-1),
		);
	}) as typeof fetch;
	return {
		requests,
		documents,
		leases,
		fetcher,
		connection: () => ({
			version: "fixture-1",
			gatewayUrl: "http://127.0.0.1:18791/",
			gatewayOrigin: "http://127.0.0.1:18790/",
			leaseEndpoint: "http://127.0.0.1:18792/",
			appToken: "business-".repeat(5),
			client: createLocalServices({
				baseUrl: "http://127.0.0.1:19810",
				token: "consumer-".repeat(5),
				fetch: fetcher,
			}),
		}),
		deleteRoute(value: boolean) {
			deleteRoute = value;
		},
		failSave(value: boolean) {
			failSave = value;
		},
		changeBinding() {
			bindingChanged = true;
		},
		delay(value: Promise<void> | null) {
			delay = value;
		},
		stop() {
			generation++;
			cold = true;
			polls = 0;
			for (const l of leases.values()) {
				l.status = "expired";
				delete l.endpoint;
			}
		},
	};
}
