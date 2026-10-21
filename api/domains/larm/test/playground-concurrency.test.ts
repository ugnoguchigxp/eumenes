import { expect, test } from "bun:test";
import { createLarmPlayground } from "..";

// Model LARM's client-based connection reuse and credential revocation on DELETE.
// Both claims finish before the first request ends; the second sends after its release.
for (const cancelFirst of [false, true]) {
	test(`parallel embeddings keep independent credentials when the first ${cancelFirst ? "is cancelled" : "finishes"}`, async () => {
		const byClient = new Map<string, string>();
		const released = new Set<string>();
		const calls: string[] = [];
		const bothSending = Promise.withResolvers<void>();
		const firstReleased = Promise.withResolvers<void>();
		const firstController = new AbortController();
		let sending = 0;
		const provider = {
			name: "embedding",
			model: "fixture-embedding",
			protocol: "larm.embedding.v1",
			capability: "embedding",
			endpoint: "/v1/embed",
		};
		const fetcher = async (
			input: RequestInfo | URL,
			init: RequestInit = {},
		) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v3/agent-profiles")
				return Response.json({
					contractVersion: "agent-connection.v3",
					requestedProfile: "fixture-selector",
					catalogRevision: "fixture-revision",
					profiles: [
						{
							id: "fixture-profile",
							providers: [
								{
									...provider,
									embeddingSpace: {
										model: {
											id: "fixture-embedding",
											revision: "1",
											artifactDigest: "fixture-digest",
										},
										dimension: 2,
										prefixes: { query: "query: ", passage: "passage: " },
									},
								},
							],
						},
					],
				});
			if (path === "/v1/agent-connections") {
				const body = JSON.parse(String(init.body));
				const id =
					byClient.get(body.client) ?? `connection-${byClient.size + 1}`;
				byClient.set(body.client, id);
				return Response.json(
					{
						id,
						status: "ready",
						agentProfile: "fixture-profile",
						catalogRevision: "fixture-revision",
						providers: [{ ...provider, readiness: "ready", claimable: true }],
					},
					{ status: 201 },
				);
			}
			if (init.method === "DELETE") {
				const id = path.split("/").at(-1)!;
				released.add(id);
				calls.push(`release:${id}`);
				firstReleased.resolve();
				return new Response(null, { status: 204 });
			}
			if (path.endsWith("/claim")) {
				const id = path.split("/").at(-2)!;
				const expiresAt = new Date(Date.now() + 300_000).toISOString();
				return Response.json({
					id,
					status: "ready",
					expiresAt,
					providers: [
						{
							...provider,
							endpoint: "http://127.0.0.1:9999/v1/embed",
							baseUrl: "http://127.0.0.1:9999/v1",
							configuration: {
								fields: {
									baseURL: "http://127.0.0.1:9999/v1",
									model: provider.model,
								},
							},
							credential: { type: "bearer", token: id, expiresAt },
						},
					],
				});
			}
			if (path === "/v1/embed") {
				const id = new Headers(init.headers).get("Authorization")!.slice(7);
				if (++sending === 1) {
					await bothSending.promise;
					if (cancelFirst) firstController.abort();
					init.signal?.throwIfAborted();
				} else {
					bothSending.resolve();
					await firstReleased.promise;
				}
				calls.push(`embed:${id}`);
				return released.has(id)
					? new Response(null, { status: 401 })
					: Response.json({ dimension: 2, embeddings: [[1, 0]] });
			}
			throw new Error("unexpected_fixture_request");
		};
		const gateway = createLarmPlayground({
			baseUrl: "http://127.0.0.1:9999",
			token: "fixture-control-token",
			profile: "fixture-selector",
			audience: "same-host",
			fetch: fetcher as typeof fetch,
		});
		const results = await Promise.allSettled([
			gateway.embed(
				["current request"],
				"query",
				AbortSignal.any([firstController.signal, AbortSignal.timeout(2000)]),
			),
			gateway.embed(["previous request"], "query", AbortSignal.timeout(2000)),
		]);
		expect(results[0]!.status).toBe(cancelFirst ? "rejected" : "fulfilled");
		expect(results[1]).toMatchObject({
			status: "fulfilled",
			value: { vectors: [[1, 0]] },
		});
		expect(byClient.size).toBe(2);
		expect(released.size).toBe(2);
		expect(calls.indexOf("release:connection-1")).toBeLessThan(
			calls.indexOf("embed:connection-2"),
		);
	});
}
