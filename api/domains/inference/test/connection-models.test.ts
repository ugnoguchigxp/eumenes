import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import type { Connection } from "../../settings/contracts";
import { registerInference } from "../controller";
import type { InferenceService } from "../service";
import { createConnectionModels } from "../service/connection-models";

const apiKeyId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const codexId = crypto.randomUUID();
const connection = (over: Partial<Connection>): Connection => ({
	id: crypto.randomUUID(),
	name: "c",
	baseUrl: "https://gateway.example/v1",
	enabled: true,
	epoch: 0,
	envRef: null,
	...over,
});
const connections: Connection[] = [
	connection({ id: apiKeyId, kind: "claude-agent-sdk", auth: "api-key" }),
	connection({
		id: subscriptionId,
		kind: "claude-agent-sdk",
		auth: "subscription",
		baseUrl: "https://api.anthropic.com",
	}),
	connection({ id: codexId, kind: "codex-sdk" }),
];
const settingsWith = (credential: string | null = "secret") => ({
	get: () => ({ connections }) as never,
	credential: () => credential,
});

const modelRow = (id: string, max: number | null) => ({
	type: "model",
	id,
	display_name: `Name ${id}`,
	created_at: "2026-01-01T00:00:00Z",
	max_input_tokens: max,
	max_tokens: 1000,
});
/** Two pages of models; records every request. */
function fakeModelsFetch() {
	const requests: Array<{ url: URL; headers: Headers }> = [];
	const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push({ url, headers: new Headers(init?.headers) });
		const second = url.searchParams.get("after_id") === "model-b";
		return Response.json(
			second
				? {
						data: [modelRow("model-c", null)],
						has_more: false,
						first_id: "model-c",
						last_id: "model-c",
					}
				: {
						data: [
							modelRow("model-a", 200_000),
							modelRow("model-b", 1_000_000),
						],
						has_more: true,
						first_id: "model-a",
						last_id: "model-b",
					},
		);
	}) as unknown as typeof fetch;
	return { send, requests };
}

test("an api-key connection lists every page of the saved endpoint with only the key and protocol headers", async () => {
	const { send, requests } = fakeModelsFetch();
	const service = createConnectionModels(
		settingsWith(),
		{ ANTHROPIC_AUTH_TOKEN: "ambient", ANTHROPIC_CUSTOM_HEADERS: "x: y" },
		{ fetch: send },
	);
	const result = await service.list(apiKeyId, new AbortController().signal);
	expect(result).toEqual({
		models: [
			{ id: "model-a", displayName: "Name model-a", contextWindow: 200_000 },
			{
				id: "model-b",
				displayName: "Name model-b",
				contextWindow: 1_000_000,
			},
			{ id: "model-c", displayName: "Name model-c", contextWindow: null },
		],
		account: { auth: "api-key", subscriptionType: null },
	});
	expect(requests).toHaveLength(2);
	for (const { url, headers } of requests) {
		expect(url.origin + url.pathname).toBe("https://gateway.example/v1/models");
		expect(headers.get("x-api-key")).toBe("secret");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-custom-headers")).toBeNull();
	}
});

test("model lists are cached briefly and read again after the TTL or a new credential generation", async () => {
	const { send, requests } = fakeModelsFetch();
	let clock = 0;
	const service = createConnectionModels(
		settingsWith(),
		{},
		{ fetch: send, now: () => clock },
	);
	const signal = new AbortController().signal;
	await service.list(apiKeyId, signal);
	await service.list(apiKeyId, signal);
	expect(requests).toHaveLength(2);
	clock += 61_000;
	await service.list(apiKeyId, signal);
	expect(requests).toHaveLength(4);
	connections[0] = { ...connections[0]!, epoch: 1 };
	await service.list(apiKeyId, signal);
	expect(requests).toHaveLength(6);
	connections[0] = { ...connections[0]!, epoch: 0 };
});

test("unknown and non-Claude connections are not found", async () => {
	const service = createConnectionModels(settingsWith(), {});
	const signal = new AbortController().signal;
	expect(await service.list(crypto.randomUUID(), signal)).toBeNull();
	expect(await service.list(codexId, signal)).toBeNull();
});

test("a connection without a credential fails before any request", async () => {
	const { send, requests } = fakeModelsFetch();
	const service = createConnectionModels(
		settingsWith(null),
		{},
		{ fetch: send },
	);
	await expect(
		service.list(apiKeyId, new AbortController().signal),
	).rejects.toThrow("cloud_credential_unavailable");
	expect(requests).toHaveLength(0);
});

test("an endpoint failure surfaces as a code without the credential", async () => {
	const send = (async () =>
		new Response("denied secret", { status: 401 })) as unknown as typeof fetch;
	const service = createConnectionModels(settingsWith(), {}, { fetch: send });
	const error = await service
		.list(apiKeyId, new AbortController().signal)
		.catch((e: Error) => e);
	expect((error as Error).message).toBe("cloud_agent_http_401");
});

type FakeParams = Parameters<typeof query>[0];
function fakeClaude(account: AccountInfo) {
	const seen = {
		params: undefined as FakeParams | undefined,
		yielded: [] as unknown[],
		closed: false,
	};
	const claudeQuery = ((params: FakeParams) => {
		seen.params = params;
		void (async () => {
			for await (const message of params.prompt as AsyncIterable<unknown>)
				seen.yielded.push(message);
		})();
		return {
			accountInfo: async () => account,
			supportedModels: async () => [
				{ value: "alias-a", displayName: "Alias A", description: "" },
				{ value: "model-b", displayName: "", description: "" },
			],
			close: () => {
				seen.closed = true;
			},
		};
	}) as unknown as typeof query;
	return { claudeQuery, seen };
}
const subscriptionAccount: AccountInfo = {
	tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
	apiKeySource: "none",
	apiProvider: "firstParty",
	subscriptionType: "max",
};

test("a subscription connection reads models and account without sending a turn", async () => {
	const { claudeQuery, seen } = fakeClaude(subscriptionAccount);
	const service = createConnectionModels(
		settingsWith("oauth-secret"),
		{ ANTHROPIC_API_KEY: "ambient", CLAUDE_CONFIG_DIR: "/ambient" },
		{ claudeQuery },
	);
	const result = await service.list(
		subscriptionId,
		new AbortController().signal,
	);
	expect(result).toEqual({
		models: [
			{ id: "alias-a", displayName: "Alias A", contextWindow: null },
			{ id: "model-b", displayName: "model-b", contextWindow: null },
		],
		account: { auth: "subscription", subscriptionType: "max" },
	});
	await Bun.sleep(0);
	expect(seen.yielded).toEqual([]);
	expect(seen.closed).toBe(true);
	const env = seen.params!.options!.env!;
	expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
	expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	expect(env.CLAUDE_CONFIG_DIR).not.toBe("/ambient");
});

test("a subscription connection whose observed route is not the subscription is refused", async () => {
	const { claudeQuery, seen } = fakeClaude({
		apiKeySource: "none",
		apiProvider: "firstParty",
	});
	const service = createConnectionModels(settingsWith(), {}, { claudeQuery });
	await expect(
		service.list(subscriptionId, new AbortController().signal),
	).rejects.toThrow("cloud_agent_auth_mismatch");
	expect(seen.closed).toBe(true);
	expect(seen.yielded).toEqual([]);
});

test("the models route maps results and failures to HTTP", async () => {
	const { send } = fakeModelsFetch();
	const credentialless = createConnectionModels(
		settingsWith(null),
		{},
		{ fetch: send },
	);
	const working = createConnectionModels(settingsWith(), {}, { fetch: send });
	const mount = (models: typeof working) => {
		const app = new Hono();
		registerInference(app, {} as InferenceService, models);
		return app;
	};
	const ok = await mount(working).request(
		`/api/inference/connections/${apiKeyId}/models`,
	);
	expect(ok.status).toBe(200);
	expect(((await ok.json()) as { models: unknown[] }).models).toHaveLength(3);
	expect(
		(
			await mount(working).request(
				`/api/inference/connections/${codexId}/models`,
			)
		).status,
	).toBe(404);
	const missing = await mount(credentialless).request(
		`/api/inference/connections/${apiKeyId}/models`,
	);
	expect(missing.status).toBe(409);
	expect(await missing.json()).toEqual({
		error: "cloud_credential_unavailable",
	});
});

test("a model whose provider reports no context window gets the one the ledger learned for that connection, auth and model", async () => {
	const { send } = fakeModelsFetch();
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE inference_agent_sessions(id TEXT, connection_id TEXT, auth TEXT, model TEXT, learned_context_window INTEGER)",
	);
	const learn = (
		connectionId: string,
		auth: string,
		model: string,
		n: number,
	) =>
		db
			.query("INSERT INTO inference_agent_sessions VALUES(?,?,?,?,?)")
			.run(crypto.randomUUID(), connectionId, auth, model, n);
	learn(apiKeyId, "api-key", "model-c", 777_000);
	// Other connections and auths never leak in, and the provider's own value wins.
	learn(subscriptionId, "subscription", "model-c", 1);
	learn(apiKeyId, "api-key", "model-a", 5);
	const store = { read: (fn: (db: Database) => unknown) => fn(db) } as never;
	const service = createConnectionModels(
		settingsWith(),
		{},
		{ fetch: send, store },
	);
	const result = await service.list(apiKeyId, new AbortController().signal);
	expect(result!.models.map((m) => m.contextWindow)).toEqual([
		200_000, 1_000_000, 777_000,
	]);
});
