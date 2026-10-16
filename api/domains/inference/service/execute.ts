import { measureStage } from "../../../infrastructure/performance";
import { getLogger } from "../../../infrastructure/logger";
import { speechLanguage, type SpeechLanguage } from "../../delivery";
import type {
	SpeechDelivery,
	SpeechPreparation,
} from "../../delivery/contracts";
import {
	type CallSession,
	type ControlContract,
	type Receipt,
	type SpeechOverride,
} from "../contracts";
import { get, type RequestRow } from "../repository";
import { codexResearchModel } from "./codex-model";
import { recordAttemptStart, resolveSession } from "./attempt-record";
import { fallbackErrors, safeError } from "./errors";
import { CodexResearchFailure } from "../adapters/codex-failure";

import type { Env, Input, Request, Running, Source } from "./execute-types";
import {
	attemptDuration,
	callOptionsFor,
	chooseLlmDelivery,
	chooseTtsDelivery,
	decider,
	fenced,
	route,
	startWork,
	voiceAdoption,
} from "./attempt-work";

const log = getLogger("inference");

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
	const attemptId = await recordAttemptStart(env.store, {
		row,
		source,
		selected: r.selected,
		reason: r.reason,
		session: r.session,
		codexModel: codexResearchModel(row.snapshot),
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
		let language: SpeechLanguage | undefined;
		if (
			row.purpose === "tts" &&
			source === "larm" &&
			row.snapshot.larm.englishSpeechEnabled
		) {
			language = speechLanguage(r.input as string);
			callOptions.speechLanguage = language;
			log.info("inference.speech_language_selected", {
				...logFields,
				kind: language,
			});
		}
		const prepare = async () => {
			// English speech preserves the original words rather than applying a Japanese reading dictionary.
			const sent =
				row.purpose === "tts" && language !== "en" && env.options.speechText
					? env.options.speechText(r.input as string)
					: r.input;
			let delivery: SpeechDelivery | undefined =
				row.purpose === "tts" &&
				r.preparation?.deliveryScope !== "chunk" &&
				r.preparation?.delivery?.version === 2
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
			return { sent, delivery };
		};
		let { sent, delivery } = await prepare();
		log.info("inference.prepared", {
			...logFields,
			durationMs: performance.now() - started,
		});
		const provide = () =>
			measureStage(
				"inference",
				"provider",
				() =>
					fenced(
						startWork(r, {
							source,
							sent,
							attemptSignal,
							attemptId,
							callOptions,
							delta,
						}),
						attemptSignal,
					),
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
			({ sent, delivery } = await prepare());
			value = await provide();
		}
		if (
			row.purpose === "llm" &&
			row.mode !== "control" &&
			r.preparation?.deliveryScope !== "chunk" &&
			!r.toolCalls?.length &&
			typeof value === "string"
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
				...(error instanceof CodexResearchFailure ? error.diagnostic : {}),
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
	if (row.controlEngine === "codex") {
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
	control?: ControlContract,
	voiceOverride?: SpeechOverride,
	session?: CallSession,
): Promise<Receipt> {
	caller.throwIfAborted();
	if (env.isClosed()) throw new Error("inference_closed");
	const found = env.store.read((db) => get(db, requestId));
	if (!found) throw new Error("inference_request_missing");
	const row: RequestRow = found;
	if (voiceOverride && row.purpose !== "tts")
		throw new Error("invalid_voice_override");
	const resolvedSession = resolveSession(row, session);
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
		control,
		session: resolvedSession,
		reason: null,
		published: false,
	};
	const routeConfig = row.snapshot.routes[row.purpose];
	// English and Japanese clauses use separate LARM voices; one voice's outage must not cool down the other.
	const voice =
		row.purpose === "tts" && row.snapshot.larm.englishSpeechEnabled
			? speechLanguage(request.input as string)
			: undefined;
	const key = `${row.purpose}:${JSON.stringify({ larm: row.snapshot.larm, route: routeConfig, resource: selected?.resource, connection: selected?.connection, voice })}`;
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
