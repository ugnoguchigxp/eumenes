import { recognitionManage, recognitionCommand } from "./object-recognition";
export { recognitionManage, recognitionCommand };
import { drawingRequest, drawingPlan } from "./excalidraw";
export { drawingRequest, drawingPlan };
import { z } from "zod";
import {
	uiComposeRequest,
	uiCancelRequest,
	uiResponseFields,
	uiSubmitRequest,
} from "./ui-compositions";
import { claudeCodeRequest } from "./claude-code";
export { claudeCodeRequest };
export { uiComposeRequest, uiCancelRequest, uiResponseFields, uiSubmitRequest };
import { imageRequest, imagePlan } from "./image";
export { imageRequest, imagePlan };
import {
	musicRequest,
	musicPlan,
	musicPlanV2,
	musicPlaybackPlan,
} from "./music";
export { musicRequest, musicPlan, musicPlanV2, musicPlaybackPlan };
import {
	timerCancel,
	timerCommand,
	timerDurationAnswer,
	timerHms,
	timerList,
	timerStart,
	timerTargetAnswer,
} from "./timers";
export {
	timerCancel,
	timerCommand,
	timerDurationAnswer,
	timerHms,
	timerList,
	timerStart,
	timerTargetAnswer,
};
import { answerText, emptyInput } from "./inputs";
export { answerText, emptyInput };
export { timerResultContext, type TimerResultContext } from "./timers";
import { publicUrl } from "./public-url";
import { toolchainRequest } from "./toolchains";
export { publicUrl };
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
export const savedFindInput = z
	.object({
		sourceRef: z.string().uuid(),
		query: z.string().trim().min(1).max(200),
		cursor: z.string().uuid().optional(),
	})
	.strict();
export const savedReadInput = z
	.object({
		sourceRef: z.string().uuid(),
		cursor: z.string().uuid().optional(),
		start: z.literal("head").optional(),
		characters: z.number().int().min(1).max(2400).default(2400),
	})
	.strict()
	.refine((v) => !(v.cursor && v.start));
export const historyInput = z
	.object({
		question: z.string().min(1).max(8000),
		detail: z.enum(["brief", "normal"]).default("normal"),
	})
	.strict();
export const historySearch = z
	.object({
		query: z.string().trim().max(200).default(""),
		from: z.string().datetime({ offset: true }).optional(),
		until: z.string().datetime({ offset: true }).optional(),
		speaker: z.enum(["user", "assistant"]).optional(),
		cursor: z.string().uuid().optional(),
		limit: z.number().int().min(1).max(20).default(10),
	})
	.strict()
	.refine(
		(v) => !v.from || !v.until || Date.parse(v.from) < Date.parse(v.until),
	);
export const historyRead = z
	.object({
		messageRef: z.string().uuid(),
		before: z.number().int().min(0).max(9).default(2),
		after: z.number().int().min(0).max(9).default(2),
		cursor: z.string().uuid().optional(),
	})
	.strict()
	.refine((v) => v.before + v.after < 10);
/** Saved fetch procedures of the current toolchain; the sub-agent judges whether one matches. */
export const recipeFindInput = z
	.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.describe("現在の依頼を対象と知りたい内容で短く表した文。"),
	})
	.strict();
export const validators = {
	uiComposeRequest,
	claudeCodeRequest,
	uiCancelRequest,
	uiResponseFields,
	uiSubmitRequest,
	recognitionManage,
	drawingRequest,
	drawingPlan,
	imageRequest,
	imagePlan,
	musicRequest,
	musicPlan,
	musicPlanV2,
	musicPlaybackPlan,
	dotsDelegation: z.strictObject({}),
	find: savedFindInput,
	readSaved: savedReadInput,
	history: historyInput,
	historySearch,
	historyRead,
	forecast: forecastInput,
	quote: quoteInput,
	research: researchInput,
	lookup: lookupInput,
	read: readInput,
	recipeFind: recipeFindInput,
	toolchainRequest,
	timerStart,
	timerList,
	timerCancel,
	timerCommand,
	answerText,
	timerDurationAnswer,
	timerTargetAnswer,
	timerHms,
	emptyInput,
	ocrTarget: z.strictObject({ id: z.uuid() }),
};
export type SchemaKey = keyof typeof validators;
export type Owner = { rootRunId: string; taskId: string; cancelEpoch: number };
export type Definition = {
	kind: "package" | "profile" | "skill" | "tool" | "requirement" | "toolchain";
	requirementData?: import("./requirements").RequirementProfileData;
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
	/** Learned definitions are route-only: never indexed, never listed, prepared by exact ID. */
	discoveryMode?: "catalog" | "route-only";
	/** Toolchain only: the function the conversation model calls. */
	functionName?: string;
	/** Toolchain only: representative requests; indexed and used as the routing evaluation set. */
	examples?: string[];
	/** Toolchain only: the one package (profile, SKILL, tools) its sub-agent runs. */
	packageRevisionId?: string;
	/** Toolchain only: the result display. */
	artifact?: import("./toolchains").ToolchainArtifact;
	/** Toolchain only: which other toolchain to use instead, and when. */
	redirects?: import("./toolchains").ToolchainRedirect[];
	/**
	 * Toolchain only, new revisions only (absent from the JSON of earlier ones): the stored
	 * binding that connects the package's tools to a host adapter, and the stored artifact
	 * registration that presents it. Both are set together.
	 */
	bindingRevisionId?: string;
	artifactRevisionId?: string;
};
export const learnedIdPattern = /^learned\.web\.[0-9a-f]{32}$/;
export const learnedMaxBytes = 16384;
export const commonSkillRevisionId = "skill:web.research@5";
export const commonProfileRevisionId = "profile:web.research@1";
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

export * from "./bindings";
export * from "./requirements";
export * from "./runtime-meta";
export * from "./toolchains";

export { dotsPackageInput } from "./dots";
