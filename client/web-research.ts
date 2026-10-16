import { z } from "zod";
import {
	resultSchema,
	type CacheStatus,
	type ResearchSubmit,
	type ResearchRun,
} from "../api/domains/web-research/contracts";
import { callJson, json, type Transport } from "./transport";

const researchRunSchema: z.ZodType<ResearchRun> = z.object({
	id: z.string(),
	requestId: z.string(),
	jobId: z.string(),
	operation: z.enum(["lookup", "read"]),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"partial",
		"failed",
		"cancelled",
		"interrupted",
	]),
	createdAt: z.string(),
	finishedAt: z.string().nullable(),
	errorCode: z.string().nullable(),
	result: resultSchema.nullable(),
	resultExpired: z.boolean(),
});
const cacheStatusSchema: z.ZodType<CacheStatus> = z.object({
	enabled: z.boolean(),
	entries: z.number(),
	bytes: z.number(),
	generation: z.number(),
	lastSweepAt: z.string().nullable(),
});
const clearedSchema = z.object({ cleared: z.boolean() });
function requestSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(5000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function webResearchClient(t: Transport) {
	const run = (path: string, init: RequestInit, signal?: AbortSignal) =>
		callJson(t, researchRunSchema, path, {
			...init,
			signal: requestSignal(signal),
		});
	return {
		submitResearch: (
			input: ResearchSubmit,
			signal?: AbortSignal,
		): Promise<ResearchRun> =>
			run("/api/web-research/runs", json(input), signal),
		researchRun: (id: string, signal?: AbortSignal): Promise<ResearchRun> =>
			run(`/api/web-research/runs/${encodeURIComponent(id)}`, {}, signal),
		cancelResearch: (id: string, signal?: AbortSignal): Promise<ResearchRun> =>
			run(
				`/api/web-research/runs/${encodeURIComponent(id)}/cancel`,
				json({}),
				signal,
			),
		researchCacheStatus: (signal?: AbortSignal): Promise<CacheStatus> =>
			callJson(t, cacheStatusSchema, "/api/web-research/cache/status", {
				signal: requestSignal(signal),
			}),
		clearResearchCache: (signal?: AbortSignal): Promise<{ cleared: boolean }> =>
			callJson(t, clearedSchema, "/api/web-research/cache/clear", {
				...json({}),
				signal: requestSignal(signal),
			}),
	};
}
