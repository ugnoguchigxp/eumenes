import type { LarmTestTarget } from "../contracts/playground";
import { json, list, object, pause, post } from "./playground-http";
export type VisualControl = (
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
	accepted?: number[],
) => Promise<Response>;
/** Only claim is retried. The inference POST must remain outside this loop. */
export async function claimVisualProvider(
	control: VisualControl,
	id: string,
	target: LarmTestTarget,
	signal: AbortSignal,
	pollMs = 1000,
) {
	const path = `/v1/agent-connections/${encodeURIComponent(id)}`;
	for (;;) {
		signal.throwIfAborted();
		const response = await control(
			`${path}/claim`,
			signal,
			post({ format: "openai-provider-v1" }),
			[200, 409, 503],
		);
		const body = await json(response);
		if (response.status === 200) return body;
		const error =
			typeof body.error === "string" ? body.error : object(body.error).code;
		if (
			!(
				(response.status === 503 && error === "provider_semantic_not_ready") ||
				(response.status === 409 && error === "connection_not_ready")
			)
		)
			throw new Error(`larm_http_${response.status}`);
		await pause(pollMs, signal);
		// Both retry paths revalidate the owned connection, its binding, and its lifetime.
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
}
