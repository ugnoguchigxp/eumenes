import type { z } from "zod";
import {
	claimChangeSchema,
	claimDetailSchema,
	claimListSchema,
	forgetAcceptedSchema,
	forgetListSchema,
	worldClaimsStatusSchema,
	type CorrectClaim,
	type ForgetClaim,
	type RetractClaim,
} from "../api/domains/world/contracts";
import { json, type Transport } from "./transport";

export function worldClient(t: Transport) {
	const read = async <S extends z.ZodType>(
		schema: S,
		path: string,
		signal?: AbortSignal,
	): Promise<z.infer<S>> =>
		schema.parse(await (await t.call(path, { signal })).json());
	const post = async <S extends z.ZodType>(
		schema: S,
		path: string,
		body: unknown,
	): Promise<z.infer<S>> =>
		schema.parse(await (await t.call(path, json(body))).json());
	const scoped = (path: string, scopeKey?: string) =>
		scopeKey === undefined
			? path
			: `${path}${path.includes("?") ? "&" : "?"}scopeKey=${encodeURIComponent(scopeKey)}`;
	return {
		/** 404 (ApiError) means World is not configured in this build/run. */
		worldStatus: (signal?: AbortSignal) =>
			read(worldClaimsStatusSchema, "/api/world/status", signal),
		worldClaims: (scopeKey?: string, signal?: AbortSignal) =>
			read(claimListSchema, scoped("/api/world/claims", scopeKey), signal),
		worldClaim: (id: string, scopeKey?: string, signal?: AbortSignal) =>
			read(
				claimDetailSchema,
				scoped(`/api/world/claims/${encodeURIComponent(id)}`, scopeKey),
				signal,
			),
		worldForgets: (scopeKey?: string, signal?: AbortSignal) =>
			read(forgetListSchema, scoped("/api/world/forgets", scopeKey), signal),
		correctWorldClaim: (input: CorrectClaim) =>
			post(claimChangeSchema, "/api/world/claims/correct", input),
		retractWorldClaim: (input: RetractClaim) =>
			post(claimChangeSchema, "/api/world/claims/retract", input),
		forgetWorldClaim: (input: ForgetClaim) =>
			post(forgetAcceptedSchema, "/api/world/claims/forget", input),
	};
}
export type WorldClient = ReturnType<typeof worldClient>;
