import {
	claimDetailSchema,
	claimListSchema,
	forgetListSchema,
	worldClaimsStatusSchema,
} from "../api/domains/world/contracts/view";
import { callJson, withQuery, type Transport } from "./transport";

export function worldClient(t: Transport) {
	return {
		/** 404 (ApiError) means World is not configured in this build/run. */
		worldStatus: (signal?: AbortSignal) =>
			callJson(t, worldClaimsStatusSchema, "/api/world/status", { signal }),
		worldClaims: (scopeKey?: string, signal?: AbortSignal) =>
			callJson(
				t,
				claimListSchema,
				withQuery("/api/world/claims", { scopeKey }),
				{
					signal,
				},
			),
		worldClaim: (id: string, scopeKey?: string, signal?: AbortSignal) =>
			callJson(
				t,
				claimDetailSchema,
				withQuery(`/api/world/claims/${encodeURIComponent(id)}`, { scopeKey }),
				{ signal },
			),
		worldForgets: (scopeKey?: string, signal?: AbortSignal) =>
			callJson(
				t,
				forgetListSchema,
				withQuery("/api/world/forgets", { scopeKey }),
				{ signal },
			),
	};
}
