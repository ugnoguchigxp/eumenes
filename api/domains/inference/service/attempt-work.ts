import type { VoiceAdoption } from "../../attitude-dataset";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmCallOptions, LarmExchange } from "../../larm";
import { chooseSpeechDelivery, speechParameters } from "../../delivery";
import type {
	DeliveryContext,
	Judge,
	SpeechDelivery,
} from "../../delivery/contracts";
import type { Connection } from "../../settings";
import { controlJsonOptions, type Messages } from "../contracts";
import { cloudRequest } from "./cloud";
import { sessionCallOptions } from "./attempt-record";

import type { Input, Request, Source } from "./execute-types";

const log = getLogger("inference");

export const route = (r: Request) => r.row.snapshot.routes[r.row.purpose];
const deltaFallback = (r: Request) =>
	r.row.purpose === "llm" ? 60_000 : 30_000;

/** How long this attempt may run, leaving room for a cloud fallback when one is possible. */
export function attemptDuration(r: Request, source: Source) {
	const { options } = r.env;
	// A request's own limit (a toolchain's) takes the place of both defaults.
	const cloudMs = r.row.attemptMs ?? options.cloudMs ?? deltaFallback(r);
	const configured =
		source === "cloud"
			? cloudMs
			: (r.row.attemptMs ??
				options.localMs ??
				(r.row.purpose === "llm" ? 120_000 : 15_000));
	const remaining = Math.max(0, r.deadline - Date.now());
	const reserve =
		source === "larm" &&
		route(r).mode === "larm-preferred" &&
		r.selected?.connection.enabled &&
		route(r).cloudAllowed
			? Math.min(cloudMs, remaining)
			: 0;
	return Math.min(configured, Math.max(1, remaining - reserve));
}

/** Provider options and bounded exchange correlation across language, delivery and synthesis. */
export function callOptionsFor(r: Request, attemptId: string): LarmCallOptions {
	const exchanges: LarmExchange[] = [];
	return {
		...(r.voiceOverride ? { speechOverride: r.voiceOverride } : {}),
		...(r.tools?.length
			? {
					tools: r.tools,
					...(r.toolChoice ? { toolChoice: r.toolChoice } : {}),
					...(r.speaks ? { speaks: true as const } : {}),
					onToolCalls: (
						calls: import("../../../infrastructure/chat-stream").NativeToolCall[],
					) => {
						r.toolCalls = calls;
					},
				}
			: {}),
		...(r.outputContract || (r.row.mode === "control" && !r.tools?.length)
			? controlJsonOptions(
					r.outputContract ?? r.control,
					!!r.outputContract || r.row.structuredOutput,
				)
			: {}),
		...(r.outputContract ? { toolOutputFormat: "json-schema" as const } : {}),
		...(r.row.mode === "control" && r.control?.reasoningEffort
			? { reasoningEffort: r.control.reasoningEffort }
			: {}),
		...(r.row.contextPolicy === "exact"
			? { contextPolicy: "exact" as const }
			: {}),
		...(r.row.contextPolicy === "exact" && r.session?.context
			? { history: r.session.context }
			: {}),
		...sessionCallOptions(r.session),
		...(r.row.outputLimit || r.outputLimit
			? {
					maxOutputTokens: Math.min(
						r.row.outputLimit || Infinity,
						r.outputLimit || Infinity,
					),
				}
			: {}),
		...(r.row.attemptMs ? { attemptMs: r.row.attemptMs } : {}),

		onExchange: async (exchange: LarmExchange) => {
			// A call can use the old lease and one replacement. Keep both for correlation.
			if (exchanges.length >= 8) return;
			exchanges.push(exchange);
			await r.env.store.write((db) =>
				db
					.query(
						"UPDATE inference_attempts SET provider_details=?,model=COALESCE(?,model) WHERE id=?",
					)
					.run(
						JSON.stringify(exchanges),
						exchange.operation === "audio/speech" || r.row.purpose !== "tts"
							? exchange.model
							: null,
						attemptId,
					),
			);
		},
	};
}

export function decider(r: Request, attemptSignal: AbortSignal) {
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
export async function chooseTtsDelivery(
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
	// A host delivery holds for every clause of its message; a judged one only answer-wide.
	const delivery =
		preparation?.delivery?.version === 2 &&
		(preparation.deliveryScope !== "chunk" ||
			preparation.delivery.source === "host")
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

	if (
		delivery.source !== "fallback" &&
		r.row.snapshot.larm.autoIntonation !== false &&
		args.callOptions.speechLanguage !== "en"
	)
		Object.assign(
			args.callOptions,
			speechParameters(delivery, {
				...r.row.snapshot.larm,
				...r.voiceOverride,
			}),
		);
	return delivery;
}

/** The provider call itself (cloud, or the larm port for the request's purpose). */
export function startWork(
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
	if (args.source === "cloud")
		return cloudRequest(
			{
				store: env.store,
				settings: env.settings,
				fetch: env.options.fetch,
				agents: env.options.cloudAgents,
			},
			row,
			args.sent,
			r.selected!.connection,
			r.selected!.resource,
			args.attemptSignal,
			args.attemptId,
			args.delta,
			args.callOptions,
			r.session,
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
export function fenced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		void work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

export async function chooseLlmDelivery(
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
export function voiceAdoption(
	r: Request,
	source: Source,
	delivery: SpeechDelivery,
	language?: "ja" | "en",
): VoiceAdoption | undefined {
	if (r.row.purpose !== "tts") return undefined;
	if (source !== "larm" || language === "en")
		return { tone: null, application: "unmeasured" };
	if (r.row.snapshot.larm.autoIntonation === false)
		return { tone: null, application: "manual" };
	if (delivery.source !== "fallback")
		return { tone: delivery.tone, application: "preset" };
	return { tone: "natural", application: "baseline" };
}
