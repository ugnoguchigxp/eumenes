import { doclingStatus, doclingTicket } from "../api/domains/docling/contracts";
import { callJson, type Transport } from "./transport";

export function doclingClient(t: Transport) {
	return {
		doclingStatus: (signal?: AbortSignal) =>
			callJson(t, doclingStatus, "/api/docling/status", { signal }),
		doclingReady: (signal: AbortSignal) =>
			callJson(t, doclingStatus, "/api/docling/ready", {
				method: "POST",
				signal,
			}),
		/** Ephemeral authentication response: never put into a query cache, outbox or history. */
		doclingTicket: (signal: AbortSignal) =>
			callJson(t, doclingTicket, "/api/docling/ui-tickets", {
				method: "POST",
				signal,
			}),
	};
}
