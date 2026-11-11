import type { Database } from "bun:sqlite";
import {
	createBuildJobHandler,
	createBuildQueueJobs,
	createContextStillSource,
	createEumenesInference,
	createSkillSmith,
	digest,
	fixedExplorationCandidate,
	FIXED_EXPLORATION_REF,
	type Authority,
	type EumenesControl,
	type ExecutionContext,
	type GuidanceRequest,
	type Ports,
} from "eumenes-skill-smith";
import { sqliteRepository } from "eumenes-skill-smith/sqlite";
import { z } from "zod";
import { getLogger } from "../../infrastructure/logger";
import type {
	GuidanceCandidate,
	GuidanceLanguage,
	GuidanceReadContext,
} from "../../domains/dialogue/contracts/specialist";
import {
	createSpecialistGuidance,
	specialistBuildHorizonMs,
	specialistScope,
} from "./specialist-guidance";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { QueueService } from "../../domains/queue";
import type { ControlContract } from "../../domains/inference";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";

const log = getLogger("knowledge");
const languages = ["ja", "en"] as const;
const candidates = languages.map((language): GuidanceCandidate => {
	const { name, digest, content } = fixedExplorationCandidate(language);
	return Object.freeze({ language, name, digest, content });
});
const text = z.string().trim().min(1).max(8000);
const clause = z.strictObject({ id: z.string().min(1).max(160), text });
const publicQuery = z.string().trim().min(1).max(512);
const situationText = z.string().trim().min(1).max(1000);
const situationSchema = z.strictObject({
	revision: z
		.string()
		.min(1)
		.max(160)
		.describe(
			"現在の作業版。CURRENT_DOCUMENT の revision を文字列で指定する。",
		),
	lastAttempt: z
		.strictObject({
			action: situationText.describe("直前に試したこと"),
			result: situationText.describe("その操作で観測した結果"),
		})
		.optional()
		.describe("実際に試した操作がある場合に指定する。"),
	uncertainty: situationText.describe("いま判断に迷っている点"),
});
const guidanceTaskFields = {
	goal: text.describe("作業の目的"),
	acceptance: z.array(clause).min(1).max(32),
	constraints: z.array(clause).max(32).default([]),
};
const guidanceQuerySchema = z.strictObject({
	...guidanceTaskFields,
	situation: situationSchema,
	publicSearchTask: publicQuery
		.optional()
		.describe(
			"ContextStillで探す公開技術の検索語。製品や規格の公開名と一般的な症状を使い、会話の原文、非公開のプロジェクト情報、秘密を含めない。",
		),
	skillLanguage: z
		.enum(languages)
		.optional()
		.describe("SKILLを受け取る言語。依頼の言語を使う。"),
});
export const guidanceToolSchema = z.union([
	guidanceQuerySchema,
	z.strictObject({ requestRef: z.uuid().describe("準備中の候補の取得ID。") }),
]);
export const submissionSchema = z.strictObject({
	...guidanceTaskFields,
	requestId: z.string().uuid(),
	situation: situationSchema.optional(),
	publicSearchTask: publicQuery.optional(),
});
export const guidanceTool = {
	id: "get_guidance",
	description:
		"作業目的と現在の状況に合いそうなSKILLを探す。担当は返された候補を読んで、適用できるかと次の作業を判断する。",
	inputSchema: z.toJSONSchema(guidanceToolSchema, { io: "input" }),
};
export const searchSchema = z.strictObject({
	query: publicQuery,
	limit: z.number().int().min(1).max(20).default(8),
});
type Submission = z.infer<typeof submissionSchema>;
const scope = "knowledge:local-owner";
const policy = {
	id: "knowledge:direct-delivery",
	version: "1",
	digest: digest(""),
	generation: 0,
};
const requestRefSchema = z.string().uuid();
type CaptureInput = Parameters<
	EumenesControl<Database>["captureUserControlInTransaction"]
>[1];
type HostControl = EumenesControl<Database>;
type ExecuteControl = HostControl["executeControl"];
type KnowledgeControl = HostControl & {
	executeControl(
		id: Parameters<ExecuteControl>[0],
		messages: Parameters<ExecuteControl>[1],
		signal: AbortSignal,
		contract: ControlContract,
	): ReturnType<ExecuteControl>;
	captureUserControlInTransaction(
		tx: Database,
		input: CaptureInput & { resourceId?: string; attemptMs?: number },
	): string;
};

function boundedCalls(signal: AbortSignal, max: number): ExecutionContext {
	let calls = 0;
	return {
		signal,
		async reserve() {
			signal.throwIfAborted();
			if (calls >= max) throw Error("knowledge_call_limit");
			calls++;
		},
	};
}

function guidanceRequest(
	input: Pick<Submission, "goal" | "acceptance" | "constraints" | "situation">,
	host: Pick<GuidanceRequest, "requestId" | "audience"> & {
		environmentId: string;
		deadlineAt: number;
		skillLanguage?: GuidanceLanguage;
		report?: string;
	},
): GuidanceRequest {
	return {
		contractVersion: "skillsmith.v1",
		requestId: host.requestId,
		delivery: "artifact",
		task: {
			goal: input.goal,
			acceptance: input.acceptance,
			constraints: input.constraints,
			references: [],
			...(host.skillLanguage ? { skillLanguage: host.skillLanguage } : {}),
			...(input.situation
				? {
						situation: {
							...input.situation,
							...(host.report ? { report: host.report } : {}),
						},
					}
				: {}),
		},
		audience: host.audience,
		environment: { id: host.environmentId, capabilities: [], policy },
		limits: {
			deadlineAt: host.deadlineAt,
			modelCalls: 3,
			sourceCalls: 12,
			candidates: 8,
			documents: 4,
			outputBytes: 32768,
			inputBytes: 65536,
			outputTokens: 4096,
		},
	};
}

/** Application adapter for authenticated delivery and specialist lookup. The SDK owns request/build state. */
export function createKnowledge(options: {
	store: SqliteStore;
	queue: QueueService;
	control: KnowledgeControl;
	selectionResourceId?: string;
	source?: NonNullable<Ports<Database>["source"]>;
	specialistContextSearch?: boolean;
}) {
	const { store, queue, control, source, selectionResourceId } = options;
	const read = <T>(operation: (tx: Database) => T) => store.read(operation);
	const write = <T>(operation: (tx: Database) => T) => store.write(operation);
	const authorityFor = (tx: Database, ref: string) => {
		const row = sqliteRepository.request(tx, ref);
		return row?.authority.scope === scope &&
			row.authority.principal === CONVERSATION_DEFAULT_PRINCIPAL
			? row.authority
			: null;
	};
	const inference = createEumenesInference({
		control,
		read,
		write,
		structuredOutput: true,
	});
	const selectionInference = selectionResourceId
		? createEumenesInference({
				control: {
					...control,
					captureUserControlInTransaction: (tx, input) =>
						control.captureUserControlInTransaction(tx, {
							...input,
							resourceId: selectionResourceId,
						}),
				},
				read,
				write,
				structuredOutput: true,
			})
		: undefined;
	const ports: Ports<Database> = {
		repository: sqliteRepository,
		now: Date.now,
		id: () => crypto.randomUUID(),
		authority: {
			valid: (tx, auth, refs) =>
				auth.principal === CONVERSATION_DEFAULT_PRINCIPAL &&
				(auth.scope === scope || auth.scope.startsWith(specialistScope)) &&
				auth.epoch === 0 &&
				refs.every((ref) => !sqliteRepository.blocked(tx, ref)),
		},
		registry: {
			async search() {
				return [];
			},
			async read() {
				throw Error("knowledge_registry_unavailable");
			},
			current: (_tx, _authority, refs) => refs.length === 0,
		},
		policy: {
			// This direct delivery entry has no additional host procedure to embed.
			resolve: () => ({ version: policy, body: "", alreadyPresent: true }),
			current: (_tx, version) => digest(version) === digest(policy),
		},
		jobs: createBuildQueueJobs(queue),
		inference,
		selectionInference,
		source,
		assemblyMode: "baseline",
		explorationFallback: true,
	};
	const service = createSkillSmith(ports);
	const specialistInference = createEumenesInference({
		control: {
			...control,
			captureUserControlInTransaction: (tx, input) =>
				control.captureUserControlInTransaction(tx, {
					...input,
					// The host's independent-control deadline is capped at two minutes per request.
					deadline: Math.min(input.deadline, Date.now() + 120_000),
					attemptMs: 90_000,
				}),
			executeControl: (id, messages, signal, contract) =>
				control.executeControl(id, messages, signal, {
					...contract,
					reasoningEffort: "low",
				}),
		},
		read,
		write,
		structuredOutput: true,
	});
	const specialist = createSpecialistGuidance(
		store,
		queue,
		{ ...ports, inference: specialistInference },
		createBuildJobHandler({ service, write, authorityFor }),
	);
	const { handler } = specialist;
	// The SDK and host pin different Zod releases. Use a host schema at the queue boundary.
	queue.registerHandler({
		...handler,
		schema: z.unknown().transform((value, ctx) => {
			const parsed = handler.schema.safeParse(value);
			if (parsed.success) return parsed.data;
			ctx.addIssue({ code: "custom", message: "invalid_knowledge_job" });
			return z.NEVER;
		}),
	});

	async function get(ref: string, signal: AbortSignal) {
		const parsed = requestRefSchema.safeParse(ref);
		if (!parsed.success) return null;
		const { row, auth } = read((tx) => ({
			row: sqliteRepository.request(tx, parsed.data),
			auth: authorityFor(tx, parsed.data),
		}));
		if (!row || !auth) return null;
		return service.getSkillDelivery(
			ref,
			auth,
			read,
			signal,
			boundedCalls(signal, row.request.limits.sourceCalls),
		);
	}

	async function submit(input: Submission, signal: AbortSignal) {
		const auth: Authority = {
			principal: CONVERSATION_DEFAULT_PRINCIPAL,
			scope,
			epoch: 0,
			sourceRefs: ["knowledge:request:" + input.requestId],
			permissions: ["build"],
			...(input.publicSearchTask ? { searchTask: input.publicSearchTask } : {}),
		};
		const request = guidanceRequest(input, {
			requestId: input.requestId,
			audience: "external",
			environmentId: "eumenes:direct-delivery",
			deadlineAt: Date.now() + 120_000,
		});
		const existing = (tx: Database) => {
			const old = sqliteRepository.requestByKey(tx, scope, input.requestId);
			if (!old) return null;
			if (
				digest(old.request.task) !== digest(request.task) ||
				old.authority.searchTask !== auth.searchTask
			)
				throw Error("knowledge_request_conflict");
			return old.ref;
		};
		const prior = read(existing);
		if (prior) return get(prior, signal);
		const prepared = read((tx) =>
			service.prepareSkillSelection(tx, request, auth),
		);
		const choice = await service.selectSkill(prepared, boundedCalls(signal, 1));
		const ref = await write((tx) => {
			signal.throwIfAborted();
			const prior = existing(tx);
			if (prior) return prior;
			const reply =
				choice.decision.kind === "miss"
					? service.submitArtifact(tx, request, auth)
					: service.bindSkillSelection(tx, prepared, choice, auth);
			if (!reply.requestRef) throw Error("knowledge_submission_failed");
			return reply.requestRef;
		});
		return get(ref, signal);
	}
	async function selectForSpecialist(
		args: unknown,
		context: {
			runId: string;
			bindingRevisionId: string;
			language?: GuidanceLanguage;
			report?: string;
			deadline: number;
		} & GuidanceReadContext,
	) {
		const started = performance.now();
		const parsed = guidanceToolSchema.safeParse(args);
		if (!parsed.success) throw Error("specialist_invalid_arguments");
		const { data: input } = parsed;
		if ("requestRef" in input)
			return specialist.read(input.requestRef, context);
		if (input.situation.revision !== String(context.revision))
			throw Error("guidance_revision_mismatch");
		const { signal, assertCurrent } = context;
		if (input.publicSearchTask) {
			if (!source || !options.specialistContextSearch)
				return {
					kind: "unavailable",
					reason: "contextstill_search_unavailable",
				} as const;
			const request = guidanceRequest(input, {
				requestId: context.runId,
				audience: "worker",
				environmentId: context.bindingRevisionId,
				skillLanguage: context.language ?? input.skillLanguage,
				report: context.report,
				// The original reply, disclosure, generation and review share this job deadline.
				deadlineAt: Date.now() + specialistBuildHorizonMs,
			});
			return specialist.submit(
				{
					...request,
					limits: { ...request.limits, modelCalls: 4, sourceCalls: 16 },
				},
				input.publicSearchTask,
				context.runId,
				context,
			);
		}
		const auth: Authority = {
			principal: CONVERSATION_DEFAULT_PRINCIPAL,
			scope: specialistScope + context.sessionId,
			epoch: 0,
			sourceRefs: [],
			permissions: ["build"],
		};
		const request = guidanceRequest(input, {
			requestId: crypto.randomUUID(),
			audience: "worker",
			environmentId: context.bindingRevisionId,
			skillLanguage: context.language ?? input.skillLanguage,
			report: context.report,
			// This lookup runs inside an interactive turn, independently of the build queue.
			deadlineAt: Math.min(context.deadline, Date.now() + 8_000),
		});
		const prepared = read((tx) => {
			assertCurrent(tx);
			return service.prepareSkillSelection(tx, request, auth);
		});
		const choice = await service.selectSkill(prepared, boundedCalls(signal, 1));
		if (choice.decision.kind === "miss") {
			read(assertCurrent);
			return { kind: "unavailable", reason: choice.decision.reason } as const;
		}
		const ref = await write((tx) => {
			assertCurrent(tx);
			const reply = service.bindSkillSelection(tx, prepared, choice, auth);
			if (!reply.requestRef) throw Error("knowledge_submission_failed");
			return reply.requestRef;
		});
		const delivery = await service.getSkillDelivery(
			ref,
			auth,
			read,
			signal,
			boundedCalls(signal, request.limits.sourceCalls),
		);
		read(assertCurrent);
		if (delivery.kind !== "ready")
			return { kind: "unavailable" as const, reason: delivery.kind };
		log.info("knowledge.specialist_delivery", {
			bindingRevisionId: context.bindingRevisionId,
			workRevision: context.revision,
			lastAttemptCount: input.situation.lastAttempt ? 1 : 0,
			kind: delivery.exploration ? "exploration" : "approved",
			skillDigest: delivery.skill.digest,
			durationMs: performance.now() - started,
		});
		return {
			kind: "ready" as const,
			skill: delivery.skill,
			...(delivery.exploration ? { exploration: true as const } : {}),
			situation: request.task.situation,
		};
	}

	return {
		explorationCandidates(tx: Database, language?: GuidanceLanguage) {
			if (sqliteRepository.blocked(tx, FIXED_EXPLORATION_REF)) return [];
			return language
				? candidates.filter((candidate) => candidate.language === language)
				: candidates;
		},
		submit,
		get,
		selectForSpecialist,
		readForSpecialist: specialist.read,
		finishSpecialistTurn: specialist.finishTurn,
		attachDialogue: specialist.attachDialogue,
		async search(input: z.infer<typeof searchSchema>, signal: AbortSignal) {
			if (!source) return null;
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
			return source.search(
				input.query,
				input.limit,
				bounded,
				boundedCalls(bounded, 4),
			);
		},
		async readSource(ref: string, signal: AbortSignal) {
			if (!source || !/^contextstill:(kn|ep)_[a-z2-7]{26}$/.test(ref))
				return null;
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
			return source.get(ref, bounded, boundedCalls(bounded, 4));
		},
	};
}
export type Knowledge = ReturnType<typeof createKnowledge>;

export function configuredContextStill(config: {
	url?: string;
	token?: string;
}) {
	if (!config.url && !config.token) return undefined;
	if (!config.url || !config.token)
		throw Error("contextstill_connection_incomplete");
	return createContextStillSource({
		endpoint: config.url,
		token: config.token,
	});
}

/** Model-authored queries stay inside the local, operator-configured knowledge service. */
export function permitsSpecialistContextSearch(url?: string) {
	return !!url && ["127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}
