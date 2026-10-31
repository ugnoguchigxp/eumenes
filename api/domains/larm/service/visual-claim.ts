import type { LarmTestTarget } from "../contracts/playground";
import { json, list, object, pause, post } from "./playground-http";
import { capacityRefusal, claimWhenReady } from "./resend";
export type VisualControl = (
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
	accepted?: number[],
) => Promise<Response>;
/** Only claim is sent again (the not-ready rule). The inference POST must remain outside it. */
export async function claimVisualProvider(
	control: VisualControl,
	id: string,
	target: LarmTestTarget,
	signal: AbortSignal,
	pollMs = 1000,
) {
	const path = `/v1/agent-connections/${encodeURIComponent(id)}`;
	return claimWhenReady(
		async () => {
			signal.throwIfAborted();
			const response = await control(
				`${path}/claim`,
				signal,
				post({ format: "openai-provider-v1" }),
				[200, 409, 503],
			);
			const body = await json(response);
			if (response.status === 200) return body;
			const busy = capacityRefusal(
				response.status,
				body,
				response.headers,
				`${path}/claim`,
			);
			if (busy) throw busy;
			const error =
				typeof body.error === "string" ? body.error : object(body.error).code;
			if (
				!(
					(response.status === 503 &&
						error === "provider_semantic_not_ready") ||
					(response.status === 409 && error === "connection_not_ready")
				)
			)
				throw new Error(`larm_http_${response.status}`);
			return null;
		},
		() => untilConnectionReady(control, path, id, target, signal, pollMs),
	);
}

/** Between claims, revalidate the owned connection, its binding and its lifetime until it is ready. */
async function untilConnectionReady(
	control: VisualControl,
	path: string,
	id: string,
	target: LarmTestTarget,
	signal: AbortSignal,
	pollMs: number,
) {
	await pause(pollMs, signal);
	for (;;) {
		const state = await json(
			await control(path, signal, { cache: "no-store" }),
		);
		const p = list(state.providers).find((v) => v.name === target.name);
		if (
			state.id !== id ||
			state.agentProfile !== target.profile ||
			state.catalogRevision !== target.revision ||
			!p ||
			p.model !== target.model ||
			p.protocol !== target.protocol
		)
			throw new Error("invalid_provider_binding");
		if (
			["failed", "released", "expired"].includes(String(state.status)) ||
			(typeof state.expiresAt === "string" &&
				Date.parse(state.expiresAt) <= Date.now())
		)
			throw new Error("provider_not_ready");
		if (state.status === "ready") break;
		if (!["pending", "probing"].includes(String(state.status)))
			throw new Error("invalid_connection_contract");
		await pause(pollMs, signal);
	}
}
