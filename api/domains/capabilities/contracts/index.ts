import {
	recognitionManage,
	recognitionManageV2,
	recognitionCommand,
} from "./object-recognition";
export { recognitionCommand };
import { drawingRequest, drawingPlan } from "./excalidraw";
export { drawingRequest, drawingPlan };
import { z } from "zod";
import { guidedResearchInput } from "./guided-research";
import {
	uiCompositionDelete,
	uiSourceApply,
	uiResponseFields,
	uiSubmitRequest,
	uiTargetRef,
	uiWorkSave,
	uiWorkStep,
} from "./ui-compositions";
import { claudeCodeRequest } from "./claude-code";
import {
	pipelineSourceApply,
	pipelineTargetRef,
	pipelineWorkStep,
} from "./pipelines";
import {
	kanbanSharedAdd,
	kanbanExecutorRef,
	kanbanSelectExecutor,
	kanbanInspect,
	kanbanGitRequest,
	codexTaskRequest,
	codexTaskRef,
	codexTaskFollowup,
	codexTaskConfigure,
} from "./kanban-shared";
export {
	kanbanSharedAdd,
	kanbanExecutorRef,
	kanbanSelectExecutor,
	kanbanInspect,
	kanbanGitRequest,
	codexTaskRequest,
	codexTaskRef,
	codexTaskFollowup,
};
import { memoryRequest } from "./memory-request";
import { worldDocuments, worldFind, worldQuery } from "./world-query";
export { claudeCodeRequest };
import {
	KANBAN_PROMPT_MAX,
	kanbanAdd,
	kanbanCardAnswer,
	kanbanCardRef,
	kanbanEdit,
	kanbanFollowup,
	kanbanList,
	kanbanMove,
	kanbanNoticeRef,
} from "./kanban";
export {
	KANBAN_PROMPT_MAX,
	kanbanAdd,
	kanbanCardRef,
	kanbanEdit,
	kanbanFollowup,
	kanbanList,
	kanbanMove,
};
export {
	uiCompositionDelete,
	uiSourceApply,
	uiResponseFields,
	uiSubmitRequest,
	uiWorkSave,
	uiWorkStep,
};
import { imageRequest, imagePlan } from "./image";
export { imageRequest, imagePlan };
import {
	musicRequest,
	musicPlan,
	musicPlanV2,
	musicPlanV3,
	musicPlaybackPlan,
} from "./music";
export { musicRequest, musicPlan, musicPlanV2, musicPlanV3, musicPlaybackPlan };
import {
	timerCancel,
	timerCommand,
	timerDurationAnswer,
	timerHms,
	timerList,
	timerStart,
	timerTargetAnswer,
} from "./timers";
import { answerText, emptyInput } from "./inputs";
export { timerResultContext } from "./timers";
import { publicUrl } from "./public-url";
import { toolchainRequest } from "./toolchains";
import { stockQuote } from "./stock";
import { weatherPlace } from "./weather";
import {
	model3dFind,
	model3dGenerate,
	model3dJobTarget,
	model3dTarget,
	model3dUpdate,
} from "./model3d";
import {
	browserCaptureStart,
	browserCaptureTarget,
	browserScriptPublish,
	browserPageCapture,
	browserPageClick,
	browserPageHover,
	browserPagePress,
	browserPageSelect,
	browserPageType,
	browserPageTypeValue,
	browserPageWait,
	browserTabOpen,
	browserTabTarget,
	browserTaskBegin,
	browserTaskStart,
	browserTaskTarget,
} from "./browser";
export { stockQuote } from "./stock";
export { weatherPlace, weatherDays } from "./weather";
export { publicUrl };
export const researchInput = z
	.object({
		question: z.string().min(1).max(8000),
		urls: z.array(publicUrl).max(3).optional(),
		detail: z.enum(["brief", "normal"]).default("normal"),
	})
	.strict();
import { lookupInput, lookupInputV1 } from "./lookup";
import type { ToolchainArtifact, ToolchainRedirect } from "./toolchains";
export { lookupInput };
const readInput = z.object({ url: publicUrl }).strict();
const forecastInput = z
	.object({
		areaCode: z
			.string()
			.regex(/^\d{6}$/)
			.describe(
				"JMA forecast office: Tokyo 130000, Osaka 270000, Kanagawa 140000, Kyoto 260000, Aichi 230000, Fukuoka 400000, Hyogo 280000",
			),
	})
	.strict();
const quoteInput = z
	.object({
		symbol: z
			.string()
			.regex(/^[A-Z0-9.^-]{1,16}$/)
			.describe(
				"Ticker explicitly present in the current request, e.g. AAPL or 7203.T",
			),
	})
	.strict();
const savedFindInput = z
	.object({
		sourceRef: z.string().uuid(),
		query: z.string().trim().min(1).max(200),
		cursor: z.string().uuid().optional(),
	})
	.strict();
const savedReadInput = z
	.object({
		sourceRef: z.string().uuid(),
		cursor: z.string().uuid().optional(),
		start: z.literal("head").optional(),
		characters: z.number().int().min(1).max(2400).default(2400),
	})
	.strict()
	.refine((v) => !(v.cursor && v.start));
const historyInput = z
	.object({
		question: z.string().min(1).max(8000),
		detail: z.enum(["brief", "normal"]).default("normal"),
	})
	.strict();
const historySearch = z
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
const historyRead = z
	.object({
		messageRef: z.string().uuid(),
		before: z.number().int().min(0).max(9).default(2),
		after: z.number().int().min(0).max(9).default(2),
		cursor: z.string().uuid().optional(),
	})
	.strict()
	.refine((v) => v.before + v.after < 10);
/** Saved fetch procedures of the current toolchain; the sub-agent judges whether one matches. */
const recipeFindInput = z
	.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.describe("現在の依頼を対象と知りたい内容で短く表した文。"),
	})
	.strict();
import {
	computePythonSubmit,
	computeJobTarget,
	computeArtifactTarget,
} from "./compute";

export const validators = {
	computePythonSubmit,
	computeJobTarget,
	computeArtifactTarget,
	browserResearchCollect: z.strictObject({
		observationRef: z.uuid(),
		blockRefs: z
			.array(z.string().regex(/^b[1-9][0-9]*$/))
			.min(1)
			.max(80),
		purpose: z.enum(["candidates", "facts"]),
		linkBlockRefs: z.array(z.string().regex(/^b[1-9][0-9]*$/)).max(5),
	}),
	browserResearch: z.strictObject({
		request: z.string().trim().min(1).max(4000),
		url: publicUrl.optional(),
	}),
	kanbanSharedAdd,
	kanbanExecutorRef,
	kanbanSelectExecutor,
	kanbanInspect,
	kanbanGitRequest,
	codexTaskRequest,
	codexTaskRef,
	codexTaskFollowup,
	codexTaskConfigure,
	claudeCodeRequest,
	kanbanAdd,
	kanbanEdit,
	kanbanMove,
	kanbanCardRef,
	kanbanCardAnswer,
	kanbanFollowup,
	kanbanList,
	kanbanNoticeRef,
	uiSourceApply,
	uiWorkStep,
	uiWorkSave,
	uiCompositionDelete,
	uiTargetRef,
	pipelineSourceApply,
	pipelineWorkStep,
	pipelineTargetRef,
	uiResponseFields,
	uiSubmitRequest,
	recognitionManage,
	recognitionManageV2,
	drawingRequest,
	drawingPlan,
	imageRequest,
	imagePlan,
	musicRequest,
	musicPlan,
	musicPlanV2,
	musicPlanV3,
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
	guidedResearch: guidedResearchInput,
	guidedCandidates: guidedResearchInput,
	readCandidate: z
		.object({
			url: publicUrl.optional(),
			candidateRef: z
				.string()
				.regex(/^c[1-9][0-9]*$/)
				.optional(),
		})
		.strict()
		.refine((v) => !!v.url !== !!v.candidateRef),
	lookup: lookupInputV1,
	lookupV2: lookupInput,
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
	ocrCorrectionRequest: z.strictObject({
		sourceId: z.uuid(),
		expectedRevision: z.number().int().nonnegative(),
		frameIndex: z.number().int().nonnegative().max(59).optional(),
	}),
	memoryRequest,
	worldDocuments,
	worldFind,
	worldQuery,
	weatherPlace,
	stockQuote,
	model3dGenerate,
	model3dFind,
	model3dTarget,
	model3dUpdate,
	model3dJobTarget,
	browserCaptureStart,
	browserCaptureTarget,
	browserTabTarget,
	browserTabOpen,
	browserTaskStart,
	browserTaskBegin,
	browserTaskTarget,
	browserPageClick,
	browserPageHover,
	browserPageType,
	browserPageTypeValue,
	browserPageSelect,
	browserPagePress,
	browserPageWait,
	browserScriptPublish,
	browserPageCapture,
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
	artifact?: ToolchainArtifact;
	/** Toolchain only: which other toolchain to use instead, and when. */
	redirects?: ToolchainRedirect[];
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
export * from "./pipelines";

export { dotsPackageInput } from "./dots";
