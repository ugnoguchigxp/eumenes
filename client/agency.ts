import {
	agencyStatusSchema,
	agencyThoughtsSchema,
} from "../api/domains/dialogue/contracts";
import { callJson, type Transport } from "./transport";
import type { AgencyActivity } from "../api/domains/dialogue/contracts/agency-status";

export function agencyClient(t: Transport) {
	const path = (id: string) =>
		`/api/agency/conversations/${encodeURIComponent(id)}`;
	return {
		agencyStatus: (id: string, signal?: AbortSignal) =>
			callJson(t, agencyStatusSchema, `${path(id)}/status`, { signal }),
		agencyThoughts: (id: string, signal?: AbortSignal) =>
			callJson(t, agencyThoughtsSchema, `${path(id)}/thoughts`, { signal }),
		agencyAttention: (
			id: string,
			signal?: AbortSignal,
			activity?: AgencyActivity,
		) =>
			callJson(t, agencyStatusSchema, `${path(id)}/attention`, {
				method: "POST",
				...(activity ? { body: JSON.stringify(activity) } : {}),
				signal,
			}),
	};
}
