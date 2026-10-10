import type { Database } from "bun:sqlite";
import type { AttitudeDataset, VoiceAdoption } from "../../attitude-dataset";
import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LarmCallOptions, LarmExchange, LarmPort } from "../../larm";
import { chooseSpeechDelivery, speechParameters } from "../../delivery";
import type {
	DeliveryContext,
	Judge,
	SpeechDelivery,
	SpeechPreparation,
} from "../../delivery/contracts";
import type { Connection, Resource, Settings } from "../../settings";
import type { SettingsService } from "../../settings";
import type { Messages, Receipt } from "../contracts";
import { get, type RequestRow } from "../repository";
import { cloudRequest } from "./cloud";
import { fallbackErrors, safeError } from "./errors";

const log = getLogger("inference");

export type InferenceOptions = {
	codexResearch?: {
		model: string;
		execute(messages: Messages, signal: AbortSignal): Promise<string>;
	};
	/** Must use the selected model's tokenizer, including message framing. */
	countControlTokens?: (messages: Messages) => number | null;
	token?: string;
	/** Extra hosts that may receive provider credentials (from Config). */
	providerHosts?: readonly string[];
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	larmFactory?: (s: Settings) => LarmPort;
	localMs?: number;
	cloudMs?: number;
	decisionMs?: number;
	attitudeDataset?: AttitudeDataset;
	/** Rewrites text just before synthesis (e.g. pronunciation dictionary). */
	speechText?: (text: string) => string;
};
export type Running = {
	controller: AbortController;
	row: RequestRow;
	connection?: Connection;
	done: Promise<void>;
	finish: () => void;
};
export type CollectionAdoption = {
	identity: NonNullable<SpeechPreparation["collection"]>;
	delivery: SpeechDelivery;
	voice?: VoiceAdoption;
};
/** The service-wide state an execution reads and updates. */
export type Env = {
	store: SqliteStore;
	settings: SettingsService;
	options: InferenceOptions;
	active: Map<string, Running>;
	cooldown: Map<string, number>;
	collectionAdoptions: Map<string, CollectionAdoption>;
	port(s: Settings): LarmPort;
	resolve(
		row: RequestRow,
	): { resource: Resource; connection: Connection } | null;
	allowed(db: Database, row: RequestRow, connection?: Connection): boolean;
	prune(): void;
	isClosed(): boolean;
	/** Counts store commits; streaming re-checks authority only when it changes. */
	commitGeneration(): number;
	/** Tells the activity listeners that a request started or ended running. */
	touch?(): void;
};
type Selected = ReturnType<Env["resolve"]>;
type Input = Messages | string | Uint8Array;
type Source = "larm" | "cloud" | "codex";
/** Per-request state shared by the larm attempt and a cloud fallback attempt. */
type Request = {
	tools?: import("../../../infrastructure/chat-stream").NativeTool[];
	toolCalls?: import("../../../infrastructure/chat-stream").NativeToolCall[];
	env: Env;
	row: RequestRow;
	input: Input;
	caller: AbortSignal;
	signal: AbortSignal;
	deadline: number;
	selected: Selected;
	running: Running;
	onDelta?: (text: string) => void;
	preparation?: SpeechPreparation;
	/** Why the previous attempt was abandoned (recorded on the next attempt). */
	reason: string | null;
	/** True once any answer text reached the caller: no silent fallback after that. */
	published: boolean;
};

const route = (r: Request) => r.row.snapshot.routes[r.row.purpose];
const deltaFallback = (r: Request) =>
	r.row.purpose === "llm" ? 60_000 : 30_000;

/** How long this attempt may run, leaving room for a cloud fallback when one is possible. */
function attemptDuration(r: Request, source: Source) {
	const { options } = r.env;
	const configured =
		source === "cloud"
			? (options.cloudMs ?? deltaFallback(r))
			: (options.localMs ?? (r.row.purpose === "llm" ? 120_000 : 15_000));
	const remaining = Math.max(0, r.deadline - Date.now());
	const reserve =
		source === "larm" &&
		route(r).mode === "larm-preferred" &&
		r.selected?.connection.enabled &&
		route(r).cloudAllowed
			? Math.min(options.cloudMs ?? deltaFallback(r), remaining)
			: 0;
	return Math.min(configured, Math.max(1, remaining - reserve));
}

async function recordAttemptStart(r: Request, source: Source) {
	const connection = source === "cloud" ? r.selected?.connection : undefined;
	const attemptId = crypto.randomUUID();
	await r.env.store.write((db) =>
		db
			.query(
				"INSERT INTO inference_attempts(id,request_id,source,connection_id,resource_id,model,status,reason,started) VALUES(?,?,?,?,?,?,'running',?,?)",
			)
			.run(
				attemptId,
				r.row.id,
				source,
				connection?.id ?? null,
				source === "cloud" ? (r.selected?.resource.id ?? null) : null,
				source === "cloud"
					? (r.selected?.resource.model ?? null)
					: source === "codex"
						? r.env.options.codexResearch!.model
						: r.row.snapshot.larm.profile,
				r.reason,
				Date.now(),
			),
	);
	return attemptId;
}

/** Provider options, plus a recorder that keeps the (at most two) exchanges for correlation. */
function callOptionsFor(r: Request, attemptId: string): LarmCallOptions {
	const exchanges: LarmExchange[] = [];
	return {
		...(r.tools?.length
			? {
					tools: r.tools,
					onToolCalls: (
						calls: import("../../../infrastructure/chat-stream").NativeToolCall[],
					) => {
						r.toolCalls = calls;
					},
				}
			: {}),
		...(r.row.mode === "control" ? { jsonOutput: true } : {}),
		...(r.row.contextPolicy === "exact"
			? { contextPolicy: "exact" as const }
			: {}),
		...(r.row.outputLimit ? { maxOutputTokens: r.row.outputLimit } : {}),

		onExchange: async (exchange: LarmExchange) => {
			// A call can use the old lease and one replacement. Keep both for correlation.
			if (exchanges.length >= 2) return;
			exchanges.push(exchange);
			await r.env.store.write((db) =>
				db
					.query(
						"UPDATE inference_attempts SET provider_details=?,model=? WHERE id=?",
					)
					.run(JSON.stringify(exchanges), exchange.model, attemptId),
			);
		},
	};
}

function decider(r: Request, attemptSignal: AbortSignal) {
	const { env } = r;
	return (judge: Judge | undefined, text: string, context?: DeliveryContext) =>
		env.options.attitudeDataset
			? env.options.attitudeDataset.decide({
					judge,
					model: env.port(r.row.snapshot).decisionModel?.() ?? null,
					prepareJudge: async (signal) => {
						const p = env.port(r.row.snapshot);
						await p.prepareVoice?.(signal);
						return p.decisionModel?.() ?? null;
					},
					text,
					context,
					identity: r.preparation?.collection,
					signal: attemptSignal,
					collectionSignal: r.caller,
					budgetMs: env.options.decisionMs,
				})
			: chooseSpeechDelivery(
					judge,
					text,
					attemptSignal,
					env.options.decisionMs,
					context,
				);
}

function logDelivery(r: Request, delivery: SpeechDelivery) {
	log.info("inference.delivery_selected", {
		inferenceId: r.row.id,
		subjectId: r.row.subject,
		source: delivery.source,
		kind: delivery.emotion ?? delivery.motion,
		...(delivery.reason ? { reason: delivery.reason } : {}),
		durationMs: delivery.latencyMs,
	});
}

/** Chooses the speech delivery before synthesis and applies it to the provider options. */
async function chooseTtsDelivery(
	r: Request,
	args: {
		sent: string;
		decide: ReturnType<typeof decider>;
		callOptions: LarmCallOptions;
		attemptSignal: AbortSignal;
		connection: Connection | undefined;
	},
): Promise<SpeechDelivery> {
	const { env, preparation } = r;
	const p = env.port(r.row.snapshot);
	const delivery =
		preparation?.delivery?.version === 2
			? preparation.delivery
			: await args.decide(
					p.judge!.bind(p),
					args.sent,
					preparation?.context
						? {
								...preparation.context,
								answer:
									env.options.speechText?.(preparation.context.answer) ??
									preparation.context.answer,
							}
						: undefined,
				);
	args.attemptSignal.throwIfAborted();
	logDelivery(r, delivery);
	if (!env.store.read((db) => env.allowed(db, r.row, args.connection)))
		throw new Error("permission_revoked");

	if (delivery.source !== "fallback" && r.row.snapshot.larm.autoIntonation)
		Object.assign(
			args.callOptions,
			speechParameters(delivery, r.row.snapshot.larm),
		);
	return delivery;
}

/** The provider call itself (cloud, or the larm port for the request's purpose). */
function startWork(
	r: Request,
	args: {
		source: Source;
		sent: Input;
		attemptSignal: AbortSignal;
		attemptId: string;
		callOptions: LarmCallOptions;
		delta?: (text: string) => void;
	},
): Promise<string | Uint8Array> {
	const { env, row } = r;
	if (args.source === "codex")
		return env.options.codexResearch!.execute(
			r.input as Messages,
			args.attemptSignal,
		);
	if (args.source === "cloud")
		return cloudRequest(
			{ store: env.store, settings: env.settings, fetch: env.options.fetch },
			row,
			args.sent,
			r.selected!.connection,
			r.selected!.resource,
			args.attemptSignal,
			args.attemptId,
			args.delta,
			args.callOptions,
		);
	const p = env.port(row.snapshot);
	if (row.purpose === "llm") {
		if (args.delta && p.answerStream)
			return p.answerStream(
				r.input as Messages,
				args.attemptSignal,
				args.delta,
				args.callOptions,
			);
		return p
			.answer(r.input as Messages, args.attemptSignal, args.callOptions)
			.then((value) => {
				args.delta?.(value);
				return value;
			});
	}
	if (row.purpose === "asr")
		return p.transcribe(
			r.input as Uint8Array,
			args.attemptSignal,
			args.callOptions,
		);
	return p.speak(args.sent as string, args.attemptSignal, args.callOptions);
}

/** Fence even adapters that ignore cancellation: their late result is never adopted. */
function fenced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		void work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

async function chooseLlmDelivery(
	r: Request,
	decide: ReturnType<typeof decider>,
	value: string,
): Promise<SpeechDelivery> {
	const { env } = r;
	const p = env.port(r.row.snapshot);
	const turns = (r.input as Messages)
		.filter(
			(message): message is { role: "user" | "assistant"; content: string } =>
				message.role !== "system",
		)
		.slice(-4)
		.map(({ role, content }) => ({ role, text: content }));
	const judge =
		env.options.larmFactory || p.status().state !== "unconfigured"
			? p.judge?.bind(p)
			: undefined;
	const delivery = await decide(judge, value, { answer: value, turns });
	logDelivery(r, delivery);
	return delivery;
}

/** What a collected sample records about how the voice parameters were chosen. */
function voiceAdoption(
	r: Request,
	source: Source,
	delivery: SpeechDelivery,
): VoiceAdoption | undefined {
	if (r.row.purpose !== "tts") return undefined;
	if (source !== "larm") return { tone: null, application: "unmeasured" };
	if (!r.row.snapshot.larm.autoIntonation)
		return { tone: null, application: "manual" };
	if (delivery.source !== "fallback")
		return { tone: delivery.tone, application: "preset" };
	return { tone: "natural", application: "baseline" };
}

async function attempt(r: Request, source: Source): Promise<Receipt> {
	const { env, row } = r;
	if (r.signal.aborted) throw new Error("cancelled");
	const connection = source === "cloud" ? r.selected?.connection : undefined;
	r.running.connection = connection;
	if (!env.store.read((db) => env.allowed(db, row, connection)))
		throw new Error("permission_revoked");
	if (
		source === "cloud" &&
		(!r.selected || !r.selected.connection.enabled || !route(r).cloudAllowed)
	)
		throw new Error("cloud_fallback_unconfigured");
	const started = performance.now();
	const attemptId = await recordAttemptStart(r, source);
	const logFields = {
		inferenceId: row.id,
		subjectId: row.subject,
		attemptId,
		purpose: row.purpose,
		source,
	};
	log.info("inference.attempt_started", {
		...logFields,
		reason: r.reason ?? undefined,
	});
	const callOptions = callOptionsFor(r, attemptId);
	const abort = new AbortController();
	const timer = setTimeout(
		() => abort.abort(new DOMException("deadline", "TimeoutError")),
		Math.min(attemptDuration(r, source), Math.max(1, r.deadline - Date.now())),
	);
	const attemptSignal = AbortSignal.any([r.signal, abort.signal]);
	const decide = decider(r, attemptSignal);
	let checkedAt = -1;
	const delta = r.onDelta
		? (text: string) => {
				attemptSignal.throwIfAborted();
				if (row.deadline <= Date.now()) throw new Error("permission_revoked");
				const generation = env.commitGeneration();
				if (generation !== checkedAt) {
					if (!env.store.read((db) => env.allowed(db, row, connection)))
						throw new Error("permission_revoked");
					checkedAt = generation;
				}
				if (text) {
					r.published = true;
					r.onDelta!(text);
				}
			}
		: undefined;
	try {
		// Dictionary rewrites apply to every synthesis path, local and cloud.
		const sent =
			row.purpose === "tts" && env.options.speechText
				? env.options.speechText(r.input as string)
				: r.input;
		let delivery: SpeechDelivery | undefined =
			row.purpose === "tts" && r.preparation?.delivery?.version === 2
				? r.preparation.delivery
				: undefined;
		if (
			row.purpose === "tts" &&
			source === "larm" &&
			env.port(row.snapshot).judge
		)
			delivery = await chooseTtsDelivery(r, {
				sent: sent as string,
				decide,
				callOptions,
				attemptSignal,
				connection,
			});
		const value = await fenced(
			startWork(r, {
				source,
				sent,
				attemptSignal,
				attemptId,
				callOptions,
				delta,
			}),
			attemptSignal,
		);
		if (
			row.purpose === "llm" &&
			row.mode !== "control" &&
			!r.toolCalls?.length &&
			typeof value === "string"
		)
			delivery = await chooseLlmDelivery(r, decide, value);
		if (
			attemptSignal.aborted ||
			!env.store.read((db) => env.allowed(db, row, connection))
		)
			throw new Error("permission_revoked");
		const localModel =
			source === "larm"
				? env
						.port(row.snapshot)
						.inspect?.()
						.providers.find((p) => p.name === row.purpose)?.model
				: undefined;
		await env.store.write((db) =>
			db
				.query(
					"UPDATE inference_attempts SET status='succeeded',ended=?,model=COALESCE(?,model) WHERE id=?",
				)
				.run(Date.now(), localModel ?? null, attemptId),
		);
		log.info("inference.attempt_succeeded", {
			...logFields,
			durationMs: Math.round(performance.now() - started),
		});
		if (env.options.attitudeDataset && r.preparation?.collection && delivery)
			env.collectionAdoptions.set(row.id, {
				identity: r.preparation.collection,
				voice: voiceAdoption(r, source, delivery),
				delivery,
			});
		return {
			requestId: row.id,
			attemptId,
			value,
			...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}),
			...(delivery ? { delivery } : {}),
		};
	} catch (error) {
		const code =
			abort.signal.aborted && !r.signal.aborted
				? "local_timeout"
				: safeError(error, r.signal);
		await env.store.write((db) =>
			db
				.query(
					"UPDATE inference_attempts SET status='failed',reason=?,ended=? WHERE id=?",
				)
				.run(code, Date.now(), attemptId),
		);
		log.warn(
			"inference.attempt_failed",
			{
				...logFields,
				reason: code,
				durationMs: Math.round(performance.now() - started),
			},
			error,
		);
		throw new Error(code);
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}

/** Runs the request: larm first (unless cloud-only), then the cloud fallback when allowed. */
async function runAttempts(r: Request, key: string): Promise<Receipt> {
	const { env, row } = r;
	if (row.controlEngine === "codex_luna") {
		if (
			row.mode !== "control" ||
			row.purpose !== "llm" ||
			!env.options.codexResearch
		)
			throw new Error("codex_research_unavailable");
		return attempt(r, "codex");
	}
	const mode = route(r).mode;
	if (mode !== "cloud-only") {
		if (
			(env.cooldown.get(key) ?? 0) > Date.now() &&
			mode === "larm-preferred" &&
			r.selected &&
			r.selected.connection.enabled &&
			route(r).cloudAllowed
		)
			r.reason = "local_cooldown";
		else
			try {
				const result = await attempt(r, "larm");
				env.cooldown.delete(key);
				return result;
			} catch (error) {
				r.reason = safeError(error, r.signal);
				if (
					r.signal.aborted ||
					r.published ||
					mode === "larm-only" ||
					!fallbackErrors.test(r.reason)
				)
					throw error;
				env.cooldown.set(key, Date.now() + 30_000);
			}
	}
	log.warn("inference.cloud_selected", {
		inferenceId: row.id,
		subjectId: row.subject,
		purpose: row.purpose,
		reason: r.reason ?? "cloud_only",
	});
	return await attempt(r, "cloud");
}

export async function executeRequest(
	env: Env,
	requestId: string,
	input: Input,
	caller: AbortSignal,
	onDelta?: (text: string) => void,
	preparation?: SpeechPreparation,
	tools?: import("../../../infrastructure/chat-stream").NativeTool[],
): Promise<Receipt> {
	caller.throwIfAborted();
	if (env.isClosed()) throw new Error("inference_closed");
	const found = env.store.read((db) => get(db, requestId));
	if (!found) throw new Error("inference_request_missing");
	const row: RequestRow = found;
	if (
		row.purpose === "asr" &&
		(!(input instanceof Uint8Array) ||
			input.length < 44 ||
			input.length > 4_000_000)
	)
		throw new Error("invalid_audio");
	const selected = env.resolve(row);
	const controller = new AbortController();
	const deadline = Math.min(
		row.deadline,
		Date.now() + (row.purpose === "llm" ? 180_000 : 45_000),
	);
	row.deadline = deadline;
	await env.store.write((db) =>
		db
			.query(
				"UPDATE inference_requests SET deadline=MIN(deadline,?) WHERE id=?",
			)
			.run(deadline, row.id),
	);
	const signal = AbortSignal.any([
		caller,
		controller.signal,
		AbortSignal.timeout(Math.max(1, deadline - Date.now())),
	]);
	if (env.active.has(row.id)) throw new Error("inference_request_running");
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const running: Running = { controller, row, done, finish };
	env.active.set(row.id, running);
	env.touch?.();
	const request: Request = {
		env,
		row,
		input,
		caller,
		signal,
		deadline,
		selected,
		running,
		onDelta,
		preparation,
		tools,
		reason: null,
		published: false,
	};
	const routeConfig = row.snapshot.routes[row.purpose];
	const key = `${row.purpose}:${JSON.stringify({ larm: row.snapshot.larm, route: routeConfig, resource: selected?.resource, connection: selected?.connection })}`;
	try {
		return await runAttempts(request, key);
	} catch (error) {
		await env.store.write((db) =>
			db
				.query(
					"UPDATE inference_requests SET status='failed' WHERE id=? AND status='pending'",
				)
				.run(row.id),
		);
		throw error;
	} finally {
		env.active.delete(row.id);
		running.finish();
		env.prune();
		env.touch?.();
	}
}
