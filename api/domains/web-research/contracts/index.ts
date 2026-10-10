import { z } from "zod";

const common = {
	requestId: z.string().uuid(),
	freshness: z.enum(["live", "normal"]).default("live"),
};
export function isPublicHttpUrl(value: string): boolean {
	if (value.length > 2048) return false;
	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}
const publicUrl = z
	.string()
	.url()
	.max(2048)
	.refine((value) => isPublicHttpUrl(value));
export const submitResearchSchema = z.discriminatedUnion("operation", [
	z
		.object({
			...common,
			operation: z.literal("lookup"),
			query: z.string().trim().min(1).max(400),
			language: z
				.string()
				.regex(/^[a-z]{2}$/)
				.default("ja"),
			region: z
				.string()
				.regex(/^[A-Z]{2}$/)
				.default("JP"),
			timeRange: z.enum(["day", "week", "month", "year"]).optional(),
			readPages: z.number().int().min(0).max(3).default(0),
		})
		.strict(),
	z
		.object({
			...common,
			operation: z.literal("read"),
			url: publicUrl,
			retention: z.enum(["none", "stable"]).default("none"),
		})
		.strict(),
]);
export type ResearchSubmit = z.input<typeof submitResearchSchema>;
export type ResearchRequest = z.output<typeof submitResearchSchema>;
export const documentSchema = z.object({
	url: publicUrl,
	title: z.string().max(500),
	text: z.string().max(12000),
	fetchedAt: z.string().datetime(),
	truncated: z.boolean(),
	trust: z.literal("untrusted"),
	tainted: z.literal(true),
	verification: z.literal("source_read"),
	guardDecision: z.enum(["allow", "allow_with_warning"]),
	guardReasonCodes: z.array(z.string().max(80)).max(16),
});
export type ResearchDocument = z.infer<typeof documentSchema>;
export const resultSchema = z.object({
	provider: z.literal("llm-fetch@0.1.2"),
	observedAt: z.string().datetime(),
	cache: z.enum(["miss", "hit", "bypass"]),
	hits: z
		.array(
			z.object({
				url: publicUrl,
				title: z.string().max(300),
				snippet: z.string().max(500),
				provider: z.string().max(80),
				trust: z.literal("untrusted"),
				tainted: z.literal(true),
				verification: z.literal("search_summary"),
			}),
		)
		.max(5),
	documents: z.array(documentSchema).max(3),
	failures: z
		.array(
			z.object({
				url: publicUrl,
				code: z
					.string()
					.regex(/^[a-z_]+$/)
					.max(80),
				guardDecision: z.enum(["deny", "require_approval"]).optional(),
				guardReasonCodes: z.array(z.string().max(80)).max(16).optional(),
			}),
		)
		.max(3),
});
export type ResearchResult = z.infer<typeof resultSchema>;
export type ResearchState =
	| "queued"
	| "running"
	| "completed"
	| "partial"
	| "failed"
	| "cancelled"
	| "interrupted";
export interface ResearchRun {
	id: string;
	requestId: string;
	jobId: string;
	operation: ResearchRequest["operation"];
	status: ResearchState;
	createdAt: string;
	finishedAt: string | null;
	errorCode: string | null;
	result: ResearchResult | null;
	resultExpired: boolean;
}
export interface CacheStatus {
	enabled: boolean;
	entries: number;
	bytes: number;
	generation: number;
	lastSweepAt: string | null;
}
