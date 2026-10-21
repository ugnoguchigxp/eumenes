import { expect, test } from "bun:test";
import { createComputeClient } from "../service/compute-client";
const origin = "http://compute.test:9810",
	url = `${origin}/v1/compute`;
const environment = {
	protocol: "larm.compute.v1",
	python: "fixture",
	packages: [],
	accelerators: [{ kind: "cpu", name: "CPU", memoryMiB: 2048 }],
	limits: {
		maxTimeoutSec: 60,
		maxCodeBytes: 65536,
		maxInputBytes: 262144,
		maxArtifactBytes: 5242880,
		maxArtifacts: 10,
	},
	environmentRevision: "rev",
	sandbox: {
		network: false,
		gpu: false,
		subprocesses: false,
		userThreads: false,
		memoryAccounting: "address_space",
	},
};
const advertised = (endpoint = url) => ({
	name: "changes-each-deployment",
	capability: "compute.python.execute",
	protocol: "larm.compute.v1",
	url: endpoint,
	description: "CPU sandbox",
});
const signal = () => AbortSignal.timeout(1000);
const request = {
	code: "result=2",
	inputs: {},
	timeoutSec: 60,
	accelerator: "auto" as const,
};
function mock(
	handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
	return createComputeClient({
		baseUrl: origin,
		token: "fixture-secret",
		fetch: ((url, init) =>
			handler(new URL(String(url)), init ?? {})) as typeof fetch,
	});
}
test.each(["root", "profile"])(
	"discovery uses %s services and authenticated environment",
	async (scope) => {
		const calls: string[] = [];
		const client = mock((u, init) => {
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer fixture-secret",
			);
			expect(init.redirect).toBe("error");
			calls.push(u.pathname);
			if (u.pathname === "/v3/agent-profiles")
				return Response.json(
					scope === "root"
						? { services: [advertised()], profiles: [] }
						: { services: [], profiles: [{ services: [advertised()] }] },
				);
			return Response.json(environment);
		});
		expect(await client.discover(signal())).toMatchObject({
			url,
			description: "CPU sandbox",
			environment: { python: "fixture" },
		});
		expect(calls).toEqual(["/v3/agent-profiles", "/v1/compute/environment"]);
	},
);
test.each([
	"http://other.test/v1/compute",
	"http://user:pass@compute.test:9810/v1/compute",
	`${url}?token=bad`,
	`${url}#fragment`,
])(
	"rejects an unsafe advertised URL before sending credentials: %s",
	async (endpoint) => {
		let calls = 0;
		const client = mock(() => {
			calls++;
			return Response.json({ services: [advertised(endpoint)] });
		});
		await expect(client.discover(signal())).rejects.toThrow(
			"compute_origin_mismatch",
		);
		expect(calls).toBe(1);
	},
);
test("missing or wrong capability is unavailable", async () => {
	const client = mock(() =>
		Response.json({ services: [{ ...advertised(), capability: "other" }] }),
	);
	await expect(client.discover(signal())).rejects.toThrow(
		"compute_service_unavailable",
	);
});
test("submit has the stable key, CPU request and no retry on HTTP refusal", async () => {
	let calls = 0;
	const client = mock((u, init) => {
		calls++;
		expect(u.href).toBe(`${url}/jobs`);
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("Idempotency-Key")).toBe("fixed-key");
		expect(JSON.parse(String(init.body))).toEqual(request);
		return Response.json(
			{ error: { code: "queue_full", message: "secret should never escape" } },
			{ status: 429, headers: { "Retry-After": "9" } },
		);
	});
	try {
		await client.submit(url, request, "fixed-key", signal());
		throw new Error("expected failure");
	} catch (e) {
		expect(e).toMatchObject({
			message: "queue_full",
			status: 429,
			retryAfterMs: 9000,
		});
		expect(String(e)).not.toContain("secret should");
	}
	expect(calls).toBe(1);
});
test("cancel uses POST /cancel and 202 is still a live job; DELETE 204 has no JSON", async () => {
	const id = crypto.randomUUID(),
		calls: string[] = [];
	const client = mock((u, init) => {
		calls.push(`${init.method} ${u.pathname}`);
		return init.method === "DELETE"
			? new Response(null, { status: 204 })
			: Response.json(
					{
						jobId: id,
						status: "running",
						stage: "running",
						queuedAt: "now",
						startedAt: null,
						finishedAt: null,
						expiresAt: null,
						resolvedAccelerator: "cpu",
						environmentRevision: "r",
						cancelRequested: true,
					},
					{ status: 202 },
				);
	});
	expect(await client.cancel(url, id, signal())).toMatchObject({
		status: "running",
		cancelRequested: true,
	});
	expect(await client.delete(url, id, signal())).toBeNull();
	expect(calls).toEqual([
		`POST /v1/compute/jobs/${id}/cancel`,
		`DELETE /v1/compute/jobs/${id}`,
	]);
});
test.each([401, 409, 410, 503])(
	"preserves safe HTTP %i classifications",
	async (status) => {
		const code =
			status === 401
				? "unauthorized"
				: status === 409
					? "request_conflict"
					: status === 410
						? "job_expired"
						: "unavailable";
		const client = mock(() =>
			Response.json({ error: { code, message: "private" } }, { status }),
		);
		await expect(
			client.get(url, crypto.randomUUID(), signal()),
		).rejects.toMatchObject({ code, status, message: code });
	},
);
test("wrong job ID and MIME/size/PNG content are rejected", async () => {
	const id = crypto.randomUUID(),
		artifactId = crypto.randomUUID();
	const invalid = mock(() =>
		Response.json({
			jobId: crypto.randomUUID(),
			status: "running",
			stage: "running",
			queuedAt: "now",
			startedAt: null,
			finishedAt: null,
			expiresAt: null,
			resolvedAccelerator: "cpu",
			environmentRevision: "r",
			cancelRequested: false,
		}),
	);
	await expect(invalid.get(url, id, signal())).rejects.toThrow(
		"compute_identity_mismatch",
	);
	const client = mock(
		() =>
			new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
	);
	await expect(
		client.artifact(
			url,
			id,
			{ id: artifactId, mime: "image/png", bytes: 6 },
			signal(),
		),
	).rejects.toThrow("compute_invalid_artifact");
});

test("DELETE rejects a response belonging to another job", async () => {
	const client = mock(() =>
		Response.json(
			{
				jobId: crypto.randomUUID(),
				status: "running",
				stage: "running",
				queuedAt: "now",
				startedAt: null,
				finishedAt: null,
				expiresAt: null,
				resolvedAccelerator: "cpu",
				environmentRevision: "r",
				cancelRequested: true,
			},
			{ status: 202 },
		),
	);
	await expect(
		client.delete(url, crypto.randomUUID(), signal()),
	).rejects.toThrow("compute_identity_mismatch");
});

test.each([true, false])(
	"uses the catalog's relative Control endpoint without sending credentials to the advertised hostname (url=%s)",
	async (withUrl) => {
		const calls: string[] = [];
		const client = mock((u, init) => {
			calls.push(u.href);
			expect(u.origin).toBe(origin);
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer fixture-secret",
			);
			if (u.pathname === "/v3/agent-profiles")
				return Response.json({
					services: [
						{
							...advertised(),
							url: withUrl
								? "http://unresolvable.local:9810/v1/compute"
								: undefined,
							endpoint: "/v1/compute",
						},
					],
				});
			return Response.json(environment);
		});
		expect((await client.discover(signal())).url).toBe(url);
		expect(calls).toEqual([
			`${origin}/v3/agent-profiles`,
			`${url}/environment`,
		]);
	},
);
test.each([
	"//other.test/v1/compute",
	"https://other.test/v1/compute",
	"/v1/compute?token=bad",
	"/v1/compute#fragment",
	"/different/path",
])(
	"rejects unsafe or contradictory advertised endpoint: %s",
	async (endpoint) => {
		let calls = 0;
		const client = mock(() => {
			calls++;
			return Response.json({ services: [{ ...advertised(), endpoint }] });
		});
		await expect(client.discover(signal())).rejects.toThrow(
			"compute_origin_mismatch",
		);
		expect(calls).toBe(1);
	},
);
