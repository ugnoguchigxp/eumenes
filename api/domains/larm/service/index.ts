import { readChatResponse } from "../../../infrastructure/chat-stream";
import type {
	Capability,
	LarmPort,
	LarmStatus,
	LarmCallOptions,
} from "../contracts";
import { LarmInferenceError, providerError } from "./inference-error";
import { ttsVoicesSchema } from "../contracts";
import type { TtsVoices } from "../contracts";

type ProviderName = Capability | "system-one";
type Provider = {
	name: ProviderName;
	baseUrl: string;
	model: string;
	protocol: string;
	token: string;
	contextWindow?: {
		maxTokens: number;
		outputReserveTokens: number;
		safetyMarginTokens: number;
	};
	voice?: string;
};
type Lease = {
	id: string;
	expiresAt: number;
	providers: Map<ProviderName, Provider>;
	agentProfile: string;
	useCount: number;
	closing: boolean;
	renewTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	idleAt: number;
};
const gemmaProfile = "SAAA-gemma4-26b";
const auxiliaryProfile = "SAAA-gemma4-26b-64k";
const gemmaAgentProfile = "saaa-conversation-gemma4-26b-voice";
const gemmaContext = {
	maxTokens: 262144,
	outputReserveTokens: 4096,
	safetyMarginTokens: 1976,
};
const protocols: Record<ProviderName, string> = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
	"system-one": "larm.system-one.v1",
};
const endpoints: Record<ProviderName, string> = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	"system-one": "/v1/systemone",
};
const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
async function untilAborted<T>(
	task: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
async function readBounded(
	response: Response,
	limit: number,
): Promise<Uint8Array> {
	if (!response.body) throw new Error("larm_empty_response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("larm_response_too_large");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
async function readJson(response: Response): Promise<unknown> {
	const bytes = await readBounded(response, 1_000_000);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("larm_invalid_json");
	}
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("larm_invalid_contract");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096)
		throw new Error("larm_invalid_contract");
	return value;
}
function localEndpoint(value: string): URL {
	const url = new URL(value);
	if (
		!(
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(url.hostname === "localhost" ||
				url.hostname.endsWith(".local") ||
				(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) &&
					url.hostname.split(".").every((part) => Number(part) <= 255) &&
					/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
						url.hostname,
					)))
		)
	)
		throw new Error("larm_nonlocal_endpoint");
	return url;
}
type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
export function createLarm(config: {
	baseUrl?: string;
	token?: string;
	profile?: string;
	audience?: string;
	client?: string;
	voice?: string;
	fetch?: Fetcher;
	speed?: number;
	style?: string;
	pitchScale?: number;
	intonationScale?: number;
	/** Internal timing seam; production follows LARM's 300-second foreground idle policy. */
	idleTimeoutMs?: number;
}): LarmPort {
	const base = localEndpoint(
		config.baseUrl?.trim() || "http://192.168.0.130:9810",
	);
	const token = config.token?.trim();
	const request = config.fetch ?? fetch;
	const profile = config.profile?.trim() || gemmaProfile;
	if (profile === auxiliaryProfile) throw new Error("larm_aux_not_enabled");
	const audience = config.audience?.trim() || "saaa-desktop";
	const client = config.client ?? "gemma-client";
	if (audience !== "saaa-desktop" && audience !== "same-host")
		throw new Error("larm_invalid_audience");
	if (
		audience === "same-host" &&
		base &&
		!["127.0.0.1", "localhost"].includes(base.hostname)
	)
		throw new Error("larm_same_host_requires_loopback");
	const voice = config.voice?.trim() || undefined;
	const speed = config.speed ?? 1;
	if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
		throw new Error("larm_tts_speed_invalid");
	if (
		config.pitchScale !== undefined &&
		(!Number.isFinite(config.pitchScale) ||
			config.pitchScale < -0.15 ||
			config.pitchScale > 0.15)
	)
		throw new Error("larm_tts_pitch_invalid");
	if (
		config.intonationScale !== undefined &&
		(!Number.isFinite(config.intonationScale) ||
			config.intonationScale < 0 ||
			config.intonationScale > 2)
	)
		throw new Error("larm_tts_intonation_invalid");
	const idleTimeoutMs = config.idleTimeoutMs ?? 300_000;
	const lifetime = new AbortController();
	const voiceCatalogs = new WeakMap<Provider, TtsVoices>();
	let lease: Lease | undefined;
	let connecting: Promise<Lease> | undefined;
	let lastError: string | undefined;
	let closed = false;
	let judging = false;
	const listeners = new Set<() => void>();
	function status(): LarmStatus {
		return {
			state: !token
				? "unconfigured"
				: connecting
					? "connecting"
					: lastError
						? "failed"
						: lease
							? "ready"
							: "idle",
			capabilities: lease
				? [...lease.providers.keys()].filter(
						(name): name is Capability => name !== "system-one",
					)
				: [],
			...(lastError ? { error: lastError } : {}),
		};
	}
	let previousStatus = JSON.stringify(status());
	function notify() {
		const next = JSON.stringify(status());
		if (previousStatus === next) return;
		previousStatus = next;
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				/* Independent subscribers. */
			}
		}
	}
	async function control(
		path: string,
		init: RequestInit,
		accepted: number[],
	): Promise<Response> {
		if (!base || !token) throw new Error("larm_unconfigured");
		const url = new URL(path, base);
		if (url.origin !== base.origin)
			throw new Error("larm_control_origin_mismatch");
		const response = await request(url, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...init.headers },
			redirect: "error",
			signal:
				init.method === "DELETE"
					? AbortSignal.timeout(15_000)
					: AbortSignal.any([
							lifetime.signal,
							AbortSignal.timeout(init.signal ? 3_000 : 15_000),
							...(init.signal ? [init.signal] : []),
						]),
		});
		if (!accepted.includes(response.status))
			throw new Error(`larm_control_${response.status}`);
		return response;
	}
	async function release(current: Lease) {
		current.closing = true;
		if (current.renewTimer) clearTimeout(current.renewTimer);
		clearTimeout(current.idleTimer);
		if (current.useCount > 0) return;
		if (lease === current) lease = undefined;
		notify();
		try {
			await control(
				`/v1/agent-connections/${encodeURIComponent(current.id)}`,
				{ method: "DELETE" },
				[204, 200, 404, 410],
			);
		} catch {
			if (!lease) {
				lastError = "larm_release_unconfirmed";
				notify();
			}
		}
	}
	function discard(current: Lease, error?: string) {
		current.closing = true;
		clearTimeout(current.renewTimer);
		clearTimeout(current.idleTimer);
		if (lease === current) {
			lease = undefined;
			lastError = error;
			notify();
		}
	}
	function scheduleIdle(current: Lease) {
		clearTimeout(current.idleTimer);
		current.idleTimer = setTimeout(
			() => {
				if (lease === current && !current.useCount) discard(current);
			},
			Math.max(0, current.idleAt - Date.now()),
		);
		current.idleTimer.unref?.();
	}
	function scheduleRenew(current: Lease) {
		if (current.renewTimer) clearTimeout(current.renewTimer);
		const delay = Math.max(0, current.expiresAt - Date.now() - 180_000);
		current.renewTimer = setTimeout(() => {
			if (lease === current && !closed && !current.closing)
				void connect(["llm"]).catch(() => {});
		}, delay);
		current.renewTimer.unref?.();
	}
	async function refresh(
		current: Lease,
		required: Capability[],
		signal?: AbortSignal,
	): Promise<boolean> {
		const scopedControl = (
			path: string,
			init: RequestInit,
			accepted: number[],
		) => control(path, { ...init, signal }, accepted);
		const state = record(
			await readJson(
				await scopedControl(
					`/v1/agent-connections/${current.id}`,
					{ method: "GET" },
					[200],
				),
			),
		);
		if (state.id !== current.id) throw new Error("larm_invalid_connection");
		if (["failed", "expired", "released"].includes(String(state.status)))
			throw new Error(`larm_connection_${state.status}`);
		if (
			state.profile !== profile ||
			state.agentProfile !== current.agentProfile
		)
			throw new Error("larm_invalid_connection");
		if (state.status !== "ready") return false;
		if (!required.every((name) => current.providers.has(name))) return false;
		const expiresAt = Date.parse(string(state.expiresAt));
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
			throw new Error("larm_expired");
		current.expiresAt = Math.min(current.expiresAt, expiresAt);
		if (current.expiresAt > Date.now() + 180_000) return true;
		for (let attempt = 0; current.useCount > 0 && attempt < 120; attempt++)
			await wait(1000, lifetime.signal);
		if (current.useCount > 0) throw new Error("larm_renew_busy");
		try {
			const renewed = record(
				await readJson(
					await scopedControl(
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
			if (renewed.id !== current.id || renewed.status !== "ready")
				throw new Error("larm_renew_invalid");
			const claimed = record(
				await readJson(
					await scopedControl(
						`/v1/agent-connections/${current.id}/claim`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ format: "openai-provider-v1" }),
						},
						[200],
					),
				),
			);
			if (
				claimed.id !== current.id ||
				claimed.status !== "ready" ||
				!Array.isArray(claimed.providers)
			)
				throw new Error("larm_invalid_claim");
			const nextExpiry = Date.parse(string(claimed.expiresAt));
			if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now() + 180_000)
				throw new Error("larm_renew_expired");
			const next = new Map<ProviderName, Provider>();
			for (const [name, previous] of current.providers) {
				const info = claimed.providers.map(record).find((p) => p.name === name);
				if (name === "system-one") {
					try {
						if (
							info?.model === previous.model &&
							info.protocol === previous.protocol
						) {
							const fields = record(record(info.configuration).fields);
							const baseUrl = string(fields.daemonURL);
							localEndpoint(baseUrl);
							if (baseUrl === info.baseUrl && fields.model === previous.model)
								next.set(name, {
									...previous,
									baseUrl,
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
				localEndpoint(baseUrl);
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
					baseUrl,
					token: string(record(info.credential).token),
				});
			}
			if (current.closing || lease !== current)
				throw new Error("larm_connection_released");
			current.providers = next;
			current.expiresAt = nextExpiry;
			scheduleRenew(current);
			return true;
		} catch (error) {
			await release(current);
			throw error;
		}
	}
	async function connect(
		required: Capability[],
		signal?: AbortSignal,
		force = false,
	): Promise<Lease> {
		signal?.throwIfAborted();
		const scopedControl = (
			path: string,
			init: RequestInit,
			accepted: number[],
		) => control(path, { ...init, signal }, accepted);
		const pause = (ms: number) =>
			wait(
				ms,
				signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
			);
		if (closed) throw new Error("larm_closed");
		if (!base || !token) throw new Error("larm_unconfigured");
		if (lease && !lease.useCount && lease.idleAt <= Date.now()) discard(lease);
		if (
			!force &&
			lease &&
			!lease.closing &&
			lease.expiresAt > Date.now() + 180_000 &&
			required.every((name) => lease!.providers.has(name))
		)
			return lease;
		if (connecting) {
			try {
				await untilAborted(connecting, signal ?? lifetime.signal);
			} catch (error) {
				(signal ?? lifetime.signal).throwIfAborted();
				if (!(error instanceof DOMException && error.name === "AbortError"))
					throw error;
			}
			return connect(required, signal, force);
		}
		connecting = (async () => {
			if (lease && !lease.closing) {
				const current = lease;
				try {
					if (
						(await refresh(current, required, signal)) &&
						lease === current &&
						!current.closing
					) {
						lastError = undefined;
						return current;
					}
				} catch (error) {
					if (
						!(error instanceof Error) ||
						![
							"larm_expired",
							"larm_connection_failed",
							"larm_connection_expired",
							"larm_connection_released",
							"larm_control_404",
						].includes(error.message)
					)
						throw error;
				}
				for (let attempt = 0; current.useCount > 0 && attempt < 120; attempt++)
					await pause(1000);
				if (current.useCount > 0) throw new Error("larm_connection_busy");
				await release(current);
			}
			const catalog = record(
				await readJson(
					await scopedControl(
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
			if (profile === gemmaProfile && catalogProfile.id !== gemmaAgentProfile)
				throw new Error("larm_gemma_agent_profile_mismatch");
			const catalogProviders = Array.isArray(catalogProfile.providers)
				? catalogProfile.providers.map(record)
				: [];
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
			if (profile === gemmaProfile) {
				const llm = catalogProviders.find((p) => p.name === "llm");
				const context = record(llm?.contextWindow);
				if (
					llm?.model !== "gemma4-26b-a4b" ||
					Object.entries(gemmaContext).some(
						([key, value]) => context[key] !== value,
					)
				)
					throw new Error("larm_gemma_contract_mismatch");
			}
			const fullProfile = required.some((name) => name !== "llm");
			const createdResponse = await scopedControl(
				"/v1/agent-connections",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": crypto.randomUUID(),
						Prefer: "wait=1",
					},
					body: JSON.stringify({
						profile,
						client,
						audience,
						ttlSeconds: 900,
						allowFallback: false,
						deploymentPolicy: "existing-only",
						...(fullProfile ? {} : { providers: ["llm"] }),
						expectedCatalogRevision: catalogRevision,
					}),
				},
				[201, 202],
			);
			let created = record(await readJson(createdResponse));
			const id = string(created.id);
			if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
				throw new Error("larm_invalid_connection_id");
			try {
				if (["failed", "expired", "released"].includes(String(created.status)))
					throw new Error(`larm_connection_${created.status}`);
				// Profile switching can report connection ready before its providers are claimable.
				const providersPending = () => {
					const providers = Array.isArray(created.providers)
						? created.providers.map(record)
						: [];
					return required.some((name) => {
						const provider = providers.find((p) => p.name === name);
						return (
							provider &&
							(provider.readiness !== "ready" || provider.claimable !== true)
						);
					});
				};
				for (
					let attempt = 0;
					created.status !== "ready" || providersPending();
					attempt++
				) {
					if (attempt >= 60) throw new Error("larm_capacity_timeout");
					await pause(1000);
					created = record(
						await readJson(
							await scopedControl(
								`/v1/agent-connections/${id}`,
								{ method: "GET" },
								[200],
							),
						),
					);
					if (
						["failed", "expired", "released"].includes(String(created.status))
					)
						throw new Error(`larm_connection_${created.status}`);
				}
				if (
					created.id !== id ||
					created.profile !== profile ||
					created.agentProfile !== catalogProfile.id ||
					!Array.isArray(created.providers)
				)
					throw new Error("larm_invalid_connection");
				for (const name of required) {
					const p = created.providers.map(record).find((p) => p.name === name);
					if (
						!p ||
						p.protocol !== protocols[name] ||
						p.endpoint !== endpoints[name] ||
						p.claimable !== true ||
						p.readiness !== "ready"
					)
						throw new Error("larm_provider_not_ready");
				}
				const claimed = record(
					await readJson(
						await scopedControl(
							`/v1/agent-connections/${id}/claim`,
							{
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ format: "openai-provider-v1" }),
							},
							[200],
						),
					),
				);
				if (
					claimed.id !== id ||
					claimed.status !== "ready" ||
					!Array.isArray(claimed.providers)
				)
					throw new Error("larm_invalid_claim");
				const expiresAt = Date.parse(string(claimed.expiresAt));
				if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000)
					throw new Error("larm_expired");
				const providers = new Map<ProviderName, Provider>();
				for (const name of required) {
					const info = claimed.providers
						.map(record)
						.find((p) => p.name === name);
					const announced = created.providers
						.map(record)
						.find((p) => p.name === name);
					const declared = catalogProviders.find((p) => p.name === name);
					if (
						!info ||
						info.protocol !== protocols[name] ||
						info.model !== announced?.model ||
						info.model !== declared?.model
					)
						throw new Error("larm_claim_mismatch");
					const credential = record(info.credential);
					const configuration = record(record(info.configuration).fields);
					const baseUrl = string(configuration.baseURL);
					localEndpoint(baseUrl);
					if (
						configuration.baseURL !== baseUrl ||
						configuration.model !== info.model
					)
						throw new Error("larm_claim_configuration_mismatch");
					const contextWindow =
						name === "llm" ? record(info.contextWindow) : undefined;
					if (
						contextWindow &&
						!["maxTokens", "outputReserveTokens", "safetyMarginTokens"].every(
							(key) =>
								Number.isInteger(contextWindow[key]) &&
								Number(contextWindow[key]) > 0,
						)
					)
						throw new Error("larm_invalid_context_window");
					if (
						name === "llm" &&
						profile === gemmaProfile &&
						Object.entries(gemmaContext).some(
							([key, value]) => contextWindow?.[key] !== value,
						)
					)
						throw new Error("larm_gemma_contract_mismatch");
					providers.set(name, {
						name,
						baseUrl,
						model: string(info.model),
						protocol: string(info.protocol),
						token: string(credential.token),
						contextWindow: contextWindow as Provider["contextWindow"],
						voice:
							typeof configuration.voice === "string"
								? configuration.voice
								: undefined,
					});
				}
				// Optional decisions never make the speech providers unusable.
				const declaredDecision = catalogProviders.find(
					(p) => p.name === "system-one",
				);
				if (
					fullProfile &&
					declaredDecision?.capability === "decision.system-one" &&
					declaredDecision.protocol === protocols["system-one"] &&
					declaredDecision.endpoint === endpoints["system-one"]
				) {
					try {
						const announced = created.providers
							.map(record)
							.find((p) => p.name === "system-one");
						const info = claimed.providers
							.map(record)
							.find((p) => p.name === "system-one");
						if (
							announced?.claimable === true &&
							announced.readiness === "ready" &&
							info?.protocol === protocols["system-one"] &&
							info.model === declaredDecision.model &&
							info.model === announced.model
						) {
							const fields = record(record(info.configuration).fields);
							const baseUrl = string(fields.daemonURL);
							localEndpoint(baseUrl);
							if (baseUrl === info.baseUrl && fields.model === info.model)
								providers.set("system-one", {
									name: "system-one",
									baseUrl,
									model: string(info.model),
									protocol: string(info.protocol),
									token: string(record(info.credential).token),
								});
						}
					} catch {
						/* Malformed optional provider falls back to normal speech. */
					}
				}
				const current: Lease = {
					id,
					expiresAt,
					providers,
					agentProfile: string(catalogProfile.id),
					useCount: 0,
					closing: false,
					idleAt: Date.now() + idleTimeoutMs,
				};
				lease = current;
				scheduleRenew(current);
				scheduleIdle(current);
				lastError = undefined;
				return current;
			} catch (error) {
				try {
					await control(
						`/v1/agent-connections/${id}`,
						{ method: "DELETE" },
						[204, 200],
					);
				} catch {
					/* original error is primary */
				}
				throw error;
			}
		})();
		notify();
		try {
			return await connecting;
		} catch (error) {
			lastError = error instanceof Error ? error.message : "larm_failed";
			throw error;
		} finally {
			connecting = undefined;
			notify();
		}
	}
	async function isReleased(
		current: Lease,
		signal: AbortSignal,
	): Promise<boolean> {
		if (current.closing) return true;
		const response = await control(
			`/v1/agent-connections/${encodeURIComponent(current.id)}`,
			{ method: "GET", signal },
			[200, 404, 410],
		);
		if (response.status !== 200) {
			await response.body?.cancel();
			return true;
		}
		const state = record(await readJson(response));
		return (
			state.id === current.id &&
			["released", "expired"].includes(String(state.status))
		);
	}
	async function withProvider<T>(
		name: ProviderName,
		signal: AbortSignal,
		use: (p: Provider, connectionId: string) => Promise<T>,
	): Promise<T> {
		const required: Capability[] =
			name === "llm" ? ["llm"] : ["llm", "asr", "tts"];
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			const current = await untilAborted(connect(required, signal), signal);
			const provider = current.providers.get(name);
			if (name === "system-one" && !provider)
				throw new Error("larm_system_one_unavailable");
			if (
				!provider ||
				current.expiresAt <= Date.now() + 10_000 ||
				current.closing
			)
				throw new Error("larm_credential_expired");
			current.useCount++;
			clearTimeout(current.idleTimer);
			try {
				signal.throwIfAborted();
				return await use(provider, current.id);
			} catch (error) {
				let unusable =
					error instanceof LarmInferenceError &&
					error.status === 409 &&
					error.code === "connection_idle_released";
				// Some gateway versions return unauthorized after an idle profile switch.
				// Confirm the old connection is terminal; a ready connection's 401 stays an error.
				if (
					!signal.aborted &&
					error instanceof LarmInferenceError &&
					error.status === 401 &&
					error.code === "unauthorized"
				) {
					try {
						unusable = await isReleased(current, signal);
					} catch {
						signal.throwIfAborted();
					}
				}
				if (unusable) {
					discard(current, "larm_connection_released");
					// The gateway rejected before inference began. Only this explicit
					// lifecycle rejection may replay once; streamed output is never replayed.
					if (!attempt && !signal.aborted) continue;
				}
				throw error;
			} finally {
				current.useCount--;
				if (current.closing && current.useCount === 0) await release(current);
				else if (!current.closing && !current.useCount) {
					current.idleAt = Date.now() + idleTimeoutMs;
					scheduleIdle(current);
				}
			}
		}
	}
	async function infer(
		provider: Provider,
		operation: string,
		init: RequestInit,
		signal: AbortSignal,
		connectionId: string,
		options?: LarmCallOptions,
	): Promise<Response> {
		const endpoint = new URL(
			provider.baseUrl.endsWith("/")
				? provider.baseUrl
				: `${provider.baseUrl}/`,
		);
		const url = new URL(operation, endpoint);
		if (url.origin !== endpoint.origin)
			throw new Error("larm_endpoint_mismatch");
		const started = Date.now();
		let response: Response;
		try {
			response = await request(url, {
				...init,
				headers: { Authorization: `Bearer ${provider.token}`, ...init.headers },
				signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
				redirect: "error",
			});
		} catch (error) {
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				started,
			});
			throw error;
		}
		if (!response.ok) {
			const details = await providerError(response, signal, [
				provider.token,
				token ?? "",
			]);
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				started,
				httpStatus: response.status,
				...details,
			});
			throw new LarmInferenceError(response.status, details.errorCode);
		}
		try {
			let speechCredit: string | undefined;
			const encodedCredit = response.headers.get("X-VOICEVOX-Credit");
			if (
				operation === "audio/speech" &&
				encodedCredit?.startsWith("UTF-8''")
			) {
				try {
					speechCredit = decodeURIComponent(encodedCredit.slice(7)).slice(
						0,
						2048,
					);
				} catch {
					/* Invalid optional credit does not invalidate audio. */
				}
			}
			await options?.onExchange?.({
				connectionId,
				model: provider.model,
				started,
				httpStatus: response.status,
				...(speechCredit
					? { speechCredit, speechVoice: options?.speechVoice }
					: {}),
			});
		} catch (error) {
			await response.body?.cancel();
			throw error;
		}
		return response;
	}
	async function answer(
		messages: Parameters<LarmPort["answer"]>[0],
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		options?: LarmCallOptions,
	) {
		return withProvider("llm", signal, async (p, connectionId) => {
			const window = p.contextWindow;
			if (!window) throw new Error("larm_missing_context_window");
			const budget =
				window.maxTokens -
				window.outputReserveTokens -
				window.safetyMarginTokens;
			if (budget <= 0) throw new Error("larm_invalid_context_window");
			const selected = [...messages];
			const estimate = (items: typeof messages) =>
				new TextEncoder().encode(JSON.stringify(items)).length;
			while (selected.length > 2 && estimate(selected) > budget)
				selected.splice(1, Math.min(2, selected.length - 2));
			if (estimate(selected) > budget)
				throw new Error("context_window_exceeded");
			const response = await infer(
				p,
				"chat/completions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: p.model,
						messages: selected,
						stream: !!onDelta,
						max_tokens: Math.min(window.outputReserveTokens, 4096),
					}),
				},
				signal,
				connectionId,
				options,
			);
			return (await readChatResponse(response, signal, onDelta)).text;
		});
	}
	async function readVoices(
		p: Provider,
		connectionId: string,
		signal: AbortSignal,
	): Promise<TtsVoices> {
		const available = record(
			await readJson(
				await infer(
					p,
					`audio/voices?model=${encodeURIComponent(p.model)}`,
					{ method: "GET" },
					signal,
					connectionId,
				),
			),
		);
		const parsed = ttsVoicesSchema.safeParse({ ...available, model: p.model });
		if (!parsed.success) throw new Error("larm_invalid_voice_catalog");
		signal.throwIfAborted();
		voiceCatalogs.set(p, parsed.data);
		return parsed.data;
	}

	return {
		async judge(state, questions, signal) {
			if (judging) throw new Error("larm_decision_busy");
			judging = true;
			try {
				const scoped = AbortSignal.any([signal, lifetime.signal]);
				return await withProvider(
					"system-one",
					scoped,
					async (p, connectionId) => {
						const response = await infer(
							p,
							"systemone",
							{
								method: "POST",
								headers: {
									"content-type": "application/json",
									accept: "application/json",
								},
								body: JSON.stringify({ model: p.model, state, questions }),
							},
							scoped,
							connectionId,
						);
						const result = await readJson(response);
						scoped.throwIfAborted();
						return result;
					},
				);
			} finally {
				judging = false;
			}
		},
		async voices(signal) {
			return withProvider("tts", signal, (p, connectionId) =>
				readVoices(p, connectionId, signal),
			);
		},
		async connect() {
			await connect(["llm"], undefined, true);
		},
		inspect() {
			return {
				profile,
				...(lease ? { connectionId: lease.id } : {}),
				providers: lease
					? [...lease.providers.values()]
							.filter(
								(p): p is Provider & { name: Capability } =>
									p.name !== "system-one",
							)
							.map((p) => ({
								name: p.name,
								model: p.model,
								baseUrl: p.baseUrl,
								protocol: p.protocol,
							}))
					: [],
			};
		},
		async probe(signal) {
			await connect(["llm"], signal);
		},
		status,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		answer: (messages, signal, options) =>
			answer(messages, signal, undefined, options),
		answerStream: answer,
		prepareVoice: (signal) =>
			connect(["llm", "asr", "tts"], signal).then(() => {}),
		transcribe(wav, signal, options) {
			return withProvider("asr", signal, async (p, connectionId) => {
				if (wav.length < 44 || wav.length > 4_000_000)
					throw new Error("audio_size_invalid");
				const form = new FormData();
				form.append("model", p.model);
				form.append("response_format", "json");
				form.append(
					"file",
					new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
					"speech.wav",
				);
				const response = await infer(
					p,
					"audio/transcriptions",
					{ method: "POST", body: form },
					signal,
					connectionId,
					options,
				);
				return string(record(await readJson(response)).text);
			});
		},
		speak(text, signal, options) {
			return withProvider("tts", signal, async (p, connectionId) => {
				if (!text.trim() || text.length > 4096)
					throw new Error("larm_tts_input_invalid");
				let selectedVoice = voice ?? p.voice;
				const voicevox = p.model === "voicevox-core";
				const catalog =
					voicevox || !selectedVoice
						? (voiceCatalogs.get(p) ??
							(await readVoices(p, connectionId, signal)))
						: undefined;
				if (!voice && voicevox)
					selectedVoice = catalog?.default_voice ?? selectedVoice;
				if (!selectedVoice) selectedVoice = p.voice = catalog?.default_voice;
				if (!selectedVoice) throw new Error("larm_tts_voice_unconfigured");
				const speaker = catalog?.voices.find((v) => v.id === selectedVoice);
				if (voicevox && !speaker) throw new Error("larm_tts_voice_missing");
				if (
					voicevox &&
					config.style &&
					!speaker?.styles.some((s) => s.id === config.style)
				)
					throw new Error("larm_tts_voice_style_invalid");
				let intonationScale = config.intonationScale;
				const selectedSpeed =
					voicevox && options?.speed !== undefined
						? options.speed
						: config.speed;
				const selectedPitch =
					voicevox && options?.pitchScale !== undefined
						? options.pitchScale
						: config.pitchScale;
				const boundedParameter = (
					value: number | undefined,
					key: "speed" | "pitch_scale",
					override: boolean,
				) => {
					if (value === undefined || !override) return value;
					const range = speaker?.capabilities[key];
					return range
						? Math.max(range.minimum, Math.min(range.maximum, value))
						: value;
				};
				const speechSpeed = boundedParameter(
					selectedSpeed,
					"speed",
					voicevox && options?.speed !== undefined,
				);
				const speechPitch = boundedParameter(
					selectedPitch,
					"pitch_scale",
					voicevox && options?.pitchScale !== undefined,
				);
				if (options?.intonationScale !== undefined) {
					const range = speaker?.capabilities.intonation_scale;
					intonationScale = Math.max(
						range?.minimum ?? 0,
						Math.min(range?.maximum ?? 2, options.intonationScale),
					);
				}
				for (const [key, value] of [
					["speed", speechSpeed],
					["pitch_scale", speechPitch],
					["intonation_scale", intonationScale],
				] as const) {
					if (voicevox && value !== undefined) {
						const range = speaker?.capabilities[key];
						if (
							!Number.isFinite(value) ||
							(range && (value < range.minimum || value > range.maximum))
						)
							throw new Error("larm_tts_parameter_invalid");
					}
				}
				const response = await infer(
					p,
					"audio/speech",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: p.model,
							input: text,
							voice: selectedVoice,
							...(speechSpeed !== undefined ? { speed: speechSpeed } : {}),
							...(voicevox && config.style ? { style: config.style } : {}),
							...(voicevox && speechPitch !== undefined
								? { pitch_scale: speechPitch }
								: {}),
							...(voicevox && intonationScale !== undefined
								? { intonation_scale: intonationScale }
								: {}),
							response_format: "wav",
						}),
					},
					signal,
					connectionId,
					{ ...options, speechVoice: selectedVoice },
				);
				const bytes = await readBounded(response, 16_000_000);
				if (
					bytes.length < 44 ||
					String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
					String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE"
				)
					throw new Error("tts_audio_invalid");
				return bytes;
			});
		},
		async close() {
			closed = true;
			lifetime.abort(new Error("larm_closed"));
			if (connecting) await connecting.catch(() => {});
			if (lease) await release(lease);
			listeners.clear();
		},
	};
}
