import { expect, spyOn, test } from "bun:test";
import { createLarm } from "..";
import { embeddingProvider } from "./embedding.fixture";

const endpoint = "/connection/allocated/embedding/v1/embed";
const unit = (index: number) =>
	Array.from({ length: 512 }, (_, i) => (i === index ? 1 : 0));

function fixture() {
	const events: string[] = [];
	let generation = 1;
	let expiresAt = Date.now() + 300_000;
	const expiry = () => new Date(expiresAt).toISOString();
	const ready = {
		id: "conn",
		profile: "embeddingCanary",
		agentProfile: "contextstill-embedding",
		catalogRevision: "catalog",
		status: "ready",
		providers: [{ ...embeddingProvider, readiness: "ready", claimable: true }],
	};
	const rejected: number[] = [];
	let corrupt: Record<string, unknown> = {};
	const port = createLarm({
		baseUrl: "http://127.0.0.1:8100",
		profile: "conversation",
		audience: "same-host",
		token: "control",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			const key = headers.get("idempotency-key");
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			if (url.pathname === endpoint) {
				events.push(`infer:${body.type}`);
				expect(headers.get("authorization")).toBe(
					`Bearer provider-${generation}`,
				);
				expect(body).toMatchObject({ priority: "normal", normalize: true });
				const failure = rejected.shift();
				if (failure)
					return Response.json(
						{ error: { code: "provider_busy" } },
						{ status: failure },
					);
				return Response.json({
					type: body.type,
					count: body.texts.length,
					dimension: 512,
					embeddings: body.texts.map((text: string) => unit(text.length % 512)),
					...corrupt,
				});
			}
			expect(headers.get("authorization")).toBe("Bearer control");
			switch (url.pathname) {
				case "/v3/agent-profiles":
					expect(url.searchParams.get("profile")).toBe("embeddingCanary");
					return Response.json({
						contractVersion: "agent-connection.v3",
						requestedProfile: "embeddingCanary",
						catalogRevision: "catalog",
						profiles: [
							{ id: "contextstill-embedding", providers: [embeddingProvider] },
						],
					});
				case "/v1/agent-connections":
					events.push("create");
					expect(key).toMatch(/^[\da-f-]{36}$/);
					expect(body).toMatchObject({
						providers: ["embedding"],
						expectedCatalogRevision: "catalog",
						ttlSeconds: 300,
						allowFallback: false,
						deploymentPolicy: "existing-only",
					});
					return Response.json(
						{
							...ready,
							expiresAt: expiry(),
							status: "probing",
							providers: [{ ...embeddingProvider, readiness: "probing" }],
						},
						{ status: 202 },
					);
				case "/v1/agent-connections/conn":
					events.push(method === "DELETE" ? "delete" : "status");
					return method === "DELETE"
						? new Response(null, { status: 204 })
						: Response.json({ ...ready, expiresAt: expiry() });
				case "/v1/agent-connections/conn/renew":
					events.push("renew");
					expect(key).toMatch(/^[\da-f-]{36}$/);
					expect(body).toEqual({ ttlSeconds: 300 });
					generation++;
					expiresAt = Date.now() + 300_000;
					return Response.json({ ...ready, expiresAt: expiry() });
				case "/v1/agent-connections/conn/claim":
					events.push("claim");
					expect(key).toBeNull();
					expect(body).toEqual({
						format: "larm-embedding-provider-v1",
						providers: ["embedding"],
					});
					return Response.json({
						...ready,
						expiresAt: expiry(),
						providers: [
							{ name: "unrelated" },
							{
								...embeddingProvider,
								endpoint,
								credential: {
									type: "bearer",
									token: `provider-${generation}`,
									expiresAt: expiry(),
								},
							},
						],
					});
				default:
					throw new Error("unexpected_fixture_request");
			}
		},
	});
	return {
		port,
		events,
		rejected,
		corrupt(values: Record<string, unknown>) {
			corrupt = values;
		},
	};
}

const signal = () => AbortSignal.timeout(5000);

test("embedding uses the named claim and renews its credential before reuse", async () => {
	const now = Date.now();
	const date = spyOn(Date, "now").mockReturnValue(now);
	const { port, events } = fixture();
	try {
		const result = await port.embed!(["日本語", "文書"], "passage", signal());
		expect(result.vectors).toEqual([unit(3), unit(2)]);
		expect(result.space.embeddingSpace).toEqual(
			embeddingProvider.embeddingSpace,
		);
		date.mockReturnValue(now + 130_000);
		expect((await port.embed!(["質問"], "query", signal())).vectors).toEqual([
			unit(2),
		]);
	} finally {
		await port.close();
		date.mockRestore();
	}
	expect(events.filter((event) => event !== "status")).toEqual([
		"create",
		"claim",
		"infer:passage",
		"renew",
		"claim",
		"infer:query",
		"delete",
	]);
});

test("embedding retries temporary refusal, reclaims on 401 and keeps other failures explicit", async () => {
	const { port, events, rejected, corrupt } = fixture();
	try {
		rejected.push(503, 401);
		await port.embed!(["質問"], "query", signal());
		expect(events.filter((e) => e === "claim")).toHaveLength(2);
		for (const error of [400, 409]) {
			rejected.push(error);
			const before = events.length;
			await expect(port.embed!(["質問"], "query", signal())).rejects.toThrow(
				`larm_inference_${error}`,
			);
			expect(
				events.slice(before).filter((e) => e === "infer:query"),
			).toHaveLength(1);
		}
		for (const bad of [
			{ count: 2 },
			{ type: "passage" },
			{ dimension: 384 },
			{ embeddings: [unit(-1)] },
		]) {
			corrupt(bad);
			await expect(port.embed!(["質問"], "query", signal())).rejects.toThrow(
				"invalid_embedding_result",
			);
		}
	} finally {
		await port.close();
	}
});
