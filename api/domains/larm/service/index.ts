import { transcribeWav } from "./transcription";
import { measureStage } from "../../../infrastructure/performance";
import { gzipFetch, plainFetch } from "./gzip-fetch";
import type { Capability, LarmPort, LarmCallOptions } from "../contracts";
import { ttsVoicesSchema } from "../contracts";
import type { TtsVoices } from "../contracts";
import type { ActivityRecorder } from "../contracts/activity";

type Judge = Parameters<NonNullable<LarmPort["judge"]>>;
import { createSpeechSynthesizer } from "./speech";
import { answerRequest } from "./answer-request";
import { assertAttitudeQuestions } from "./context";
import { createControl } from "./control";
import { createInfer } from "./infer";
import { createConversationYield } from "./conversation-yield";
import { createHelperConnections } from "./helper-connections";
import { createLeaseManager } from "./lease-manager";
import { leasePort } from "./lease-port";
import { type Fetcher, type Provider } from "./profiles";
import { localEndpoint, readJson, record, untilAborted } from "./guards";

/** A catalog entry as a conversation profile: generally selectable, not deprecated, with an llm provider. */
function conversationProfile(item: unknown) {
	const entry = record(item);
	if (entry.selectionPolicy !== "default" || entry.deprecated === true)
		return [];
	const llm = (
		Array.isArray(entry.providers) ? entry.providers.map(record) : []
	).find((p) => p.name === "llm");
	return llm && typeof entry.id === "string" && entry.id
		? [
				{
					profile: entry.id,
					model: typeof llm.model === "string" ? llm.model : null,
				},
			]
		: [];
}

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
	/** Hold the connection while the port is open: LARM's input cache lives on the connection. */
	keepAlive?: boolean;
	/** Records attitude judge outcomes for monitoring; the judge has no attempt record of its own. */
	judgeActivity?: ActivityRecorder;
}): LarmPort {
	const baseText = config.baseUrl?.trim();
	const base = baseText
		? localEndpoint(baseText, [new URL(baseText).hostname])
		: undefined;
	const providerHosts =
		config.providerHosts?.map((host) => host.toLowerCase()) ?? [];
	const token = config.token?.trim();
	const request = gzipFetch(config.fetch ?? fetch);
	// The saved profile is the only source; without it the port reports larm_profile_missing instead of guessing.
	const profile = config.profile?.trim() ?? "";
	const audience = config.audience?.trim() || "saaa-desktop";
	// LARM reuses a live connection for the same client/profile binding.
	// Each port owns an independent session identity, retained across renew/reconnect.
	const client = config.client ?? `eumenes-client-${crypto.randomUUID()}`;
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
	const helpers = createHelperConnections(
		(helperClient) =>
			createLarm({ ...config, client: helperClient, keepAlive: false }),
		client,
	);
	let mainAnswer = Promise.resolve();
	const yielding = createConversationYield();
	const voiceCatalogs = new WeakMap<Provider, TtsVoices>();
	let judging = false;
	const control = createControl({
		base,
		token,
		request: gzipFetch(config.fetch ?? fetch, false),
		lifetime: lifetime.signal,
	});
	const infer = createInfer({ request, token });
	const judgeInfer = createInfer({
		request: plainFetch(config.fetch ?? fetch),
		token,
	});
	const leases = createLeaseManager({
		base,
		token,
		profile,
		audience,
		client,
		idleTimeoutMs,
		keepAlive: config.keepAlive,
		hostsFor,
		control,
		lifetime,
	});
	const { connect, withProvider, status } = leases;
	async function inferAnswer(
		messages: Parameters<LarmPort["answer"]>[0],
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		options?: LarmCallOptions,
	) {
		return withProvider("llm", signal, (p, connectionId) =>
			answerRequest(p, messages, signal, onDelta, options, {
				profile,
				request,
				sameClaim: () => leases.current()?.providers.get("llm") === p,
				send: (init) =>
					infer(p, "chat/completions", init, signal, connectionId, options),
			}),
		);
	}
	async function answer(
		messages: Parameters<LarmPort["answer"]>[0],
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		options?: LarmCallOptions,
	) {
		// Background work on the conversation's prompt yields: a conversation call takes the connection at once.
		const yields = options?.onConversation ? yielding.enter() : null;
		const scoped = AbortSignal.any([
			signal,
			lifetime.signal,
			...(yields ? [yields.signal] : []),
		]);
		if (
			!yields &&
			(options?.sessionRole === "auxiliary" ||
				options?.sessionRole === "subagent")
		) {
			// Independent sessions (one-shot calls and task sub-agents) share the saved profile; admission and KV capacity belong to LARM.
			return helpers.answer(messages, scoped, onDelta, options, (run) =>
				withProvider("llm", scoped, run),
			);
		}
		if (!yields) yielding.preempt();
		// One call may infer on the conversation's connection at a time.
		const previous = mainAnswer;
		let finish!: () => void;
		mainAnswer = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			await measureStage("larm", "main_connection_wait", () =>
				untilAborted(previous, scoped),
			);
			return await inferAnswer(messages, scoped, onDelta, options);
		} finally {
			yields?.leave();
			// A cancelled queued call must not let a later call overtake the active one.
			void previous.finally(finish);
		}
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

	async function judgeOnce(...[state, questions, signal]: Judge) {
		judging = true;
		try {
			const scoped = AbortSignal.any([signal, lifetime.signal]);
			return await withProvider(
				"system-one",
				scoped,
				async (p, connectionId) => {
					assertAttitudeQuestions(questions);
					const sentState = {
						current_chunk: state.current_chunk ?? state.response ?? "",
					};
					const response = await judgeInfer(
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
	}

	return {
		...leasePort(leases),
		retain: leases.retain,
		async judge(state, questions, signal) {
			if (judging) throw new Error("larm_decision_busy");
			const call = () => judgeOnce(state, questions, signal);
			return config.judgeActivity?.track(call, signal) ?? call();
		},
		async voices(signal, language) {
			return withProvider(
				language === "en" ? "tts-english" : "tts",
				signal,
				(p) => readVoices(p, signal),
			);
		},
		async connect() {
			await connect(["llm"], undefined, true);
		},
		async conversationProfiles(signal) {
			// The unselected catalog lists every profile; only the generally selectable ones with an llm provider
			// hold a conversation. Explicit-only profiles serve a named consumer (background work, classifiers).
			try {
				const catalog = record(
					await readJson(
						await control(
							"/v3/agent-profiles",
							{ method: "GET", signal },
							[200],
						),
					),
				);
				return (
					Array.isArray(catalog.profiles) ? catalog.profiles : []
				).flatMap(conversationProfile);
			} catch {
				// The catalog is unreachable; the saved choice stays visible without a model.
				return profile ? [{ profile, model: null }] : [];
			}
		},
		inspect() {
			const lease = leases.current();
			return {
				profile,
				decisionModel: lease?.providers.get("system-one")?.model ?? null,
				...(lease ? { connectionId: lease.id } : {}),
				providers: lease
					? [...lease.providers.values()]
							.filter(
								(p): p is Provider & { name: Capability | "tts-english" } =>
									p.name === "llm" ||
									p.name === "asr" ||
									p.name === "tts" ||
									p.name === "tts-english",
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
		onChange: leases.onChange,
		answer: (messages, signal, options) =>
			answer(messages, signal, undefined, options),
		answerStream: answer,
		prepareVoice: (signal) =>
			connect(["llm", "asr", "tts"], signal).then(() => {}),
		transcribe(wav, signal, options) {
			// The user has spoken: the conversation's answer comes next, so its connection is freed now.
			yielding.preempt();
			return withProvider("asr", signal, (p, connectionId) =>
				transcribeWav(p, wav, infer, signal, connectionId, options),
			);
		},
		speak: createSpeechSynthesizer({
			withProvider,
			infer,
			japaneseVoice: () => leases.current()?.providers.get("tts"),
			readVoices,
			voiceCatalogs,
			config,
			voice,
		}),
		close: (options) =>
			leases.close(() => helpers.close(options), !!options?.keepConnection),
	};
}
