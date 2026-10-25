import { expect, test } from "bun:test";
import { createVisualPerception } from "..";
import type { StopObservation } from "../contracts/visual-perception";
import { observeVisualStop } from "../service/visual-stop-observation";
import { visualFetcher, visualImage } from "./visual-perception.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
const client = (f: ReturnType<typeof visualFetcher>) =>
	createVisualPerception({
		baseUrl: "http://127.0.0.1:9810",
		token: "control-secret",
		audience: "desktop",
		fetch: f.fetcher,
		pollMs: 1,
		stopTimeoutMs: 25,
	});
const perceive = async (
	f: ReturnType<typeof visualFetcher>,
	signal = AbortSignal.timeout(1000),
	progress: Parameters<
		ReturnType<typeof client>["perceive"]
	>[3] = async () => {},
) =>
	client(f).perceive(
		await visualImage(),
		{ task: "describe", query: "説明" },
		signal,
		progress,
	);
test("ready claims immediately despite stale false claimability/readiness cache, and observes fresh bound COLD with Control auth", async () => {
	const f = visualFetcher({
		connection: (s) => ({
			...s,
			providers: (s.providers as object[]).map((p) => ({
				...p,
				claimable: false,
				readiness: "pending",
			})),
		}),
	});
	let observation: StopObservation | undefined;
	await perceive(f, undefined, async (_p, _id, o) => {
		if (o) observation = o;
	});
	await waitFor(() => observation?.status === "cold");
	expect(observation).toMatchObject({
		allocationId: "fixture-allocation",
		runtimeId: "fixture-runtime",
		status: "cold",
	});
	expect(Date.parse(observation!.observedAt!)).toBeGreaterThanOrEqual(
		Date.parse(observation!.releasedAt!),
	);
	const snapshots = f.requests.filter(
		(r) => r.path === "/state" || r.path.startsWith("/v1/allocations/"),
	);
	expect(snapshots.length).toBeGreaterThanOrEqual(2);
	for (const r of snapshots) {
		expect(r.cache).toBe("no-store");
		expect(r.headers.get("Authorization")).toBe("Bearer control-secret");
	}
	expect(f.requests.filter((r) => r.path.endsWith("/claim"))).toHaveLength(1);
});
test.each([
	[503, "provider_semantic_not_ready"],
	[409, "connection_not_ready"],
] as const)(
	"claim %s %s refetches and reclaims while inference remains single",
	async (status, code) => {
		const f = visualFetcher({
			claim: (n) =>
				n === 1
					? Response.json({ error: { code } }, { status })
					: (undefined as unknown as Response),
		});
		await perceive(f);
		expect(f.requests.filter((r) => r.path.endsWith("/claim"))).toHaveLength(2);
		expect(
			f.requests.filter((r) => r.path === "/v1/vision/perceive"),
		).toHaveLength(1);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	},
);
test.each([409, 503])(
	"unrelated claim HTTP %i is never retried and releases",
	async (status) => {
		const f = visualFetcher({
			claim: () => Response.json({ error: { code: "unrelated" } }, { status }),
		});
		await expect(perceive(f)).rejects.toThrow(`larm_http_${status}`);
		expect(f.requests.filter((r) => r.path.endsWith("/claim"))).toHaveLength(1);
		expect(
			f.requests.filter((r) => r.path === "/v1/vision/perceive"),
		).toHaveLength(0);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	},
);
test.each(["failed", "released", "expired"])(
	"terminal %s ends a claim retry and still releases its own connection",
	async (status) => {
		let claimed = false;
		const f = visualFetcher({
			claim: () => {
				claimed = true;
				return Response.json(
					{ error: "provider_semantic_not_ready" },
					{ status: 503 },
				);
			},
			connection: (s) => (claimed ? { ...s, status } : s),
		});
		await expect(perceive(f)).rejects.toThrow("provider_not_ready");
		expect(f.requests.filter((r) => r.path.endsWith("/claim"))).toHaveLength(1);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	},
);
test("cancellation bounds repeated temporary claims, releases, and sends no inference", async () => {
	const f = visualFetcher({
		claim: () =>
			Response.json({ error: "provider_semantic_not_ready" }, { status: 503 }),
	});
	await expect(perceive(f, AbortSignal.timeout(20))).rejects.toThrow();
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	expect(
		f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(0);
});
test("cancel after claim before POST releases and a new acquisition does not wait for the previous observation", async () => {
	const abort = new AbortController();
	let unblock!: () => void;
	const gate = new Promise<void>((r) => {
		unblock = r;
	});
	const f = visualFetcher({
		snapshot: async () => {
			await gate;
			return Response.json({ online: false, runtimes: [] });
		},
	});
	await expect(
		perceive(f, abort.signal, async (phase) => {
			if (phase === "running") abort.abort();
		}),
	).rejects.toThrow();
	expect(
		f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(0);
	await perceive(f);
	expect(
		f.requests.filter((r) => r.path === "/v1/agent-connections"),
	).toHaveLength(2);
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
	unblock();
});
const releasedAt = new Date(Date.now() - 1000).toISOString();
async function observation(
	snapshot: unknown,
	overrides: {
		allocation?: unknown;
		connection?: unknown;
		fail?: boolean;
	} = {},
) {
	const paths: string[] = [];
	const v = await observeVisualStop(
		async (path, _s, init) => {
			paths.push(path);
			expect(init?.cache).toBe("no-store");
			if (path === "/state") {
				if (overrides.fail) throw new TypeError("unavailable");
				return Response.json(snapshot);
			}
			if (path.startsWith("/v1/allocations/"))
				return Response.json(
					overrides.allocation ?? {
						id: "allocation",
						bindings: [
							{ capability: "vision.perception", runtime: "bound-runtime" },
						],
					},
				);
			return Response.json(
				overrides.connection ?? {
					id: "owned",
					status: "released",
					allocationId: "allocation",
					releasedAt,
				},
			);
		},
		{ status: "observing", connectionId: "owned", checkedAt: Date.now() },
		{ timeoutMs: 10, pollMs: 1 },
	);
	expect(
		paths.some((p) => p.includes("inspection") || p.includes("lifecycle")),
	).toBe(false);
	return v;
}
test.each([
	{
		online: false,
		runtimes: [
			{
				id: "bound-runtime",
				status: "COLD",
				observedAt: new Date().toISOString(),
			},
		],
	},
	{ online: true, runtimes: [] },
	{
		online: true,
		runtimes: [
			{
				id: "different-runtime",
				status: "COLD",
				observedAt: new Date().toISOString(),
			},
		],
	},
	{
		online: true,
		runtimes: [
			{
				id: "bound-runtime",
				status: "WARM",
				observedAt: new Date().toISOString(),
			},
		],
	},
	{
		online: true,
		runtimes: [
			{
				id: "bound-runtime",
				status: "COLD",
				observedAt: new Date(Date.now() - 20000).toISOString(),
			},
		],
	},
	{
		online: true,
		runtimes: [
			{
				id: "bound-runtime",
				status: "COLD",
				observedAt: new Date(Date.now() + 60000).toISOString(),
			},
		],
	},
])(
	"offline, absent, active, stale or future snapshots stay unconfirmed %#",
	async (snapshot) => {
		expect((await observation(snapshot)).status).toBe("unconfirmed");
	},
);
test("COLD before release and old COLD after release cannot confirm stop", async () => {
	const old = new Date(Date.now() - 20000).toISOString();
	const snap = {
		online: true,
		runtimes: [{ id: "bound-runtime", status: "COLD", observedAt: old }],
	};
	expect((await observation(snap)).status).toBe("unconfirmed");
	expect(
		(
			await observation(snap, {
				connection: {
					id: "owned",
					allocationId: "allocation",
					status: "released",
					releasedAt: new Date(Date.now() - 30000).toISOString(),
				},
			})
		).status,
	).toBe("unconfirmed");
});
test("read failure, missing release timestamp and unknown binding explicitly stay unconfirmed", async () => {
	expect(await observation({}, { fail: true })).toMatchObject({
		status: "unconfirmed",
		reason: "observation_failed",
	});
	expect(
		await observation({}, { connection: { id: "owned", status: "released" } }),
	).toMatchObject({ status: "unconfirmed", reason: "release_unconfirmed" });
	expect(
		await observation({}, { allocation: { id: "allocation", bindings: [] } }),
	).toMatchObject({ status: "unconfirmed", reason: "runtime_unknown" });
});
test("an expired epoch is not reused: the next explicit operation gets a fresh connection", async () => {
	const f = visualFetcher();
	let expired = true;
	const fetcher = (async (url, init) => {
		if (new URL(String(url)).pathname.endsWith("/claim") && expired) {
			expired = false;
			return Response.json(
				{ error: "connection_epoch_expired" },
				{ status: 410 },
			);
		}
		return f.fetcher(url, init);
	}) as typeof fetch;
	const p = createVisualPerception({
		baseUrl: "http://127.0.0.1:9810",
		token: "control-secret",
		audience: "desktop",
		fetch: fetcher,
		pollMs: 1,
	});
	const image = await visualImage();
	await expect(
		p.perceive(
			image,
			{ task: "describe", query: "説明" },
			AbortSignal.timeout(1000),
			async () => {},
		),
	).rejects.toThrow("larm_http_410");
	await p.perceive(
		image,
		{ task: "describe", query: "説明" },
		AbortSignal.timeout(1000),
		async () => {},
	);
	const creates = f.requests.filter((r) => r.path === "/v1/agent-connections");
	expect(creates).toHaveLength(2);
	expect(creates[0]!.headers.get("Idempotency-Key")).not.toBe(
		creates[1]!.headers.get("Idempotency-Key"),
	);
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
});
