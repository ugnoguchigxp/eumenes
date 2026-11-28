import { measureStage, recordStage } from "../../../infrastructure/performance";
import {
	estimateJsonTokens,
	estimateMessageTokens,
} from "../../../infrastructure/context-budget";
import { getLogger } from "../../../infrastructure/logger";
import { modelMessages } from "../../../infrastructure/model-input";
import { speechLanguage, type SpeechLanguage } from "../../delivery";
import type {
	SpeechDelivery,
	SpeechPreparation,
} from "../../delivery/contracts";
import {
	StaleAnswerInput,
	type CallSession,
	type ControlContract,
	type Receipt,
	type SpeechOverride,
} from "../contracts";
import { get, type RequestRow } from "../repository";
import { recordAttemptStart, resolveSession } from "./attempt-record";
import { encodeSections, inputSections, tailSections } from "./input-sections";
import { fallbackErrors, safeError } from "./errors";
import { operationOutputMessages } from "../contracts/operation-output";

import type { Env, Input, Request, Running, Source } from "./execute-types";
import {
	attemptDuration,
	callOptionsFor,
	chooseLlmDelivery,
	deliveryJudgeSkipped,
	chooseTtsDelivery,
	decider,
	fenced,
	route,
	startWork,
	voiceAdoption,
} from "./attempt-work";

const log = getLogger("inference");

async function attempt(
	r: Request,
	source: Source,
	speech?: { text: string; language?: SpeechLanguage },
): Promise<Receipt> {
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
	const attemptId = await recordAttemptStart(env.store, {
		row,
		source,
		selected: r.selected,
		reason: r.reason,
		session: r.session,
	});
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
	if (row.purpose === "llm" && Array.isArray(r.input)) {
		// Where the cached prefix of two calls breaks is read from these: labels, tokens and hashes, never text.
		// A measurement never changes the call: whatever it throws on, nothing is logged and the call goes on.
		try {
			const sections = inputSections({
				messages: r.input,
				tools: r.tools,
				outputSchema:
					r.outputContract?.outputSchema ??
					r.session?.outputSchema ??
					r.control?.outputSchema,
			});
			log.info("inference.input_sections", {
				...logFields,
				conversationId: r.session?.agentSession?.conversationId ?? undefined,
				count: sections.length,
				sections: encodeSections(sections),
			});
			// What the last message is made of (the part that changes with every call), by fixed labels and sizes.
			const tail = tailSections(r.input);
			if (tail.length)
				log.info("inference.input_tail", {
					...logFields,
					conversationId: r.session?.agentSession?.conversationId ?? undefined,
					count: tail.length,
					sections: encodeSections(tail),
				});
		} catch {
			// Nothing is logged for an input that could not be measured.
		}
	}
	const callOptions = callOptionsFor(r, attemptId, source);
	const abort = new AbortController();
	const timer = setTimeout(
		() => abort.abort(new DOMException("deadline", "TimeoutError")),
		Math.min(attemptDuration(r, source), Math.max(1, r.deadline - Date.now())),
	);
	const attemptSignal = AbortSignal.any([r.signal, abort.signal]);
	const decide = decider(r, attemptSignal);
	let checkedAt = -1;
	let providerStarted: number | undefined;
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
					if (providerStarted !== undefined && text.trim()) {
						recordStage(
							"inference",
							"provider_first_delta",
							providerStarted,
							"ok",
							logFields,
						);
						providerStarted = undefined;
					}
					let held: void | false;
					try {
						held = r.onDelta!(text);
					} catch (error) {
						r.deltaRefused = true;
						throw error;
					}
					// A piece the caller refused by throwing, or holds unpublished (`false`), has not gone out.
					if (held !== false) r.published = true;
				}
			}
		: undefined;
	try {
		let language = source === "larm" ? speech?.language : undefined;
		if (language) {
			callOptions.speechLanguage = language;
			log.info("inference.speech_language_selected", {
				...logFields,
				kind: language,
			});
		}
		const sent = speech?.text ?? r.input;
		const prepare = async () => {
			let delivery: SpeechDelivery | undefined =
				row.purpose === "tts" &&
				r.preparation?.delivery?.version === 2 &&
				(r.preparation.deliveryScope !== "chunk" ||
					r.preparation.delivery.source === "host")
					? r.preparation.delivery
					: undefined;
			if (
				row.purpose === "tts" &&
				source === "larm" &&
				(language !== "en" || r.preparation?.deliveryScope === "chunk") &&
				env.port(row.snapshot).judge
			)
				delivery = await chooseTtsDelivery(r, {
					sent: sent as string,
					decide,
					callOptions,
					attemptSignal,
					connection,
				});
			return delivery;
		};
		let delivery = await prepare();
		log.info("inference.prepared", {
			...logFields,
			durationMs: performance.now() - started,
		});
		const provide = () =>
			measureStage(
				"inference",
				"provider",
				() => {
					providerStarted = performance.now();
					return fenced(
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
				},
				logFields,
			);
		let value: Awaited<ReturnType<typeof provide>>;
		try {
			value = await provide();
		} catch (error) {
			// Without an English voice the Japanese voice still speaks the clause.
			if (
				language !== "en" ||
				attemptSignal.aborted ||
				!(error instanceof Error) ||
				error.message !== "speech_tts_target_unavailable"
			)
				throw error;
			log.warn("inference.english_speech_fallback", {
				...logFields,
				reason: error.message,
			});
			language = "ja";
			callOptions.speechLanguage = language;
			delivery = await prepare();
			value = await provide();
		}
		if (
			row.purpose === "llm" &&
			row.mode !== "control" &&
			!r.outputContract &&
			!r.session?.outputSchema &&
			r.preparation?.deliveryScope !== "chunk" &&
			// A reply is judged even beside a tool call (a spoken answer carries its analysis call); a call alone is not.
			typeof value === "string" &&
			value.trim() !== "" &&
			!deliveryJudgeSkipped(r, value)
		)
			delivery = await measureStage(
				"inference",
				"answer_delivery",
				() => chooseLlmDelivery(r, decide, value),
				logFields,
			);
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
						.providers.find(
							(p) =>
								p.name ===
								(callOptions.speechLanguage === "en"
									? "tts-english"
									: row.purpose),
						)?.model
				: undefined;
		// A forget may have revoked the attempt meanwhile: it stays revoked and its receipt is never adopted.
		const finished = await env.store.write(
			(db) =>
				db
					.query(
						"UPDATE inference_attempts SET status='succeeded',ended=?,model=COALESCE(?,model) WHERE id=? AND status='running'",
					)
					.run(Date.now(), localModel ?? null, attemptId).changes,
		);
		if (finished !== 1) throw new Error("permission_revoked");
		log.info("inference.attempt_succeeded", {
			...logFields,
			durationMs: Math.round(performance.now() - started),
		});
		if (env.options.attitudeDataset && r.preparation?.collection && delivery)
			env.collectionAdoptions.set(row.id, {
				identity: r.preparation.collection,
				voice: voiceAdoption(r, source, delivery, language),
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
					"UPDATE inference_attempts SET status='failed',reason=?,ended=? WHERE id=? AND status='running'",
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

/** Whether this request's route lets a call be answered on the cloud: cloud-only, or a usable fallback beside LARM. */
function cloudAnswerAllowed(
	row: RequestRow,
	selected: ReturnType<Env["resolve"]>,
) {
	const routeConfig = row.snapshot.routes[row.purpose];
	return (
		routeConfig.mode === "cloud-only" ||
		(routeConfig.mode === "larm-preferred" &&
			routeConfig.cloudAllowed &&
			!!selected?.connection.enabled)
	);
}

/** Runs the request: larm first (unless cloud-only), then the cloud fallback when allowed. */
async function runAttempts(r: Request): Promise<Receipt> {
	const { env, row, selected } = r;
	const { mode } = route(r);
	// Rewrite speech once, when it reaches the lane, and route by what will actually be spoken.
	const speech =
		row.purpose === "tts" ? prepareSpeech(r, mode !== "cloud-only") : undefined;
	// The two LARM voices have separate cooldowns.
	const key = `${row.purpose}:${JSON.stringify({ larm: row.snapshot.larm, route: row.snapshot.routes[row.purpose], resource: selected?.resource, connection: selected?.connection, voice: speech?.language })}`;
	const cloudTarget = r.session?.target === "cloud";
	if (cloudTarget && mode !== "cloud-only") r.reason = "cloud_requested";
	if (mode !== "cloud-only" && !cloudTarget) {
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
				const result = await attempt(r, "larm", speech);
				env.cooldown.delete(key);
				return result;
			} catch (error) {
				r.reason = safeError(error, r.signal);
				if (
					r.signal.aborted ||
					r.published ||
					r.deltaRefused ||
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
	return await attempt(r, "cloud", speech);
}

function prepareSpeech(r: Request, local: boolean) {
	const original = r.input as string;
	const text = r.env.options.speechText?.(original) ?? original;
	return {
		text,
		language:
			local && r.row.snapshot.larm.englishSpeechEnabled
				? speechLanguage(text)
				: undefined,
	};
}

export async function executeRequest(
	env: Env,
	requestId: string,
	input: Input,
	caller: AbortSignal,
	onDelta?: (text: string) => void | false,
	preparation?: SpeechPreparation,
	tools?: import("../../../infrastructure/chat-stream").NativeTool[],
	control?: ControlContract,
	voiceOverride?: SpeechOverride,
	session?: CallSession,
	outputContract?: ControlContract,
): Promise<Receipt> {
	caller.throwIfAborted();
	if (env.isClosed()) throw new Error("inference_closed");
	const found = env.store.read((db) => get(db, requestId));
	if (!found) throw new Error("inference_request_missing");
	const row: RequestRow = found;
	if (
		outputContract &&
		(row.purpose !== "llm" ||
			!outputContract.outputSchema ||
			typeof outputContract.outputSchema !== "object" ||
			Array.isArray(outputContract.outputSchema))
	)
		throw new Error("invalid_output_contract");
	if (outputContract && Array.isArray(input)) {
		const added = input[0]?.role === "system" ? 0 : 1;
		input = operationOutputMessages(input, outputContract);
		if (added && session?.context)
			session = {
				...session,
				context: {
					...session.context,
					instructionCount: session.context.instructionCount + added,
				},
			};
	}
	if (row.purpose === "llm" && Array.isArray(input)) {
		input = modelMessages(input);
		log.debug("inference.input_measured", {
			requestId,
			kind: "estimated_tokens",
			count: estimateMessageTokens(input),
			bytes: Buffer.byteLength(JSON.stringify(input)),
			messageCount: input.length,
		});
		if (outputContract)
			log.debug("inference.output_contract_measured", {
				requestId,
				kind: "estimated_tokens",
				count: estimateJsonTokens(outputContract.outputSchema),
			});
	}
	if (voiceOverride && row.purpose !== "tts")
		throw new Error("invalid_voice_override");
	const resolvedSession = resolveSession(row, session);
	if (outputContract && resolvedSession?.outputSchema)
		throw new Error("invalid_output_contract");
	// Optional helpers are hidden calls: even partial provider text cannot be published as answer output.
	if (session?.failureScope === "call") onDelta = undefined;
	if (
		row.purpose === "asr" &&
		(!(input instanceof Uint8Array) ||
			input.length < 44 ||
			input.length > 4_000_000)
	)
		throw new Error("invalid_audio");
	const selected = env.resolve(row);
	// A call that must answer on the cloud fails before any attempt when the route allows none.
	if (resolvedSession?.target === "cloud" && !cloudAnswerAllowed(row, selected))
		throw new Error("cloud_fallback_unavailable");
	const controller = new AbortController();
	// A request with its own attempt time (a toolchain's) may run that long; others keep the usual bound.
	const deadline = Math.min(
		row.deadline,
		Date.now() +
			Math.max(row.purpose === "llm" ? 180_000 : 45_000, row.attemptMs ?? 0),
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
	const running: Running = {
		controller,
		row,
		done,
		finish,
		...(resolvedSession?.retainRequest ? { retained: true as const } : {}),
	};
	env.active.set(row.id, running);
	env.touch?.();
	const request: Request = {
		voiceOverride,
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
		...(session?.toolChoice && tools?.length
			? { toolChoice: session.toolChoice }
			: {}),
		...(session?.outputLimit ? { outputLimit: session.outputLimit } : {}),
		control,
		outputContract,
		session: resolvedSession,
		reason: null,
		published: false,
		deltaRefused: false,
	};
	try {
		if (row.purpose !== "tts") return await runAttempts(request);
		return await env.speechLane.run(
			signal,
			() => runAttempts(request),
			(waited, ahead) => {
				if (ahead)
					log.info("inference.speech_lane_waited", {
						inferenceId: row.id,
						subjectId: row.subject,
						durationMs: Math.round(waited),
						count: ahead,
					});
			},
		);
	} catch (error) {
		// Optional auxiliary work shares the answer's authority, but its provider failure is not the answer's
		// terminal state, and a retained call leaves the request for another call. A conversation's call (`main`)
		// that ended cleanly with nothing said ends only that call: the dialogue says what it means (a reply that says
		// nothing more) and settles the request itself. Attempts still record the failure; cancellation/deadline and
		// published output stay terminal.
		const empty =
			resolvedSession?.sessionRole === "main" &&
			error instanceof Error &&
			error.message === "chat_output_empty";
		if (
			resolvedSession?.retainRequest &&
			signal.reason instanceof StaleAnswerInput &&
			// A forget that revoked the call aborts its own controller with that reason; any other abort is final.
			(!controller.signal.aborted ||
				controller.signal.reason instanceof StaleAnswerInput) &&
			Date.now() < deadline
		) {
			// Keep the captured authority for the host's retry. No earlier tool-step receipt may be adopted.
			await env.store.write((db) =>
				db
					.query(
						"UPDATE inference_attempts SET status='revoked',reason='memory_stale' WHERE request_id=? AND status='succeeded' AND accepted=0",
					)
					.run(row.id),
			);
			// A forget revoked the call: the host is told its input is stale, not that the call was cancelled.
			if (controller.signal.aborted) throw signal.reason;
		} else if (
			(session?.failureScope !== "call" &&
				!resolvedSession?.retainRequest &&
				!empty) ||
			signal.aborted ||
			request.published
		)
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
