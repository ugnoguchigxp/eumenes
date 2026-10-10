import { createHash } from "node:crypto";
import type {
	LarmTestTarget,
	TestHealth,
	TestInput,
	TestOutput,
	TestProgress,
	TestArtifact,
	TestKind,
} from "../contracts/playground";
import { parseProviderHosts, providerHostAllowed } from "./guards";
import {
	bytes,
	code,
	json,
	list,
	localUrl,
	object,
	pause,
	post,
	silentWav,
	str,
} from "./playground-http";

const kinds: Record<string, TestKind> = {
	"openai.chat-completions.v1": "llm",
	"openai.audio-transcriptions.v1": "asr",
	"openai.audio-speech.v1": "tts",
	"larm.embedding.v1": "embedding",
	"larm.system-one.v1": "decision",
	"larm.image-generation.v1": "image",
	"larm.music-generation.v1": "music",
};
const paths: Record<string, string> = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	embedding: "/v1/embed",
	decision: "/v1/systemone",
	image: "/v1/images/generations",
	music: "/v1/music/generations",
};
export function createLarmPlayground(config: {
	/** LARM control origin. There is no default: without it every operation reports larm_base_url_unconfigured. */
	baseUrl?: string;
	/** Extra hosts that may receive provider credentials; defaults to EUMENES_LARM_PROVIDER_HOSTS (read once). */
	providerHosts?: readonly string[];
	token?: string;
	profile: string;
	audience: string;
	voice?: string;
	fetch?: typeof fetch;
	pollMs?: number;
}) {
	const baseText = config.baseUrl?.trim();
	const configuredBase = baseText
		? localUrl(baseText, [new URL(baseText).hostname])
		: undefined;
	const providerHosts =
		config.providerHosts?.map((host) => host.toLowerCase()) ??
		parseProviderHosts(process.env.EUMENES_LARM_PROVIDER_HOSTS);
	const larmBase = () => {
		if (!configuredBase) throw new Error("larm_base_url_unconfigured");
		return configuredBase;
	};
	/** Provider URLs must be local and on the LARM host (or an explicit extra host). */
	const providerUrl = (value: string) => {
		const url = localUrl(value, [new URL(value).hostname]);
		if (!providerHostAllowed(url, larmBase(), providerHosts))
			throw new Error("larm_provider_host_mismatch");
		return url;
	};
	const request = config.fetch ?? fetch;
	function publicUrl(path: string) {
		const base = larmBase();
		const url = new URL(path, base);
		if (
			url.origin !== base.origin ||
			url.username ||
			url.password ||
			url.hash ||
			url.search
		)
			throw new Error("invalid_artifact_origin");
		return url;
	}
	async function control(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted = [200],
	) {
		const base = larmBase();
		if (!config.token) throw new Error("larm_unconfigured");
		signal.throwIfAborted();
		const url = new URL(path, base);
		if (url.origin !== base.origin || url.username || url.password || url.hash)
			throw new Error("invalid_larm_url");
		const r = await request(url, {
			...init,
			redirect: "error",
			signal,
			headers: { Authorization: `Bearer ${config.token}`, ...init.headers },
		});
		if (!accepted.includes(r.status)) {
			await r.body?.cancel();
			throw new Error(`larm_http_${r.status}`);
		}
		return r;
	}
	async function catalog(signal: AbortSignal) {
		const targets = new Map<string, LarmTestTarget>();
		const errors: string[] = [];
		let revision: string | undefined;
		for (const selector of [
			config.profile,
			"SAAA-w-Image",
			"SAAA-w-music",
			"",
		]) {
			try {
				const data = await json(
					await control(
						`/v3/agent-profiles${selector ? `?profile=${encodeURIComponent(selector)}` : ""}`,
						signal,
					),
				);
				if (
					data.contractVersion !== "agent-connection.v3" ||
					(selector && data.requestedProfile !== selector)
				)
					throw new Error("invalid_catalog");
				const rev = str(data.catalogRevision);
				if (revision && revision !== rev) throw new Error("stale_catalog");
				revision = rev;
				for (const p of list(data.profiles))
					for (const mode of ["provider", "service"] as const)
						for (const item of list(
							p[mode === "provider" ? "providers" : "services"] ?? [],
						)) {
							const protocol = str(item.protocol),
								endpoint = str(item.endpoint),
								model = str(item.model),
								name = str(item.name),
								profile = str(p.id);
							const kind = kinds[protocol] ?? "unsupported";
							const id = createHash("sha256")
								.update(
									JSON.stringify([
										larmBase().origin,
										mode,
										profile,
										name,
										protocol,
										model,
										endpoint,
									]),
								)
								.digest("hex")
								.slice(0, 32);
							const previous = targets.get(id);
							targets.set(id, {
								id,
								name,
								model,
								capability: str(item.capability),
								protocol,
								kind: paths[kind] === endpoint ? kind : "unsupported",
								mode,
								endpoint:
									mode === "service"
										? publicUrl(str(item.url ?? endpoint)).pathname
										: endpoint,
								profile,
								selector: previous?.selector ?? (selector || undefined),
								revision: rev,
								onDemand:
									mode === "service" &&
									object(item.startupPolicy ?? {}).minWarmInstances === 0,
								primary: previous?.primary || !!selector,
							});
						}
			} catch (e) {
				if (code(e) === "stale_catalog") throw e;
				errors.push(`${selector || "all"}: ${code(e)}`);
			}
		}
		return { targets: [...targets.values()], errors, discoveredAt: Date.now() };
	}
	async function connection<T>(
		target: LarmTestTarget,
		signal: AbortSignal,
		action: (id: string) => Promise<T>,
	): Promise<T> {
		if (!target.selector) throw new Error("invalid_profile_selector");
		if (
			config.audience === "same-host" &&
			!["localhost", "127.0.0.1"].includes(larmBase().hostname)
		)
			throw new Error("invalid_larm_audience");
		let id: string | undefined;
		try {
			// Bound POST independently so cancellation still lets us collect/release a late connection ID.
			signal.throwIfAborted();
			let state = await json(
				await control(
					"/v1/agent-connections",
					AbortSignal.timeout(15_000),
					{
						...post({
							profile: target.selector,
							audience: config.audience,
							client: "eumenes-service-tests",
							providers: [target.name],
							ttlSeconds: 300,
							allowFallback: false,
							deploymentPolicy: "existing-only",
							expectedCatalogRevision: target.revision,
						}),
						headers: {
							"Content-Type": "application/json",
							"Idempotency-Key": crypto.randomUUID(),
							Prefer: "wait=1",
						},
					},
					[201, 202],
				),
			);
			id = str(state.id);
			signal.throwIfAborted();
			for (let i = 0; ; i++) {
				if (
					state.id !== id ||
					state.agentProfile !== target.profile ||
					state.catalogRevision !== target.revision
				)
					throw new Error("invalid_connection_contract");
				const p = list(state.providers).find((p) => p.name === target.name);
				if (!p || p.model !== target.model || p.protocol !== target.protocol)
					throw new Error("invalid_provider_binding");
				if (
					state.status === "ready" &&
					p.claimable === true &&
					p.readiness === "ready"
				)
					break;
				if (["failed", "expired", "released"].includes(String(state.status)))
					throw new Error("provider_not_ready");
				if (i >= 90) throw new Error("deadline_exceeded");
				await pause(config.pollMs ?? 1000, signal);
				state = await json(
					await control(
						`/v1/agent-connections/${encodeURIComponent(id)}`,
						signal,
					),
				);
			}
			return await action(id);
		} finally {
			if (id)
				await control(
					`/v1/agent-connections/${encodeURIComponent(id)}`,
					AbortSignal.timeout(10_000),
					{ method: "DELETE" },
					[200, 204, 404],
				).catch(() => {
					throw new Error("provider_release_unconfirmed");
				});
		}
	}
	async function health(
		target: LarmTestTarget,
		signal: AbortSignal,
	): Promise<TestHealth> {
		const checkedAt = Date.now();
		try {
			if (target.mode === "service")
				return {
					state: target.onDemand ? "on-demand" : "unknown",
					reason: "health_api_unavailable",
					checkedAt,
				};
			if (!target.selector || target.kind === "unsupported")
				return {
					state: "unsupported",
					reason: "unsupported_protocol",
					checkedAt,
				};
			return await connection(target, signal, async (id) => {
				const h = await json(
					await control(
						`/v1/agent-connections/${encodeURIComponent(id)}/providers/${encodeURIComponent(target.name)}/health`,
						signal,
						{},
						[200, 503],
					),
				);
				if (
					h.name !== target.name ||
					h.capability !== target.capability ||
					typeof h.ready !== "boolean" ||
					typeof h.acceptingRequests !== "boolean"
				)
					throw new Error("invalid_health_response");
				const reasons = [
					"connection_not_ready",
					"allocation_inactive",
					"stale_state",
					"binding_changed",
					"provider_busy",
					"probe_timeout",
					"upstream_status",
					"provider_contract_mismatch",
					"invalid_response",
				];
				return {
					state:
						h.ready && h.acceptingRequests
							? "healthy"
							: h.reason === "provider_busy"
								? "busy"
								: "unhealthy",
					reason:
						h.ready && h.acceptingRequests
							? "semantic_health_ok"
							: reasons.includes(String(h.reason))
								? String(h.reason)
								: "provider_not_ready",
					checkedAt: Date.now(),
					latencyMs: Date.now() - checkedAt,
				};
			});
		} catch (e) {
			return { state: "unknown", reason: code(e), checkedAt: Date.now() };
		}
	}
	async function artifact(
		ref: TestArtifact,
		signal: AbortSignal,
	): Promise<TestOutput> {
		const url = publicUrl(ref.path);
		if (!/^\/v1\/(image-artifacts|music\/generations)\//.test(url.pathname))
			throw new Error("invalid_artifact_path");
		const r = await control(url.pathname, signal);
		const mime = r.headers.get("content-type")?.split(";")[0] ?? "";
		if (
			![
				"image/png",
				"image/webp",
				"audio/mpeg",
				"audio/wav",
				"audio/x-wav",
				"audio/flac",
			].includes(mime) ||
			(ref.mime && mime !== ref.mime)
		) {
			await r.body?.cancel();
			throw new Error("invalid_artifact_type");
		}
		const content = await bytes(
			r,
			mime.startsWith("image/") ? 32_000_000 : 128_000_000,
		);
		if (!content.length) throw new Error("invalid_artifact_empty");
		const tag = (start: number, end: number) =>
			new TextDecoder().decode(content.slice(start, end));
		if (
			(mime === "image/png" &&
				![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => content[i] === n)) ||
			(mime === "image/webp" &&
				(tag(0, 4) !== "RIFF" || tag(8, 12) !== "WEBP")) ||
			(["audio/wav", "audio/x-wav"].includes(mime) &&
				(tag(0, 4) !== "RIFF" || tag(8, 12) !== "WAVE")) ||
			(mime === "audio/flac" && tag(0, 4) !== "fLaC") ||
			(mime === "audio/mpeg" &&
				tag(0, 3) !== "ID3" &&
				!(content[0] === 255 && ((content[1] ?? 0) & 224) === 224))
		)
			throw new Error("invalid_artifact_content");
		return {
			bytes: content,
			mime,
			artifact: ref,
			actualModel: ref.actualModel,
		};
	}
	async function musicJob(
		target: LarmTestTarget,
		jobId: string,
		signal: AbortSignal,
		progress: (p: TestProgress) => Promise<void>,
	): Promise<TestOutput> {
		const path = `${target.endpoint}/${encodeURIComponent(jobId)}`;
		try {
			for (;;) {
				const j = await json(await control(path, signal));
				if (j.jobId !== jobId) throw new Error("invalid_job_id");
				const phase = str(j.status);
				if (
					![
						"queued",
						"loading",
						"generating",
						"encoding",
						"completed",
						"failed",
						"cancelled",
					].includes(phase)
				)
					throw new Error("invalid_job_status");
				await progress({
					phase,
					jobId,
					progress:
						typeof j.progress === "number" && j.progress >= 0 && j.progress <= 1
							? j.progress
							: undefined,
				});
				if (phase === "failed") throw new Error("provider_generation_failed");
				if (phase === "cancelled") throw new Error("provider_cancelled");
				if (phase === "completed") {
					const result = object(j.result);
					// Catalog IDs and runtime model IDs can differ. Display both.
					const actualModel = str(result.model);
					const metadataUrl = publicUrl(str(result.metadataUrl));
					if (!metadataUrl.pathname.startsWith(`${path}/`))
						throw new Error("invalid_artifact_path");
					const metadata = await json(
						await control(metadataUrl.pathname, signal),
					);
					if (metadata.id !== result.id) throw new Error("invalid_artifact_id");
					const ref = {
						id: str(result.id),
						path: str(result.audioUrl),
						mime:
							result.format === "mp3"
								? "audio/mpeg"
								: result.format === "flac"
									? "audio/flac"
									: "audio/wav",
						actualModel,
					};
					if (publicUrl(ref.path).pathname !== `${path}/audio`)
						throw new Error("invalid_artifact_path");
					await progress({ phase: "fetching-result", jobId, artifact: ref });
					return await artifact(ref, signal);
				}
				await pause(config.pollMs ?? 2000, signal);
			}
		} catch (e) {
			if (signal.aborted) {
				const stopped = await json(
					await control(path, AbortSignal.timeout(10_000), {
						method: "DELETE",
					}),
				).catch(() => null);
				if (stopped?.status !== "cancelled")
					throw new Error("cancel_unconfirmed");
			}
			throw e;
		}
	}
	async function execute(
		target: LarmTestTarget,
		input: TestInput,
		signal: AbortSignal,
		progress: (p: TestProgress) => Promise<void>,
	): Promise<TestOutput> {
		if (target.kind === "unsupported")
			throw new Error("invalid_unsupported_service");
		if (target.mode === "service") {
			await progress({ phase: "generating" });
			signal.throwIfAborted();
			if (target.kind === "image") {
				let data: Record<string, unknown>;
				try {
					data = await json(
						await control(
							target.endpoint,
							signal,
							post({
								prompt: input.text,
								model: target.model,
								width: input.width ?? 512,
								height: input.height ?? 512,
								format: input.format ?? "webp",
								seed: input.seed ?? 0,
							}),
						),
					);
				} catch (e) {
					if (
						signal.aborted ||
						["network_unavailable", "deadline_exceeded"].includes(code(e))
					)
						throw new Error("generation_unknown");
					throw e;
				}
				if (data.status !== "succeeded")
					throw new Error("invalid_image_result");
				const a = object(data.artifact ?? list(data.artifacts)[0]);
				const ref = {
					id: str(a.id),
					path: str(a.contentUrl),
					mime: str(a.mimeType),
					actualModel: a.model === undefined ? undefined : str(a.model),
				};
				if (
					publicUrl(ref.path).pathname !==
					`/v1/image-artifacts/${encodeURIComponent(ref.id)}/content`
				)
					throw new Error("invalid_artifact_path");
				await progress({ phase: "fetching-result", artifact: ref });
				return artifact(ref, signal);
			}
			if (target.kind !== "music")
				throw new Error("invalid_unsupported_service");
			// Collect a late 202 even after local cancellation, then send DELETE to the same job.
			let j: Record<string, unknown>;
			try {
				j = await json(
					await control(
						target.endpoint,
						AbortSignal.timeout(60_000),
						post({
							prompt: input.text,
							model: target.model,
							durationSeconds: input.durationSeconds ?? 10,
							instrumental: true,
							outputFormat: "mp3",
							quality: "balanced",
						}),
						[202],
					),
				);
			} catch (e) {
				if (/^larm_http_(400|401|403|404|409|422|429)$/.test(code(e))) throw e;
				throw new Error("generation_unknown");
			}
			const jobId = str(j.jobId);
			await progress({ phase: "queued", jobId });
			return musicJob(target, jobId, signal, progress);
		}
		return connection(target, signal, async (id) => {
			const claim = await json(
				await control(
					`/v1/agent-connections/${encodeURIComponent(id)}/claim`,
					signal,
					post({
						format:
							target.kind === "embedding"
								? "larm-embedding-provider-v1"
								: "openai-provider-v1",
					}),
				),
			);
			if (
				claim.id !== id ||
				claim.status !== "ready" ||
				Date.parse(str(claim.expiresAt)) < Date.now() + 10_000
			)
				throw new Error("invalid_claim");
			const p = list(claim.providers).find((x) => x.name === target.name);
			if (!p || p.model !== target.model || p.protocol !== target.protocol)
				throw new Error("invalid_claim_binding");
			const fields = object(object(p.configuration).fields),
				credential = object(p.credential);
			if (
				fields.model !== target.model ||
				credential.type !== "bearer" ||
				!(Date.parse(str(credential.expiresAt)) > Date.now() + 10_000)
			)
				throw new Error("invalid_claim_configuration");
			const providerBase = providerUrl(str(fields.baseURL ?? fields.daemonURL));
			if (providerBase.href !== providerUrl(str(p.baseUrl)).href)
				throw new Error("invalid_claim_configuration");
			const endpoint = new URL(
				target.endpoint.replace(/^\/v1\//, ""),
				`${providerBase.href.replace(/\/$/, "")}/`,
			);
			if (
				p.endpoint !== undefined &&
				providerUrl(str(p.endpoint)).href !== endpoint.href
			)
				throw new Error("invalid_claim_endpoint");
			const infer = (init: RequestInit) =>
				request(endpoint, {
					...init,
					redirect: "error",
					signal,
					headers: {
						...init.headers,
						Authorization: `Bearer ${str(credential.token)}`,
					},
				});
			let body: unknown;
			switch (target.kind) {
				case "llm":
					body = {
						model: target.model,
						messages: [{ role: "user", content: input.text }],
						max_tokens: 128,
						stream: false,
					};
					break;
				case "tts": {
					let voice =
						input.voice ||
						config.voice ||
						(typeof fields.voice === "string" ? fields.voice : "");
					if (!voice) {
						// Voice discovery uses the control API, not the scoped inference credential.
						const r = await control(
							`/v1/audio/voices?model=${encodeURIComponent(target.model)}`,
							signal,
						);
						voice = str((await json(r)).default_voice);
					}
					body = {
						model: target.model,
						input: input.text,
						voice,
						response_format: "wav",
					};
					break;
				}
				case "embedding":
					body = {
						texts: [input.text, input.comparison || input.text],
						type: "query",
						normalize: true,
						priority: "low",
					};
					break;
				case "decision":
					body = {
						model: target.model,
						state: { utterance: input.text },
						questions: {
							intent: {
								type: "choice",
								instructions: "発話が質問か挨拶かを選んでください。",
								criteria: { question: "質問や依頼", greeting: "挨拶" },
							},
						},
					};
					break;
				case "asr":
					break;
				default:
					throw new Error("invalid_unsupported_service");
			}
			let init = post(body);
			if (target.kind === "asr") {
				const form = new FormData();
				form.append("model", target.model);
				form.append("response_format", "json");
				form.append(
					"file",
					new Blob([new Uint8Array(input.audio ?? silentWav())], {
						type: "audio/wav",
					}),
					"sample.wav",
				);
				init = { method: "POST", body: form };
			}
			await progress({ phase: "running" });
			const r = await infer(init);
			if (!r.ok) {
				await r.body?.cancel();
				throw new Error(`larm_http_${r.status}`);
			}
			if (target.kind === "tts") {
				const b = await bytes(r, 16_000_000);
				if (
					new TextDecoder().decode(b.slice(0, 4)) !== "RIFF" ||
					new TextDecoder().decode(b.slice(8, 12)) !== "WAVE"
				)
					throw new Error("invalid_audio_result");
				return { bytes: b, mime: "audio/wav", text: input.text };
			}
			const data = await json(r);
			if (target.kind === "asr") {
				if (typeof data.text !== "string")
					throw new Error("invalid_asr_result");
				return {
					text:
						data.text ||
						"（認識した発話はありません。無音サンプルでは正常です。）",
				};
			}
			if (target.kind === "llm")
				return { text: str(object(list(data.choices)[0]?.message).content) };
			if (target.kind === "decision") {
				if (data.model !== target.model)
					throw new Error("invalid_result_model");
				const a = object(object(data.answers).intent);
				if (!["question", "greeting"].includes(String(a.choice)))
					throw new Error("invalid_decision_result");
				return {
					text: `判定: ${a.choice === "question" ? "質問・依頼" : "挨拶"}`,
				};
			}
			const vectors = data.embeddings;
			if (
				!Array.isArray(vectors) ||
				vectors.length !== 2 ||
				!vectors.every(
					(v) =>
						Array.isArray(v) &&
						v.length === data.dimension &&
						v.every((n) => typeof n === "number" && Number.isFinite(n)),
				)
			)
				throw new Error("invalid_embedding_result");
			const a = vectors[0] as number[],
				b = vectors[1] as number[];
			const norm = Math.sqrt(
				a.reduce((s, n) => s + n * n, 0) * b.reduce((s, n) => s + n * n, 0),
			);
			if (!norm) throw new Error("invalid_embedding_result");
			return {
				text: `次元数: ${data.dimension}\n類似度: ${(a.reduce((s, n, i) => s + n * b[i]!, 0) / norm).toFixed(4)}\n類似度は参考値です。`,
			};
		});
	}
	return {
		catalog,
		health,
		execute,
		artifact,
		musicJob,
		controlHealth: async (signal: AbortSignal) => {
			const h = await json(await control("/health", signal));
			return h.status === "ok";
		},
	};
}
export type LarmPlayground = ReturnType<typeof createLarmPlayground>;
