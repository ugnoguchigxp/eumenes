import type { Database } from "bun:sqlite";
import { z } from "zod";

const day = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => {
		const d = new Date(s + "T00:00:00+09:00");
		return (
			Number.isFinite(+d) &&
			new Date(+d + 9 * 3600000).toISOString().slice(0, 10) === s
		);
	});
export const usageQuerySchema = z.strictObject({
	start: day,
	end: day,
	service: z.enum(["all", "live", "codex"]).default("all"),
	model: z.string().max(200).default(""),
	connectionId: z.string().max(200).default(""),
	pageIndex: z.number().int().min(0).max(100000).default(0),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export function usageRange(query: UsageQuery) {
	const start = +new Date(query.start + "T00:00:00+09:00");
	const end = +new Date(query.end + "T00:00:00+09:00") + 86400000;
	if (end <= start || end - start > 366 * 86400000)
		throw new Error("invalid_usage_period");
	return { start, end };
}
export const rateInputSchema = z.strictObject({
	expectedRevision: z.coerce.number().int().nonnegative(),
	model: z.string().min(1).max(200),
	amount: z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,9})?$/),
	effectiveFrom: z.iso.datetime({ offset: true }),
	source: z.string().min(1).max(500),
});
export type RateInput = z.infer<typeof rateInputSchema>;
export type Rate = Omit<RateInput, "expectedRevision"> & {
	id: string;
	checkedAt: string;
};
export type LiveUsage = {
	id: string;
	model: string | null;
	connectionId: string;
	connectionName: string | null;
	startedAt: string;
	endedAt: string | null;
	status: string;
	test: number;
	seconds: number | null;
	confirmed: number;
	error: string | null;
};
export type CodexUsage = {
	id: string;
	connectionId: string | null;
	connectionName: string | null;
	model: string | null;
	requestedModel: string | null;
	started: number;
	ended: number | null;
	status: string;
	role: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningTokens: number | null;
	costUsd: number | null;
	billingPath: string | null;
	observed: number;
};
export type UsagePorts = {
	activeLive?(db: Database): Array<{
		id: string;
		model: string | null;
		connectionId: string;
		startedAt: string;
		seconds: number | null;
	}>;
	live(db: Database, start: number, end: number): LiveUsage[];
	codex(db: Database, start: number, end: number): CodexUsage[];
	choices(db: Database): {
		models: string[];
		liveModels: string[];
		currentCodexModel: string;
	};
};
