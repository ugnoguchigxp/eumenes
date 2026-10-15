import { workersModels } from "./workers-ai-models";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SettingsService } from "../../settings";
import type { AgentAuth, Connection } from "../../settings/contracts";
import {
	anthropicBase,
	anthropicFetch,
	claudeAgentEnv,
	safeAgentError,
	startGatedQuery,
	withClaudeDirs,
} from "../adapters/cloud-agents";
import type { ConnectionModels } from "../contracts";
import { learnedContextWindows } from "./agent-session";

export type ConnectionModelsService = {
	/** Runtime models of a saved agent or Workers AI connection; null for an unsupported connection. */
	list(
		connectionId: string,
		signal: AbortSignal,
		refresh?: boolean,
	): Promise<ConnectionModels | null>;
};

const ttlMs = 60_000;
const maxModels = 500;
const maxEntries = 32;

async function apiKeyModels(
	connection: Connection,
	credential: string,
	send: typeof fetch,
	signal: AbortSignal,
): Promise<ConnectionModels> {
	const client = new Anthropic({
		apiKey: credential,
		authToken: null,
		baseURL: anthropicBase(connection.baseUrl),
		fetch: anthropicFetch(send),
		maxRetries: 1,
	});
	const models: ConnectionModels["models"] = [];
	// The page iterator follows `has_more`; the cap bounds a misbehaving endpoint.
	for await (const model of client.models.list({ limit: 100 }, { signal })) {
		models.push({
			id: model.id,
			displayName: model.display_name || model.id,
			contextWindow:
				Number.isSafeInteger(model.max_input_tokens) &&
				model.max_input_tokens! > 0
					? model.max_input_tokens
					: null,
		});
		if (models.length >= maxModels) break;
	}
	return {
		models,
		account: { auth: "api-key", subscriptionType: null },
	};
}

async function subscriptionModels(
	environment: Readonly<Record<string, string | undefined>>,
	connection: Connection,
	credential: string,
	startQuery: typeof query,
	signal: AbortSignal,
): Promise<ConnectionModels> {
	const abortController = new AbortController();
	const onAbort = () => abortController.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await withClaudeDirs(async ({ cwd, configDir }) => {
			// No prompt is ever sent: the query only reports its account and model list, then closes.
			const gated = await startGatedQuery(
				startQuery,
				"subscription",
				null,
				{
					abortController,
					cwd,
					env: claudeAgentEnv(environment, {
						auth: "subscription",
						credential,
						baseUrl: connection.baseUrl,
						configDir,
					}),
					tools: [],
					mcpServers: {},
					strictMcpConfig: true,
					settingSources: [],
					persistSession: false,
					permissionMode: "dontAsk",
				},
				connection.id,
			);
			try {
				const models = await gated.q.supportedModels();
				return {
					models: models.map((m) => ({
						id: m.value,
						displayName: m.displayName || m.value,
						contextWindow: null,
					})),
					account: {
						auth: "subscription" as const,
						subscriptionType: gated.account.subscriptionType ?? null,
					},
				};
			} finally {
				gated.close();
			}
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Model lists of saved Claude Agent SDK and Workers AI connections, read at run time. Doubles as the connection
 * test: an unreachable endpoint, a rejected credential or a route mismatch fails the call.
 * Results are cached for a short time per connection, credential generation, route and endpoint. With the ledger
 * (`store`), a model whose provider reports no context window gets the one a past call learned.
 */
export function createConnectionModels(
	settings: Pick<SettingsService, "get" | "credential">,
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		fetch?: typeof fetch;
		claudeQuery?: typeof query;
		now?: () => number;
		store?: SqliteStore;
	} = {},
): ConnectionModelsService {
	const listed = createListing(settings, environment, options);
	return {
		async list(connectionId, signal, refresh) {
			const value = await listed.list(connectionId, signal, refresh);
			const auth = settings
				.get()
				.connections.find((c) => c.id === connectionId)?.auth;
			if (!value || !options.store || !auth) return value;
			const learned = learnedContextWindows(options.store, connectionId, auth);
			return {
				...value,
				models: value.models.map((model) => ({
					...model,
					contextWindow: model.contextWindow ?? learned.get(model.id) ?? null,
				})),
			};
		},
	};
}

function createListing(
	settings: Pick<SettingsService, "get" | "credential">,
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		fetch?: typeof fetch;
		claudeQuery?: typeof query;
		now?: () => number;
	},
): ConnectionModelsService {
	const now = options.now ?? Date.now;
	const cache = new Map<string, { at: number; value: ConnectionModels }>();
	return {
		async list(connectionId, signal, refresh = false) {
			const connection = settings
				.get()
				.connections.find((c) => c.id === connectionId);
			if (
				!connection ||
				!connection.enabled ||
				(connection.kind !== "cloudflare-workers-ai" &&
					(connection.kind !== "claude-agent-sdk" || !connection.auth))
			)
				return null;
			const auth: AgentAuth = connection.auth ?? "api-key";
			const credential = settings.credential(connection);
			if (!credential) throw new Error("cloud_credential_unavailable");
			const key = JSON.stringify([
				connection.id,
				connection.epoch,
				auth,
				connection.baseUrl,
				connection.accountId,
				connection.kind,
			]);
			const hit = cache.get(key);
			if (!refresh && hit && now() - hit.at < ttlMs) {
				signal.throwIfAborted();
				return hit.value;
			}
			const assertCurrent = () => {
				signal.throwIfAborted();
				const current = settings
					.get()
					.connections.find((c) => c.id === connection.id);
				if (
					!current ||
					!current.enabled ||
					current.epoch !== connection.epoch ||
					current.kind !== connection.kind ||
					current.accountId !== connection.accountId ||
					current.baseUrl !== connection.baseUrl
				)
					throw new Error("stale_connection_settings");
			};
			if (connection.kind === "cloudflare-workers-ai") {
				const value = await workersModels(
					connection,
					credential,
					options.fetch ?? fetch,
					signal,
				);
				assertCurrent();
				for (const [k, entry] of cache)
					if (now() - entry.at >= ttlMs) cache.delete(k);
				if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
				cache.set(key, { at: now(), value });
				return value;
			}
			let value: ConnectionModels;
			try {
				value =
					auth === "api-key"
						? await apiKeyModels(
								connection,
								credential,
								options.fetch ?? fetch,
								signal,
							)
						: await subscriptionModels(
								environment,
								connection,
								credential,
								options.claudeQuery ?? query,
								signal,
							);
			} catch (error) {
				signal.throwIfAborted();
				throw safeAgentError(error);
			}
			assertCurrent();
			for (const [k, entry] of cache)
				if (now() - entry.at >= ttlMs) cache.delete(k);
			if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
			cache.set(key, { at: now(), value });
			return value;
		},
	};
}
