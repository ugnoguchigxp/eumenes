import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
	createLarm,
	createLarmPlayground,
	silentWav,
} from "../api/domains/larm";
import { speechQuestions, emotionSchema } from "../api/domains/delivery";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((r) => {
		release = r;
	});
	return { promise, release };
}
async function until(condition: () => boolean, signal: AbortSignal) {
	while (!condition()) {
		signal.throwIfAborted();
		await Bun.sleep(10);
	}
}

if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("profile_live_requires_run");
	const saved = liveLarmSettings();
	if (!saved.baseUrl) throw new Error("saved_larm_connection_unconfigured");
	const token = resolveLarmToken(process.env);
	if (!token) throw new Error("larm_credential_unconfigured");
	// The profile is the saved one unless `--profile=<name>` names another.
	const profile =
		process.argv
			.find((arg) => arg.startsWith("--profile="))
			?.slice("--profile=".length) || saved.profile;
	if (!profile) throw new Error("larm_profile_missing");
	const output = resolve(
		`spec/verification/profile-live-${new Date().toISOString().slice(0, 10)}`,
	);
	mkdirSync(output, { recursive: true });
	const report: Record<string, unknown> = {
		date: new Date().toISOString(),
		savedSettingsPreserved: false,
		events: [],
		providers: [],
		responses: [],
	};
	const events = report.events as unknown[];
	const states = new Map<
		string,
		{ status: string; phase: string; profile: string }
	>();
	const inferred: string[] = [],
		completed: string[] = [],
		releases: string[] = [];
	const holds = Array.from({ length: 4 }, gate),
		start = gate();
	let gated = true;
	let claimedModel: string | undefined;
	const config = {
		...saved,
		baseUrl: saved.baseUrl,
		token,
		profile,
	};
	const request = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (gated && url.pathname.endsWith("/chat/completions")) {
				const index = inferred.length;
				const authorization = new Headers(init?.headers).get("Authorization");
				if (!authorization || authorization === `Bearer ${token}`)
					throw new Error("live_provider_credential_missing");
				inferred.push(String(index));
				if (index < 4) await start.promise;
				init?.signal?.throwIfAborted();
				const r = await fetch(input, init);
				if (!r.ok) return r;
				const data = (await r.clone().json()) as {
					model?: string;
					choices?: Array<{
						finish_reason?: string;
						message?: { content?: string };
					}>;
				};
				if (!claimedModel || data.model !== claimedModel)
					throw new Error("live_response_model_mismatch");
				(report.responses as unknown[]).push({
					index,
					model: data.model,
					finishReason: data.choices?.[0]?.finish_reason,
					characters: data.choices?.[0]?.message?.content?.length,
				});
				completed.push(String(index));
				if (index < 4) await holds[index]!.promise;
				return r;
			}
			const r = await fetch(input, init);
			if (url.pathname.startsWith("/v1/agent-connections")) {
				if (init?.method === "DELETE") {
					if ([200, 204, 404, 410].includes(r.status))
						releases.push(url.pathname.split("/")[3]!);
					else
						events.push({
							operation: "release",
							http: r.status,
							confirmed: false,
						});
				} else if (!url.pathname.endsWith("/claim")) {
					const value = (await r.clone().json()) as {
						id?: string;
						status?: string;
						phase?: string;
						profile?: string;
					};
					if (value.id && value.status && value.profile) {
						const previous = states.get(value.id);
						if (
							previous?.status !== value.status ||
							previous?.phase !== value.phase
						)
							events.push({
								id: value.id,
								profile: value.profile,
								status: value.status,
								phase: value.phase,
								http: r.status,
							});
						states.set(value.id, {
							status: value.status,
							phase: value.phase ?? "",
							profile: value.profile,
						});
					}
				}
			}
			return r;
		},
		{ preconnect: fetch.preconnect },
	);
	const main = createLarm({ ...config, fetch: request });
	const work: Promise<string>[] = [];
	const stop = new AbortController();
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180000)]);
	function launch(promise: Promise<string>) {
		work.push(promise);
		void promise.catch((error) => stop.abort(error));
	}
	try {
		await main.probe!(signal);
		claimedModel = main.inspect!().providers.find(
			(p) => p.name === "llm",
		)?.model;
		const markers = Array.from(
			{ length: 5 },
			(_, i) => `SESSION${i}_${crypto.randomUUID().replaceAll("-", "")}`,
		);
		const messages = (i: number) => [
			{
				role: "system" as const,
				content:
					"Reply with only the user's secret identifier, exactly as written. No explanation.",
			},
			{
				role: "user" as const,
				content: `My secret identifier is ${markers[i]}.`,
			},
			{
				role: "assistant" as const,
				content: "I will remember your secret identifier.",
			},
			{ role: "user" as const, content: "What is my secret identifier?" },
		];
		launch(main.answer(messages(0), signal, { maxOutputTokens: 1024 }));
		await until(() => inferred.length === 1, signal);
		for (let i = 1; i < 4; i++)
			launch(
				main.answer(messages(i), signal, {
					sessionRole: "auxiliary",
					maxOutputTokens: 1024,
				}),
			);
		await until(() => inferred.length === 4, signal);
		const ready = [...states.values()].filter((x) => x.status === "ready");
		if (ready.length !== 4 || ready.some((x) => x.profile !== profile))
			throw new Error("live_session_layout_mismatch");
		launch(
			main.answer(messages(4), signal, {
				sessionRole: "auxiliary",
				maxOutputTokens: 1024,
			}),
		);
		await until(
			() => [...states.values()].some((x) => x.phase === "waiting-capacity"),
			signal,
		);
		if (inferred.length !== 4)
			throw new Error("live_waiting_inference_started");
		report.fifthWaitedWithoutInference = true;
		start.release();
		await until(() => completed.length === 4, signal);
		report.fourConcurrentResponses = true;
		holds[1]!.release();
		await work[1];
		await until(() => inferred.length === 5 && completed.length === 5, signal);
		report.fifthUsedReleasedSlot = releases.length >= 1;
		for (const h of holds) h.release();
		const answers = await Promise.all(work);
		const isolated = answers.every(
			(answer, i) =>
				answer.includes(markers[i]!) &&
				markers.every((marker, j) => i === j || !answer.includes(marker)),
		);
		if (!isolated) throw new Error("live_history_isolation_failed");
		report.historiesIsolated = true;
		gated = false;
		await main.prepareVoice!(AbortSignal.timeout(120000));
		const providerResults = report.providers as unknown[];
		const inspect = main.inspect!();
		providerResults.push(
			...inspect.providers.map((p) => ({
				name: p.name,
				model: p.model,
				connected: true,
			})),
		);
		const voiceSignal = AbortSignal.timeout(120000);
		await main.transcribe(silentWav(), voiceSignal);
		for (const [language, text] of [
			["ja", "音声接続を確認します。"],
			["en", "This is a speech connection check."],
		] as const) {
			const audio = await main.speak(text, voiceSignal, {
				speechLanguage: language,
			});
			if (audio.length <= 44) throw new Error("live_audio_empty");
			providerResults.push({ language, bytes: audio.length });
		}
		const judgement = (await main.judge!(
			{ current_chunk: "音声接続を確認します。" },
			speechQuestions,
			voiceSignal,
		)) as {
			claimed_model?: string;
			answers?: { emotion?: { choice?: unknown } };
		};
		if (
			judgement.claimed_model !== main.decisionModel!() ||
			!emotionSchema.safeParse(judgement.answers?.emotion?.choice).success
		)
			throw new Error("live_attitude_invalid");
		providerResults.push({
			name: "system-one",
			model: judgement.claimed_model,
			inferred: true,
		});
		const playground = createLarmPlayground({ ...config, fetch: request });
		const embedding = await playground.embed(
			["接続を確認します。"],
			"query",
			voiceSignal,
		);
		providerResults.push({
			name: "embedding",
			dimensions: embedding.vectors[0]?.length,
			space: embedding.space.modelId,
		});
		report.result = "passed";
	} catch (error) {
		report.result = "failed";
		report.error =
			error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
				? error.message
				: error instanceof DOMException
					? error.name
					: "live_check_failed";
		process.exitCode = 1;
	} finally {
		start.release();
		for (const h of holds) h.release();
		const settled = Promise.allSettled(work);
		await main.close();
		await settled;
		report.createdConnections = states.size;
		report.releasedConnections = new Set(releases).size;
		if (report.releasedConnections !== report.createdConnections) {
			report.result = "failed";
			report.error = "live_release_unconfirmed";
			process.exitCode = 1;
		}
		report.savedSettingsPreserved =
			JSON.stringify(saved) === JSON.stringify(liveLarmSettings());
		writeFileSync(join(output, "live.json"), JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report, null, 2));
	}
}
