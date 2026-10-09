import { z } from "zod";
export const publicUrl = z
	.string()
	.url()
	.max(2048)
	.refine((v) => {
		const u = new URL(v);
		return (
			["http:", "https:"].includes(u.protocol) && !u.username && !u.password
		);
	});
export const researchInput = z
	.object({
		question: z.string().min(1).max(8000),
		urls: z.array(publicUrl).max(3).optional(),
		detail: z.enum(["brief", "normal"]).default("normal"),
	})
	.strict();
export const lookupInput = z
	.object({
		query: z.string().trim().min(1).max(400),
		language: z
			.string()
			.regex(/^[a-z]{2}$/)
			.default("ja"),
		region: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.describe("ISO region. Use JP with ja, US with en.")
			.optional(),
		timeRange: z.enum(["day", "week", "month", "year"]).optional(),
	})
	.strict();
export const readInput = z.object({ url: publicUrl }).strict();
export const forecastInput = z
	.object({
		areaCode: z
			.string()
			.regex(/^\d{6}$/)
			.describe(
				"JMA forecast office: Tokyo 130000, Osaka 270000, Kanagawa 140000, Kyoto 260000, Aichi 230000, Fukuoka 400000, Hyogo 280000",
			),
	})
	.strict();
export const quoteInput = z
	.object({
		symbol: z
			.string()
			.regex(/^[A-Z0-9.^-]{1,16}$/)
			.describe(
				"Ticker explicitly present in the current request, e.g. AAPL or 7203.T",
			),
	})
	.strict();
export const validators = {
	forecast: forecastInput,
	quote: quoteInput,
	research: researchInput,
	lookup: lookupInput,
	read: readInput,
};
export type SchemaKey = keyof typeof validators;
export type Owner = { rootRunId: string; taskId: string; cancelEpoch: number };
export type Definition = {
	kind: "package" | "profile" | "skill" | "tool";
	id: string;
	revision: number;
	title: string;
	summary: string;
	aliases: string[];
	tags: string[];
	useWhen: string[];
	avoidWhen: string[];
	dependencies: string[];
	backend?: string;
	schemaKey?: SchemaKey;
	body?: string;
	schemaHash?: string;
	toolRevisionIds?: string[];
	requiredSkillRevisionIds?: string[];
	profileRevisionId?: string;
};
export type FixedDefinition = Definition & {
	revisionId: string;
	hash: string;
	generation: number;
};
export type Candidate = {
	candidateRef: string;
	id: string;
	title: string;
	summary: string;
	useWhen: string[];
	avoidWhen: string[];
};
export type Prepared = {
	package: FixedDefinition;
	dependencies: FixedDefinition[];
	input: unknown;
};
export const bytes = (v: unknown) =>
	new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v))
		.length;
export const hash = (v: unknown) =>
	new Bun.CryptoHasher("sha256")
		.update(typeof v === "string" ? v : JSON.stringify(v))
		.digest("hex");
