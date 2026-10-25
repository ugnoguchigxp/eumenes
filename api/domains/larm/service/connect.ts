import { getLogger } from "../../../infrastructure/logger";
import { providerChatInput } from "./chat-input";
import type { Capability } from "../contracts";
import {
	englishSpeechProvider,
	claimedSpeechProvider,
} from "./speech-providers";
import { providerEndpoint, readJson, record, string } from "./guards";
import {
	endpoints,
	protocols,
	type Provider,
	type ProviderName,
} from "./profiles";

/** A control-plane request already bound to the caller's abort signal. */
export type Control = (
	path: string,
	init: RequestInit,
	accepted: number[],
) => Promise<Response>;
type Rec = Record<string, unknown>;
/** Hosts that may receive provider credentials: the LARM base host plus explicit extras. */
export type ProviderHosts = { base: URL; extra: readonly string[] };
export type ProfileRequest = {
	profile: string;
	client: string;
	audience: string;
	fullProfile: boolean;
	catalogRevision: string;
};

const terminalStatuses = ["expired", "released"];
const providersOf = (value: Rec): Rec[] =>
	Array.isArray(value.providers) ? value.providers.map(record) : [];

/** Stage 1: read the agent-profile catalog and check it matches the contract we speak. */
export async function fetchCatalog(
	control: Control,
	profile: string,
	required: Capability[],
) {
	const catalog = record(
		await readJson(
			await control(
				`/v3/agent-profiles?profile=${encodeURIComponent(profile)}`,
				{ method: "GET" },
				[200],
			),
		),
	);
	if (
		catalog.contractVersion !== "agent-connection.v3" ||
		catalog.requestedProfile !== profile ||
		!Array.isArray(catalog.profiles) ||
		catalog.profiles.length !== 1
	)
		throw new Error("larm_catalog_invalid");
	const catalogRevision = string(catalog.catalogRevision);
	const catalogProfile = record(catalog.profiles[0]);
	const catalogProviders = providersOf(catalogProfile);
	for (const p of catalogProviders) if (p.name === "llm") providerChatInput(p);
	for (const name of required) {
		const provider = catalogProviders.find((item) => item.name === name);
		if (
			!provider ||
			provider.protocol !== protocols[name] ||
			provider.endpoint !== endpoints[name] ||
			!provider.model
		)
			throw new Error("larm_catalog_provider_missing");
	}
	return { catalogRevision, catalogProfile, catalogProviders };
}

/** Stage 2: create the connection and return its (possibly not yet ready) record. */
export async function createConnection(
	control: Control,
	input: ProfileRequest & {
		/** Reused for every creation attempt of one connect() so a retry cannot duplicate the connection. */
		idempotencyKey: string;
	},
): Promise<{ id: string; created: Rec }> {
	const response = await control(
		"/v1/agent-connections",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": input.idempotencyKey,
				Prefer: "wait=1",
			},
			body: JSON.stringify({
				profile: input.profile,
				client: input.client,
				audience: input.audience,
				ttlSeconds: 900,
				allowFallback: false,
				deploymentPolicy: "existing-only",
				...(input.fullProfile ? {} : { providers: ["llm"] }),
				expectedCatalogRevision: input.catalogRevision,
			}),
		},
		[201, 202],
	);
	const created = record(await readJson(response));
	const id = string(created.id);
	if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
		throw new Error("larm_invalid_connection_id");
	return { id, created };
}

/** Wait only for the selected Providers, including when another Provider failed. */
export async function awaitReady(
	control: Control,
	pause: (ms: number) => Promise<void>,
	input: {
		id: string;
		created: Rec;
		required: string[];
		profile: string;
		agentProfile: unknown;
		startedAt?: number;
		kind?: ProviderName;
	},
): Promise<Rec> {
	let { created } = input;
	const { id, required } = input;
	let previous = "";
	const check = () => {
		if (terminalStatuses.includes(String(created.status)))
			throw new Error(`larm_connection_${created.status}`);
		if (
			created.id !== id ||
			created.profile !== input.profile ||
			created.agentProfile !== input.agentProfile ||
			!Array.isArray(created.providers)
		)
			throw new Error("larm_invalid_connection");

		const status = ["pending", "probing", "ready", "failed"].includes(
			String(created.status),
		)
			? String(created.status)
			: "unknown";
		const states = required.map((name) => {
			const p = providersOf(created).find((p) => p.name === name);
			return [
				"pending",
				"probing",
				"warming",
				"ready",
				"failed",
				"expired",
				"released",
			].includes(String(p?.readiness))
				? String(p?.readiness)
				: "unknown";
		});
		const signature = `${status}:${states.join(",")}`;
		if (signature !== previous && input.startedAt !== undefined) {
			for (let i = 0; i < required.length; i++)
				getLogger("larm").info("larm.provider_readiness", {
					connectionId: id,
					kind: input.kind ?? required[i],
					status,
					next: states[i],
					durationMs: Math.round(performance.now() - input.startedAt),
				});
			previous = signature;
		}
		return required.every((name) => {
			const p = providersOf(created).find((p) => p.name === name);
			if (!p) throw new Error("larm_catalog_provider_missing");
			if (["failed", "expired", "released"].includes(String(p.readiness)))
				throw new Error("larm_provider_failed");
			if (
				p.readiness === "ready" &&
				name in protocols &&
				(p.protocol !== protocols[name as ProviderName] ||
					p.endpoint !== endpoints[name as ProviderName])
			)
				throw new Error("larm_provider_not_ready");
			return p.readiness === "ready";
		});
	};
	while (!check()) {
		await pause(100);
		created = record(
			await readJson(
				await control(`/v1/agent-connections/${id}`, { method: "GET" }, [200]),
			),
		);
	}
	return created;
}

/** Stage 4: claim credentials and turn them into validated provider records. */
export async function claimProviders(
	control: Control,
	input: {
		id: string;
		created: Rec;
		required: Capability[];
		catalogProviders: Rec[];
		fullProfile: boolean;
		claimNames?: string[];
		hosts: ProviderHosts;
	},
): Promise<{ expiresAt: number; providers: Map<ProviderName, Provider> }> {
	const { id, created, required, catalogProviders, hosts } = input;
	const claimed = record(
		await readJson(
			await control(
				`/v1/agent-connections/${id}/claim`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						format: "openai-provider-v1",
						providers: input.claimNames ?? required,
					}),
				},
				[200],
			),
		),
	);
	if (
		claimed.id !== id ||
		terminalStatuses.includes(String(claimed.status)) ||
		!Array.isArray(claimed.providers)
	)
		throw new Error("larm_invalid_claim");
	const expiresAt = Date.parse(string(claimed.expiresAt));
	if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000)
		throw new Error("larm_expired");
	const providers = new Map<ProviderName, Provider>();
	for (const name of required) {
		const info = providersOf(claimed).find((p) => p.name === name);
		const announced = providersOf(created).find((p) => p.name === name);
		const declared = catalogProviders.find((p) => p.name === name);
		if (
			!info ||
			!declared ||
			info.protocol !== protocols[name] ||
			info.model !== announced?.model ||
			info.model !== declared?.model
		)
			throw new Error("larm_claim_mismatch");
		if (
			name === "llm" &&
			Object.entries(record(declared.contextWindow)).some(
				([key, value]) => record(info.contextWindow)[key] !== value,
			)
		)
			throw new Error("larm_claim_context_mismatch");
		if (
			name === "llm" &&
			JSON.stringify(providerChatInput(info)) !==
				JSON.stringify(providerChatInput(declared))
		)
			throw new Error("chat_input_contract_unavailable");
		providers.set(name, speechProvider(name, info, hosts));
	}
	const decision = decisionProvider(claimed, created, catalogProviders, hosts);
	if (input.fullProfile && decision) providers.set("system-one", decision);
	const english = input.fullProfile
		? englishSpeechProvider(claimed, created, catalogProviders, hosts)
		: undefined;
	if (english) providers.set("tts-english", english);
	return { expiresAt, providers };
}

function speechProvider(
	name: Capability,
	info: Rec,
	hosts: ProviderHosts,
): Provider {
	const credential = record(info.credential);
	const configuration = record(record(info.configuration).fields);
	const baseUrl = string(configuration.baseURL);
	providerEndpoint(baseUrl, hosts.base, hosts.extra);
	const endpoint = claimedEndpoint(info, baseUrl, name, hosts);
	if (configuration.baseURL !== baseUrl || configuration.model !== info.model)
		throw new Error("larm_claim_configuration_mismatch");
	const contextWindow = name === "llm" ? record(info.contextWindow) : undefined;
	if (
		contextWindow &&
		!["maxTokens", "outputReserveTokens", "safetyMarginTokens"].every(
			(key) =>
				Number.isInteger(contextWindow[key]) && Number(contextWindow[key]) > 0,
		)
	)
		throw new Error("larm_invalid_context_window");
	return {
		name,
		baseUrl,
		endpoint,
		...(name === "llm"
			? {
					chatInput: providerChatInput(info),
					vision:
						Array.isArray(info.supportedCapabilities) &&
						info.supportedCapabilities.includes("llm.vision"),
				}
			: {}),
		model: string(info.model),
		protocol: string(info.protocol),
		token: string(credential.token),
		contextWindow: contextWindow as Provider["contextWindow"],
		voice:
			typeof configuration.voice === "string" ? configuration.voice : undefined,
	};
}

function claimedEndpoint(
	info: Rec,
	baseUrl: string,
	name: ProviderName,
	hosts: ProviderHosts,
) {
	if (info.endpoint === undefined) return undefined;
	const endpoint = providerEndpoint(
		string(info.endpoint),
		hosts.base,
		hosts.extra,
	);
	const expected = new URL(
		endpoints[name].replace(/^\/v1\//, ""),
		`${baseUrl.replace(/\/$/, "")}/`,
	);
	if (endpoint.href !== expected.href)
		throw new Error("larm_claim_endpoint_mismatch");
	return endpoint.href;
}

/** Optional decisions never make the speech providers unusable. */
function decisionProvider(
	claimed: Rec,
	created: Rec,
	catalogProviders: Rec[],
	hosts: ProviderHosts,
): Provider | undefined {
	const declared = catalogProviders.find((p) => p.name === "system-one");
	if (
		declared?.capability !== "decision.system-one" ||
		declared.protocol !== protocols["system-one"] ||
		declared.endpoint !== endpoints["system-one"]
	)
		return undefined;
	try {
		const announced = providersOf(created).find((p) => p.name === "system-one");
		const info = providersOf(claimed).find((p) => p.name === "system-one");
		if (
			announced?.readiness === "ready" &&
			info?.protocol === protocols["system-one"] &&
			info.model === declared.model &&
			info.model === announced.model
		) {
			const fields = record(record(info.configuration).fields);
			const baseUrl = string(fields.daemonURL);
			providerEndpoint(baseUrl, hosts.base, hosts.extra);
			if (baseUrl === info.baseUrl && fields.model === info.model)
				return {
					name: "system-one",
					baseUrl,
					endpoint: claimedEndpoint(info, baseUrl, "system-one", hosts),
					model: string(info.model),
					protocol: string(info.protocol),
					token: string(record(info.credential).token),
				};
		}
	} catch {
		/* Malformed optional provider falls back to normal speech. */
	}
	return undefined;
}

/** Renews a lease and re-claims credentials, checking nothing about the contract changed. */
export async function renewProviders(
	control: Control,
	current: { id: string; providers: Map<ProviderName, Provider> },
	hosts: ProviderHosts,
): Promise<{ expiresAt: number; providers: Map<ProviderName, Provider> }> {
	const renewed = record(
		await readJson(
			await control(
				`/v1/agent-connections/${current.id}/renew`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": crypto.randomUUID(),
					},
					body: JSON.stringify({ ttlSeconds: 900 }),
				},
				[200, 201],
			),
		),
	);
	if (
		renewed.id !== current.id ||
		terminalStatuses.includes(String(renewed.status))
	)
		throw new Error("larm_renew_invalid");
	const claimed = record(
		await readJson(
			await control(
				`/v1/agent-connections/${current.id}/claim`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						format: "openai-provider-v1",
						providers: [...current.providers.values()].map(
							(p) => p.claimName ?? p.name,
						),
					}),
				},
				[200],
			),
		),
	);
	if (
		claimed.id !== current.id ||
		terminalStatuses.includes(String(claimed.status)) ||
		!Array.isArray(claimed.providers)
	)
		throw new Error("larm_invalid_claim");
	const nextExpiry = Date.parse(string(claimed.expiresAt));
	if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now() + 180_000)
		throw new Error("larm_renew_expired");
	const next = new Map<ProviderName, Provider>();
	for (const [name, previous] of current.providers) {
		const info = claimed.providers
			.map(record)
			.find((p) => p.name === (previous.claimName ?? name));
		if (name === "tts-english") {
			if (
				!info ||
				info.model !== previous.model ||
				info.protocol !== previous.protocol
			)
				continue;
			try {
				next.set(name, claimedSpeechProvider(name, info, hosts));
			} catch {
				/* Invalid optional bindings discard old tokens; selecting them fails. */
			}
			continue;
		}
		if (name === "system-one") {
			try {
				if (
					info?.model === previous.model &&
					info.protocol === previous.protocol
				) {
					const fields = record(record(info.configuration).fields);
					const baseUrl = string(fields.daemonURL);
					providerEndpoint(baseUrl, hosts.base, hosts.extra);
					if (baseUrl === info.baseUrl && fields.model === previous.model)
						next.set(name, {
							...previous,
							baseUrl,
							endpoint: claimedEndpoint(info, baseUrl, name, hosts),
							token: string(record(info.credential).token),
						});
				}
			} catch {
				/* Optional decisions can disappear without ending speech. */
			}
			continue;
		}
		if (
			!info ||
			info.model !== previous.model ||
			info.protocol !== previous.protocol
		)
			throw new Error("larm_renew_claim_mismatch");
		const fields = record(record(info.configuration).fields);
		const baseUrl = string(fields.baseURL);
		providerEndpoint(baseUrl, hosts.base, hosts.extra);
		if (baseUrl !== info.baseUrl || fields.model !== previous.model)
			throw new Error("larm_renew_claim_mismatch");
		const contextWindow =
			name === "llm" ? record(info.contextWindow) : undefined;
		if (
			name === "llm" &&
			Object.entries(previous.contextWindow ?? {}).some(
				([key, value]) => contextWindow?.[key] !== value,
			)
		)
			throw new Error("larm_renew_context_changed");
		next.set(name, {
			...previous,
			...(name === "llm"
				? {
						chatInput: providerChatInput(info),
						vision:
							Array.isArray(info.supportedCapabilities) &&
							info.supportedCapabilities.includes("llm.vision"),
					}
				: {}),
			baseUrl,
			endpoint: claimedEndpoint(info, baseUrl, name, hosts),
			token: string(record(info.credential).token),
		});
	}
	return { providers: next, expiresAt: nextExpiry };
}
