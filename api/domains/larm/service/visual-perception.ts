import sharp from "sharp";
import { readBounded } from "../../../infrastructure/bounded-read";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	perceptionOptions,
	perceptionResult,
	type PerceptionPort,
} from "../contracts/visual-perception";
import { createPlaygroundCatalog } from "./playground-catalog";
import { withAgentConnection } from "./provider-connection";
import { claimVisualProvider } from "./visual-claim";
import { observeVisualStop } from "./visual-stop-observation";
import { gzipFetch } from "./gzip-fetch";
import { parseProviderHosts, providerHostAllowed } from "./guards";
import { json, localUrl, object, list, str } from "./playground-http";

export class VisualPerceptionError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}
export function visualError(error: unknown): string {
	if (error instanceof VisualPerceptionError) return error.code;
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "analysis_timeout";
	if (
		error instanceof Error &&
		/^(larm_http_\d{3}|invalid_[a-z_]+|provider_[a-z_]+|stale_catalog|deadline_exceeded|larm_[a-z_]+|analysis_[a-z_]+)$/.test(
			error.message,
		)
	)
		return error.message;
	return "analysis_failed";
}
export function createVisualPerception(config: {
	baseUrl?: string;
	token?: string;
	profile?: string;
	audience: string;
	providerHosts?: readonly string[];
	fetch?: typeof fetch;
	pollMs?: number;
	version?: string;
	stopTimeoutMs?: number;
}): PerceptionPort & {
	discover: (
		signal: AbortSignal,
	) => Promise<import("../contracts/playground").LarmTestTarget>;
} {
	const base = config.baseUrl
		? localUrl(config.baseUrl, [new URL(config.baseUrl).hostname])
		: undefined;
	const request = gzipFetch(config.fetch ?? fetch, false);
	const hosts =
		config.providerHosts ??
		parseProviderHosts(process.env.EUMENES_LARM_PROVIDER_HOSTS);
	async function control(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		accepted = [200],
	) {
		if (!base || !config.token)
			throw new VisualPerceptionError("analysis_unconfigured");
		const url = new URL(path, base);
		if (url.origin !== base.origin || url.username || url.password || url.hash)
			throw new Error("invalid_larm_url");
		const r = await request(url, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${config.token}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
			redirect: "error",
		});
		if (!accepted.includes(r.status)) {
			await r.body?.cancel();
			throw new Error(`larm_http_${r.status}`);
		}
		return r;
	}
	const publicUrl = (path: string) => {
		if (!base) throw new Error("analysis_unconfigured");
		const u = new URL(path, base);
		if (
			u.origin !== base.origin ||
			u.username ||
			u.password ||
			u.hash ||
			u.search
		)
			throw new Error("invalid_larm_url");
		return u;
	};
	const catalog = createPlaygroundCatalog({
		control,
		publicUrl,
		origin: base?.origin ?? "",
		profile: config.profile,
		kinds: {},
		paths: {},
		includeProviderSelectors: true,
	});
	async function discover(signal: AbortSignal) {
		const all = await catalog(signal);
		const target = all.targets.find(
			(t) =>
				t.mode === "provider" &&
				t.selector &&
				t.capability === "vision.perception" &&
				t.protocol === "larm.visual-perception.v1",
		);
		if (!target)
			throw new VisualPerceptionError("analysis_provider_unavailable");
		const c = await json(
			await control(
				`/v3/agent-profiles?profile=${encodeURIComponent(target.selector!)}`,
				signal,
			),
		);
		if (c.catalogRevision !== target.revision) throw new Error("stale_catalog");
		if (!Array.isArray(c.audiences) || !c.audiences.includes(config.audience))
			throw new Error("invalid_larm_audience");
		return target;
	}
	const release = async (id: string) => {
		if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
			throw new Error("invalid_connection_id");
		await control(
			`/v1/agent-connections/${encodeURIComponent(id)}`,
			AbortSignal.timeout(15000),
			{ method: "DELETE" },
			[200, 204, 404],
		);
	};
	return {
		version: () =>
			config.version ??
			sha256Hex(
				JSON.stringify([
					config.baseUrl,
					config.profile,
					config.audience,
					config.token,
					hosts,
				]),
			),
		discover,
		release,
		async perceive(image, options, signal, progress) {
			const started = performance.now();
			const parsed = perceptionOptions.parse(options);
			if (!base) throw new VisualPerceptionError("analysis_unconfigured");
			if (
				!["image/png", "image/jpeg", "image/webp"].includes(image.mime) ||
				image.bytes.length > 4194304 ||
				image.width * image.height > 4194304 ||
				Math.max(image.width, image.height) > 8192
			)
				throw new VisualPerceptionError("analysis_image_too_large");
			const meta = await sharp(image.bytes, {
				limitInputPixels: 4194304,
			}).metadata();
			if (
				meta.width !== image.width ||
				meta.height !== image.height ||
				`image/${meta.format}` !== image.mime
			)
				throw new Error("invalid_visual_image");
			const target = await discover(
				AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			);
			let releaseConfirmed = false;
			let connectionId = "";
			let allocationId: string | undefined;
			const value = await withAgentConnection(
				{
					control,
					publicUrl,
					base,
					audience: config.audience,
					pollMs: config.pollMs,
					ttlSeconds: 600,
					readyMs: 120000,
					claimOnReady: true,
					onConnection: async (id, state) => {
						connectionId = id;
						allocationId =
							typeof state.allocationId === "string"
								? state.allocationId
								: undefined;
						await progress("connection", id);
					},
					onRelease: async (ok) => {
						releaseConfirmed = ok;
						await progress(ok ? "released" : "release_failed");
						const initial = {
							status: ok ? ("observing" as const) : ("unconfirmed" as const),
							connectionId,
							allocationId,
							checkedAt: Date.now(),
							...(!ok ? { reason: "release_unconfirmed" as const } : {}),
						};
						await progress("lifecycle", undefined, initial);
						if (ok) {
							// Cleanup is independent of caller cancellation. Observation cannot hold the queue slot.
							void observeVisualStop(control, initial, {
								timeoutMs: config.stopTimeoutMs,
								pollMs: config.pollMs,
							})
								.then((observation) =>
									progress("lifecycle", undefined, observation),
								)
								.catch(() => {});
						}
					},
				},
				target,
				signal,
				async (id, _binding, readySignal) => {
					const claim = await claimVisualProvider(
						control,
						id,
						target,
						readySignal,
						config.pollMs,
					);
					const p = list(claim.providers).find((v) => v.name === target.name);
					if (
						claim.id !== id ||
						claim.status !== "ready" ||
						!p ||
						p.model !== target.model ||
						p.protocol !== target.protocol ||
						p.apiStyle !== "larm-visual-perception"
					)
						throw new Error("invalid_claim_binding");
					const credential = object(p.credential);
					if (
						credential.type !== "bearer" ||
						!(Date.parse(str(credential.expiresAt)) > Date.now() + 185000)
					)
						throw new Error("invalid_claim_credential");
					const endpoint = localUrl(str(p.endpoint), [
						new URL(str(p.endpoint)).hostname,
					]);
					if (
						!providerHostAllowed(endpoint, base, hosts) ||
						endpoint.pathname !== target.endpoint
					)
						throw new Error("larm_provider_host_mismatch");
					const body = JSON.stringify({
						model: p.model,
						image: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
						...parsed,
					});
					if (Buffer.byteLength(body) > 8 * 1024 * 1024)
						throw new VisualPerceptionError("analysis_image_too_large");
					await progress("running");
					signal.throwIfAborted();
					const waitingMs = performance.now() - started;
					const response = await request(endpoint, {
						method: "POST",
						body,
						headers: {
							Authorization: `Bearer ${str(credential.token)}`,
							"Content-Type": "application/json",
							Accept: "application/json",
						},
						signal: AbortSignal.any([signal, AbortSignal.timeout(185000)]),
						redirect: "error",
					});
					if (response.status !== 200) {
						await response.body?.cancel();
						throw new Error(`larm_http_${response.status}`);
					}
					const bytes = await readBounded(response.body, {
						limit: 12 * 1024 * 1024,
						tooLarge: "invalid_visual_response",
						missing: "invalid_visual_response",
						signal,
					});
					const parsedResult = perceptionResult.safeParse(
						JSON.parse(new TextDecoder().decode(bytes)),
					);
					if (!parsedResult.success) throw new Error("invalid_visual_response");
					const result = parsedResult.data;
					if (
						result.model !== p.model ||
						result.task !== parsed.task ||
						result.image.width !== image.width ||
						result.image.height !== image.height
					)
						throw new Error("invalid_visual_response");
					let maskBytes = 0;
					for (const mask of result.masks) {
						const data = Buffer.from(mask.data, "base64");
						maskBytes += data.length;
						if (data.toString("base64") !== mask.data || maskBytes > 4194304)
							throw new Error("invalid_visual_mask");
						const decoded = await sharp(data, { limitInputPixels: 4194304 })
							.raw()
							.toBuffer({ resolveWithObject: true });
						const metadata = await sharp(data).metadata();
						if (
							metadata.format !== "png" ||
							metadata.depth !== "uchar" ||
							decoded.info.width !== image.width ||
							decoded.info.height !== image.height ||
							(mask.mode === "binary" &&
								decoded.data.some((x) => x !== 0 && x !== 255))
						)
							throw new Error("invalid_visual_mask");
					}
					return {
						result,
						waitingMs,
						inferenceMs: performance.now() - started - waitingMs,
					};
				},
			);
			return {
				...value,
				releaseConfirmed,
				elapsedMs: performance.now() - started,
			};
		},
	};
}
