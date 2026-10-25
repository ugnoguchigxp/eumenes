import type { LarmTestTarget } from "../contracts/playground";
import { json, list, str, post, pause } from "./playground-http";
export async function withAgentConnection<T>(
	deps: {
		control: (
			path: string,
			signal: AbortSignal,
			init?: RequestInit,
			accepted?: number[],
		) => Promise<Response>;
		audience: string;
		base: URL;
		publicUrl: (path: string) => URL;
		pollMs?: number;
		ttlSeconds?: number;
		readyMs?: number;
		onConnection?: (
			id: string,
			state: Record<string, unknown>,
		) => Promise<void>;
		onRelease?: (confirmed: boolean) => Promise<void>;
		claimOnReady?: boolean;
	},
	target: LarmTestTarget,
	signal: AbortSignal,
	action: (
		id: string,
		binding: LarmTestTarget,
		readySignal: AbortSignal,
	) => Promise<T>,
): Promise<T> {
	const { control, publicUrl } = deps;
	if (!target.selector) throw new Error("invalid_profile_selector");
	if (
		deps.audience === "same-host" &&
		!["localhost", "127.0.0.1"].includes(deps.base.hostname)
	)
		throw new Error("invalid_larm_audience");
	let id: string | undefined;
	const started = Date.now();
	const readySignal =
		deps.readyMs === undefined
			? signal
			: AbortSignal.any([signal, AbortSignal.timeout(deps.readyMs)]);
	try {
		// Bound POST independently so cancellation still lets us collect/release a late connection ID.
		signal.throwIfAborted();
		const idempotencyKey = crypto.randomUUID(),
			clientId = `eumenes-service-${crypto.randomUUID()}`;
		const create = async () =>
			json(
				await control(
					"/v1/agent-connections",
					AbortSignal.timeout(15_000),
					{
						...post({
							profile: target.selector,
							audience: deps.audience,
							// This call owns its release; a concurrent call must never share its credential.
							client: clientId,
							providers: [target.mode === "provider" ? target.name : "llm"],
							ttlSeconds: deps.ttlSeconds ?? 300,
							allowFallback: false,
							deploymentPolicy: "existing-only",
							expectedCatalogRevision: target.revision,
						}),
						headers: {
							"Content-Type": "application/json",
							"Idempotency-Key": idempotencyKey,
							Prefer: "wait=1",
						},
					},
					target.mode === "service" ? [201, 202, 503] : [201, 202],
				),
			);
		let state;
		try {
			state = await create();
		} catch (error) {
			if (
				!(
					error instanceof TypeError ||
					(error instanceof DOMException && error.name === "TimeoutError")
				)
			)
				throw error;
			state = await create();
		}

		id = str(state.id);
		if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
			throw new Error("invalid_connection_id");
		await deps.onConnection?.(id, state);
		signal.throwIfAborted();
		for (let i = 0; ; i++) {
			if (
				state.id !== id ||
				state.agentProfile !== target.profile ||
				state.catalogRevision !== target.revision
			)
				throw new Error("invalid_connection_contract");
			const service = target.mode === "service";
			const p = list(service ? state.services : state.providers).find(
				(p) => p.name === target.name,
			);
			if (
				!p ||
				p.model !== target.model ||
				p.protocol !== target.protocol ||
				(service &&
					(p.capability !== target.capability ||
						typeof p.description !== "string" ||
						!p.description.trim()))
			)
				throw new Error(
					service ? "invalid_service_binding" : "invalid_provider_binding",
				);
			if (["failed", "expired", "released"].includes(String(state.status)))
				throw new Error(service ? "service_not_ready" : "provider_not_ready");
			// Services start on POST; connection readiness describes the Providers.
			if (
				service
					? ["pending", "probing", "ready"].includes(String(state.status))
					: state.status === "ready" &&
						(deps.claimOnReady ||
							(p.claimable === true && p.readiness === "ready"))
			)
				return await action(
					id,
					service
						? {
								...target,
								endpoint: publicUrl(str(p.url ?? p.endpoint)).pathname,
								description: str(p.description),
							}
						: target,
					readySignal,
				);
			if (service) throw new Error("invalid_connection_contract");
			if (
				(deps.readyMs === undefined && i >= 90) ||
				Date.now() - started >= (deps.readyMs ?? 90_000)
			)
				throw new Error("deadline_exceeded");
			await pause(deps.pollMs ?? 1000, readySignal);
			state = await json(
				await control(
					`/v1/agent-connections/${encodeURIComponent(id)}`,
					readySignal,
				),
			);
		}
	} finally {
		if (id)
			await control(
				`/v1/agent-connections/${encodeURIComponent(id)}`,
				AbortSignal.timeout(10_000),
				{ method: "DELETE" },
				[200, 204, 404],
			)
				.then(async () => {
					await deps.onRelease?.(true);
				})
				.catch(async () => {
					if (deps.onRelease) await deps.onRelease(false);
					else throw new Error("provider_release_unconfirmed");
				});
	}
}
