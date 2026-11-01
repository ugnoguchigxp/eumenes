import { expect } from "bun:test";
import type { LarmCallOptions } from "../contracts";
import { createAgentLarm } from "..";
import type { Fetcher } from "../service/profiles";

export const owner = (
	role: "main" | "subagent",
	conversationId = "conversation-a",
	agentId: string = role,
	branchId?: string,
): Pick<LarmCallOptions, "sessionRole" | "taskId" | "agentSession"> => ({
	sessionRole: role,
	...(role === "subagent" ? { taskId: agentId } : {}),
	agentSession: { conversationId, agentId, branchId },
});
export const messages = [
	{ role: "user" as const, content: "fixture conversation text" },
];
export function capacityFixture() {
	type Binding = {
		id: string;
		client: string;
		capacity: number;
		expiresAt: number;
		tokenVersion: number;
		released: boolean;
		epoch: string;
	};
	const bindings = new Map<string, Binding>();
	const creates: Array<{
		body: Record<string, unknown>;
		key: string | null;
		id: string;
	}> = [];
	const generations: Array<{
		id: string;
		body: Record<string, unknown>;
		authorization: string | null;
	}> = [];
	const claims: string[] = [];
	const controls = {
		hold: undefined as
			| ((id: string, signal: AbortSignal) => Promise<void>)
			| undefined,
		claimable: true,
		probeReady: false,
		healthCalls: 0,
		polls: 0,
		timeoutCreate: false,
		wrongCapacity: undefined as number | undefined,
		wrongClaimCapacity: undefined as number | undefined,
		credentialMs: 900000,
		generationError: false,
	};
	const provider = (capacity = 131072) => ({
		name: "llm",
		protocol: "openai.chat-completions.v1",
		endpoint: "/v1/chat/completions",
		model: "fixture-model",
		contextWindow: {
			maxTokens: capacity,
			outputReserveTokens: 4096,
			safetyMarginTokens: 1024,
		},
	});
	const state = (binding: Binding) => ({
		id: binding.id,
		profile: "fixture-profile",
		agentProfile: "fixture-agent-profile",
		bootEpoch: binding.epoch,
		status: binding.released ? "released" : "ready",
		expiresAt: new Date(binding.expiresAt).toISOString(),
		providers: [
			{
				...provider(binding.capacity),
				readiness: "ready",
				claimable: controls.claimable,
			},
		],
	});
	const request: Fetcher = async (input, init) => {
		const path = new URL(String(input)).pathname;
		const headers = new Headers(init?.headers);
		if (path !== "/v1/chat/completions")
			expect(headers.get("authorization")).toBe(
				"Bearer fixture-control-secret",
			);
		if (path === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "fixture-revision",
				requestedProfile: "fixture-profile",
				profiles: [
					{ id: "fixture-agent-profile", providers: [provider(200000)] },
				],
			});
		if (path === "/v1/agent-connections") {
			const body = JSON.parse(String(init?.body));
			let binding = [...bindings.values()].find(
				(b) => b.client === body.client && !b.released,
			);
			if (!binding) {
				const id = `server-issued-${bindings.size}`;
				binding = {
					id,
					client: body.client,
					capacity: controls.wrongCapacity ?? body.contextTokens ?? 131072,
					expiresAt: Date.now() + 900000,
					tokenVersion: 0,
					released: false,
					epoch: "epoch-a",
				};
				bindings.set(id, binding);
			}
			creates.push({
				body,
				key: headers.get("idempotency-key"),
				id: binding.id,
			});
			if (controls.timeoutCreate) {
				controls.timeoutCreate = false;
				throw new DOMException("timeout", "TimeoutError");
			}
			return Response.json(state(binding), { status: 201 });
		}
		if (path.startsWith("/v1/agent-connections/")) {
			const [, , , id, operation] = path.split("/");
			const binding = bindings.get(id!)!;
			if (init?.method === "DELETE") {
				binding.released = true;
				return new Response(null, { status: 204 });
			}
			if (operation === "renew") {
				binding.expiresAt = Date.now() + 900000;
				return Response.json(state(binding));
			}
			if (operation === "claim") {
				expect(headers.has("idempotency-key")).toBeFalse();
				expect(JSON.parse(String(init?.body)).format).toBe(
					"openai-provider-v1",
				);
				claims.push(binding.id);
				binding.tokenVersion++;
				return Response.json({
					...state(binding),
					providers: [
						{
							...provider(controls.wrongClaimCapacity ?? binding.capacity),
							baseUrl: "http://127.0.0.1:9810/v1",
							endpoint: "http://127.0.0.1:9810/v1/chat/completions",
							credential: {
								token: `fixture-provider-secret:${binding.id}:${binding.tokenVersion}`,
								expiresAt: new Date(
									Date.now() + controls.credentialMs,
								).toISOString(),
							},
							configuration: {
								fields: {
									baseURL: "http://127.0.0.1:9810/v1",
									model: "fixture-model",
								},
							},
						},
					],
				});
			}
			if (operation === "providers" && path.endsWith("/health")) {
				controls.healthCalls++;
				if (controls.probeReady) controls.claimable = true;
				return Response.json(
					{
						name: "llm",
						ready: controls.claimable,
						acceptingRequests: controls.claimable,
					},
					{ status: controls.claimable ? 200 : 503 },
				);
			}
			controls.polls++;
			return Response.json(state(binding));
		}
		if (path === "/v1/chat/completions") {
			const authorization = headers.get("authorization");
			const binding = [...bindings.values()].find(
				(b) =>
					authorization ===
					`Bearer fixture-provider-secret:${b.id}:${b.tokenVersion}`,
			)!;
			expect(binding).toBeDefined();
			const body = JSON.parse(String(init?.body));
			generations.push({ id: binding.id, body, authorization });
			if (binding.released)
				return Response.json(
					{ error: { code: "connection_idle_released" } },
					{ status: 409 },
				);
			if (controls.generationError) throw new TypeError("network failure");
			await controls.hold?.(binding.id, init!.signal!);
			if (body.stream)
				return new Response(
					'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			return Response.json({
				choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
			});
		}
		throw new Error(`unexpected_fixture_route:${path}`);
	};
	const config = {
		baseUrl: "http://127.0.0.1:9810",
		profile: "fixture-profile",
		token: "fixture-control-secret",
		client: "fixture-installation",
		fetch: request,
	};
	return {
		bindings,
		creates,
		claims,
		generations,
		controls,
		config,
		port: () => createAgentLarm(config),
	};
}
