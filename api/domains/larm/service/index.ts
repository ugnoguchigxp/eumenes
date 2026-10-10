import { chatRequest } from "./chat-request";
import { readBounded } from "../../../infrastructure/bounded-read";
import {
	isNetworkError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("larm");
import {
	readChatResponse,
	forwardToolCalls,
} from "../../../infrastructure/chat-stream";
import type {
	Capability,
	LarmPort,
	LarmStatus,
	LarmCallOptions,
} from "../contracts";
import {
	auxiliaryProfile,
	gemmaProfile,
	type Fetcher,
	type Lease,
	type Provider,
	type ProviderName,
} from "./profiles";
import { assertRuriQuestions, decodeSpeechCredit, fitContext } from "./context";
import {
	awaitReady,
	renewProviders,
	claimProviders,
	createConnection,
	fetchCatalog,
} from "./connect";
import {
	localEndpoint,
	readJson,
	record,
	string,
	untilAborted,
	wait,
} from "./guards";
import { LarmInferenceError, providerError } from "./inference-error";
import { ttsVoicesSchema } from "../contracts";
import type { TtsVoices } from "../contracts";

/** True when the caller's own signal cancelled the request (not a timeout or a LARM fault). */
const callerAborted = (error: unknown, signal?: AbortSignal) =>
	signal?.aborted === true && (error as Error)?.name === "AbortError";

export function createLarm(config: {
	/** LARM control origin. There is no default: without it the port stays unconfigured. */
	baseUrl?: string;
	/** Extra hosts that may receive provider credentials; supplied by the composition root from Config (EUMENES_LARM_PROVIDER_HOSTS). */
	providerHosts?: readonly string[];
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
	const baseText = config.baseUrl?.trim();
	const base = baseText
		? localEndpoint(baseText, [new URL(baseText).hostname])
		: undefined;
	const providerHosts =
		config.providerHosts?.map((host) => host.toLowerCase()) ?? [];
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
	const hostsFor = () => {
		if (!base) throw new Error("larm_base_url_unconfigured");
		return { base, extra: providerHosts };
	};
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
			state:
				!token || !base
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
			...(!base
				? { error: "larm_base_url_unconfigured" }
				: lastError
					? { error: lastError }
					: {}),
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
		if (!base) throw new Error("larm_base_url_unconfigured");
		if (!token) throw new Error("larm_unconfigured");
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
							// Only read-only status checks are short; POSTs (create, claim,
							// renew) may legitimately wait for LARM and must not be cut early.
							AbortSignal.timeout(
								(!init.method || init.method === "GET") && init.signal
									? 3_000
									: 15_000,
							),
							...(init.signal ? [init.signal] : []),
						]),
		});
		if (!accepted.includes(response.status)) {
			log.warn("larm.control_rejected", {
				route: path
					.split("?")[0]!
					.replace(/(agent-connections\/)[^/]+/, "$1:id"),
				method: init.method ?? "GET",
				status: response.status,
			});
			throw new Error(`larm_control_${response.status}`);
		}
		return response;
	}
	async function release(current: Lease, force = false) {
		current.closing = true;
		if (current.renewTimer) clearTimeout(current.renewTimer);
		clearTimeout(current.idleTimer);
		if (current.useCount > 0 && !force) return;
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
			const { providers: next, expiresAt: nextExpiry } = await renewProviders(
				scopedControl,
				current,
				hostsFor(),
			);
			if (current.closing || lease !== current)
				throw new Error("larm_connection_released");
			current.providers = next;
			current.expiresAt = nextExpiry;
			scheduleRenew(current);
			return true;
		} catch (error) {
			// The caller's cancellation says nothing about the shared lease.
			if (callerAborted(error, signal)) throw error;
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
		if (!base) throw new Error("larm_base_url_unconfigured");
		if (!token) throw new Error("larm_unconfigured");
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
			// A renewal in flight must not stop new work on a lease that is still valid.
			if (
				!force &&
				lease &&
				!lease.closing &&
				lease.expiresAt - Date.now() > 30_000 &&
				required.every((name) => lease!.providers.has(name))
			)
				return lease;
			try {
				await untilAborted(connecting, signal ?? lifetime.signal);
			} catch (error) {
				(signal ?? lifetime.signal).throwIfAborted();
				// The attempt belongs to another caller; its own cancellation or
				// deadline (AbortError / TimeoutError) must not fail this caller.
				if (
					!(
						error instanceof DOMException &&
						(error.name === "AbortError" || error.name === "TimeoutError")
					)
				)
					throw error;
			}
			return connect(required, signal, force);
		}
		const connectStarted = performance.now();
		// One key per connect(): every attempt to create this connection reuses it.
		const idempotencyKey = crypto.randomUUID();
		log.info("larm.connection_started", { count: required.length });
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
			const { catalogRevision, catalogProfile, catalogProviders } =
				await fetchCatalog(scopedControl, profile, required);
			const fullProfile = required.some((name) => name !== "llm");
			const creation = {
				profile,
				client,
				audience,
				fullProfile,
				catalogRevision,
				idempotencyKey,
			};
			let creationResult: Awaited<ReturnType<typeof createConnection>>;
			try {
				creationResult = await createConnection(scopedControl, creation);
			} catch (error) {
				// A timed-out POST may still have created the connection; the same
				// Idempotency-Key makes one retry return it instead of a duplicate.
				if (
					!(error instanceof DOMException && error.name === "TimeoutError") ||
					signal?.aborted ||
					lifetime.signal.aborted
				)
					throw error;
				creationResult = await createConnection(scopedControl, creation);
			}
			const { id, created } = creationResult;
			try {
				const ready = await awaitReady(scopedControl, pause, {
					id,
					created,
					required,
					profile,
					agentProfile: catalogProfile.id,
				});
				const { expiresAt, providers } = await claimProviders(scopedControl, {
					id,
					created: ready,
					required,
					profile,
					catalogProviders,
					fullProfile,
					hosts: hostsFor(),
				});
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
			const connected = await connecting;
			log.info("larm.connection_ready", {
				count: connected.providers.size,
				durationMs: Math.round(performance.now() - connectStarted),
			});
			return connected;
		} catch (error) {
			if (callerAborted(error, signal))
				// The caller gave up; LARM did not fail, so the status stays as it was.
				log.info("larm.connection_failed", {
					reason: "caller_aborted",
					durationMs: Math.round(performance.now() - connectStarted),
				});
			else {
				log.warn(
					"larm.connection_failed",
					{ durationMs: Math.round(performance.now() - connectStarted) },
					error,
				);
				lastError = isNetworkError(error)
					? "larm_connection_failed"
					: toErrorCode(error, "larm_failed");
			}
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
				// The caller owns the deadline (LLM calls run up to 180 s); this only bounds a stuck stream.
				signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
				redirect: "error",
			});
		} catch (error) {
			if (signal.aborted)
				log.info("larm.inference_cancelled", {
					kind: operation,
					reason: "cancelled",
					durationMs: Date.now() - started,
				});
			else
				log.warn(
					"larm.inference_unreachable",
					{
						kind: operation,
						reason: "network_unavailable",
						durationMs: Date.now() - started,
					},
					error,
				);
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
			log.warn("larm.inference_rejected", {
				kind: operation,
				status: response.status,
				reason: `larm_inference_${response.status}`,
				durationMs: Date.now() - started,
			});
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
			const speechCredit =
				operation === "audio/speech"
					? decodeSpeechCredit(response.headers.get("X-VOICEVOX-Credit"))
					: undefined;
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
			const selected = fitContext(
				messages,
				window,
				options?.contextPolicy === "exact",
			);
			const response = await infer(
				p,
				"chat/completions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(chatRequest(p, selected, !!onDelta, options)),
				},
				signal,
				connectionId,
				options,
			);
			const result = await readChatResponse(response, signal, onDelta);
			forwardToolCalls(result, options?.tools, options?.onToolCalls);
			return result.text;
		});
	}
	async function readVoices(
		p: Provider,
		signal: AbortSignal,
	): Promise<TtsVoices> {
		// The connection credential is scoped to inference. Voice discovery uses
		// the backend control credential at the control origin only.
		const available = record(
			await untilAborted(
				control(
					`/v1/audio/voices?model=${encodeURIComponent(p.model)}`,
					{ method: "GET" },
					[200],
				).then(readJson),
				signal,
			),
		);
		const parsed = ttsVoicesSchema.safeParse({ ...available, model: p.model });
		if (!parsed.success) throw new Error("larm_invalid_voice_catalog");
		signal.throwIfAborted();
		voiceCatalogs.set(p, parsed.data);
		return parsed.data;
	}

	return {
		decisionModel: () => lease?.providers.get("system-one")?.model ?? null,
		async judge(state, questions, signal) {
			if (judging) throw new Error("larm_decision_busy");
			judging = true;
			try {
				const scoped = AbortSignal.any([signal, lifetime.signal]);
				return await withProvider(
					"system-one",
					scoped,
					async (p, connectionId) => {
						const ruri = p.model === "ruri-v3-30m-speaking-attitude";
						if (ruri) assertRuriQuestions(questions);
						const { current_chunk, ...legacyState } = state;
						const sentState = ruri
							? { current_chunk: current_chunk ?? state.response ?? "" }
							: legacyState;
						const response = await infer(
							p,
							"systemone",
							{
								method: "POST",
								headers: {
									"content-type": "application/json",
									accept: "application/json",
								},
								body: JSON.stringify({
									model: p.model,
									state: sentState,
									questions,
								}),
							},
							scoped,
							connectionId,
						);
						const result = await readJson(response);
						scoped.throwIfAborted();
						if (!result || typeof result !== "object" || Array.isArray(result))
							throw new Error("larm_invalid_decision_response");
						const body = result as Record<string, unknown>;
						if (body.model !== undefined && body.model !== p.model)
							throw new Error("larm_decision_model_mismatch");
						return { ...body, claimed_model: p.model };
					},
				);
			} finally {
				judging = false;
			}
		},
		async voices(signal) {
			return withProvider("tts", signal, (p) => readVoices(p, signal));
		},
		async connect() {
			await connect(["llm"], undefined, true);
		},
		inspect() {
			return {
				profile,
				decisionModel: lease?.providers.get("system-one")?.model ?? null,
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
				const text = record(await readJson(response)).text;
				// An empty transcript is a valid result for silence, not a broken contract.
				if (typeof text !== "string" || text.length > 4096)
					throw new Error("larm_invalid_contract");
				return text;
			});
		},
		speak(text, signal, options) {
			return withProvider("tts", signal, async (p, connectionId) => {
				if (!text.trim() || text.length > 4096)
					throw new Error("larm_tts_input_invalid");
				let selectedVoice = voice ?? p.voice;
				const voicevox = p.model === "voicevox-core";
				let catalog: TtsVoices | undefined;
				if (voicevox || !selectedVoice) {
					try {
						catalog = voiceCatalogs.get(p) ?? (await readVoices(p, signal));
					} catch (error) {
						// The catalog only validates and clamps; a voice that is already
						// chosen can still be synthesized when the catalog is refused.
						signal.throwIfAborted();
						log.warn(
							"larm.voice_catalog_unavailable",
							{
								reason: "voice_catalog_unavailable",
								kind: selectedVoice
									? "continue_with_selected_voice"
									: "no_voice",
							},
							error,
						);
						if (!selectedVoice) throw error;
					}
				}
				const catalogUnavailable = (voicevox || !selectedVoice) && !catalog;
				if (!voice && voicevox)
					selectedVoice = catalog?.default_voice ?? selectedVoice;
				if (!selectedVoice) selectedVoice = p.voice = catalog?.default_voice;
				if (!selectedVoice) throw new Error("larm_tts_voice_unconfigured");
				const speaker = catalog?.voices.find((v) => v.id === selectedVoice);
				if (voicevox && !catalogUnavailable && !speaker) {
					log.warn("larm.tts_voice_missing", {
						kind: selectedVoice,
						count: catalog?.voices.length,
						reason: `catalog: ${(catalog?.voices ?? [])
							.slice(0, 12)
							.map((v) => v.id)
							.join(",")}`.slice(0, 250),
					});
					throw new Error("larm_tts_voice_missing");
				}
				if (
					voicevox &&
					!catalogUnavailable &&
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
				const bytes = await readBounded(response.body, {
					limit: 16_000_000,
					tooLarge: "larm_response_too_large",
					missing: "larm_empty_response",
				});
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
			if (lease) {
				const current = lease;
				// Let in-flight work finish (up to 5 s) so the DELETE is not skipped.
				const idle = new AbortController().signal;
				for (
					let waited = 0;
					current.useCount > 0 && waited < 5_000;
					waited += 100
				)
					await wait(100, idle);
				await release(current, true);
			}
			listeners.clear();
		},
	};
}
