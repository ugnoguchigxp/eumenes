import { readBounded } from "../../../infrastructure/bounded-read";
import { doclingPrepared, type DoclingConnection } from "../contracts";

export type DoclingFetch = (url: URL, init: RequestInit) => Promise<Response>;

export function createDocling(deps: {
	connection: () => DoclingConnection | null;
	status: () => {
		revision: number;
		configured: boolean;
		publicOrigin: string | null;
	};
	fetch?: DoclingFetch;
	timeoutMs?: number;
}) {
	let opening = false;
	const fetcher = deps.fetch ?? fetch;
	const service = {
		status: deps.status,
		/** The conversation tool only returns the artifact; its Web adapter requests startup. */
		prepare: () =>
			doclingPrepared.parse({ action: "open", state: "ready_for_open" }),
		async ready(signal: AbortSignal): Promise<ReturnType<typeof deps.status>> {
			const connection = deps.connection();
			if (!connection) throw new Error("docling_unconfigured");
			// Reuse the gateway's startup wait, discarding its one-time ticket here.
			await service.ticket(signal);
			if (signal.aborted) throw new Error("docling_cancelled");
			if (deps.connection()?.version !== connection.version)
				throw new Error("docling_connection_changed");
			return {
				revision: connection.revision,
				configured: true,
				publicOrigin: connection.publicOrigin,
			};
		},
		async ticket(callerSignal: AbortSignal) {
			if (opening) throw new Error("docling_open_in_progress");
			const connection = deps.connection();
			if (!connection) throw new Error("docling_unconfigured");
			opening = true;
			const signal = AbortSignal.any([
				callerSignal,
				AbortSignal.timeout(deps.timeoutMs ?? 190_000),
			]);
			try {
				signal.throwIfAborted();
				const response = await fetcher(
					new URL("/auth/ui-tickets", connection.gatewayUrl),
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${connection.credential}`,
							Host: "127.0.0.1:28765",
						},
						redirect: "manual",
						signal,
					},
				);
				if (response.status !== 200) {
					await response.body?.cancel();
					throw new Error(
						[401, 403].includes(response.status)
							? "docling_auth_failed"
							: "docling_upstream_failed",
					);
				}
				const receivedAt = Date.now();
				const bytes = await readBounded(response.body, {
					limit: 8192,
					missing: "docling_invalid_response",
					tooLarge: "docling_invalid_response",
					signal,
				});
				let data: unknown;
				try {
					data = JSON.parse(new TextDecoder().decode(bytes));
				} catch {
					throw new Error("docling_invalid_response");
				}
				if (
					!data ||
					typeof data !== "object" ||
					!("url" in data) ||
					typeof data.url !== "string" ||
					!("expires_in" in data) ||
					!Number.isInteger(data.expires_in) ||
					Number(data.expires_in) < 1 ||
					Number(data.expires_in) > 60 ||
					!data.url.startsWith("/auth/exchange?")
				)
					throw new Error("docling_invalid_response");
				const url = new URL(data.url, connection.publicOrigin);
				const keys = [...url.searchParams.keys()];
				const ticket = url.searchParams.get("ticket");
				if (
					url.origin !== new URL(connection.publicOrigin).origin ||
					url.pathname !== "/auth/exchange" ||
					url.hash ||
					url.username ||
					url.password ||
					keys.length !== 1 ||
					keys[0] !== "ticket" ||
					!ticket ||
					!/^[A-Za-z0-9_-]{20,128}$/.test(ticket)
				)
					throw new Error("docling_invalid_response");
				signal.throwIfAborted();
				if (deps.connection()?.version !== connection.version)
					throw new Error("docling_connection_changed");
				const expiresIn =
					Number(data.expires_in) - Math.ceil((Date.now() - receivedAt) / 1000);
				if (expiresIn < 1) throw new Error("docling_invalid_response");
				return { url: url.href, expiresIn };
			} catch (error) {
				// Never propagate fetch errors, upstream bodies or URLs: they can contain credentials.
				if (callerSignal.aborted) throw new Error("docling_cancelled");
				if (signal.aborted) throw new Error("docling_timeout");
				if (
					error instanceof Error &&
					[
						"docling_auth_failed",
						"docling_upstream_failed",
						"docling_invalid_response",
						"docling_connection_changed",
					].includes(error.message)
				)
					throw new Error(error.message);
				throw new Error("docling_unreachable");
			} finally {
				opening = false;
			}
		},
	};
	return service;
}
export type DoclingService = ReturnType<typeof createDocling>;
