import type { Database } from "bun:sqlite";
import {
	createBuildJobHandler,
	createBuildQueueJobs,
	createContextStillSource,
	createEumenesInference,
	createSkillSmith,
	digest,
	type Authority,
	type EumenesControl,
	type ExecutionContext,
	type GuidanceRequest,
	type Ports,
} from "eumenes-skill-smith";
import { sqliteRepository } from "eumenes-skill-smith/sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { QueueService } from "../../domains/queue";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";

const text = z.string().trim().min(1).max(8000);
const clause = z.strictObject({ id: z.string().min(1).max(160), text });
const publicQuery = z.string().trim().min(1).max(512);
export const submissionSchema = z.strictObject({
	requestId: z.string().uuid(),
	goal: text,
	acceptance: z.array(clause).min(1).max(32),
	constraints: z.array(clause).max(32).default([]),
	publicSearchTask: publicQuery.optional(),
});
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

/** Authenticated local-owner application adapter. The SDK owns request/build state. */
export function createKnowledge(options: {
	store: SqliteStore;
	queue: QueueService;
	control: EumenesControl<Database>;
	source?: NonNullable<Ports<Database>["source"]>;
}) {
	const { store, queue, control, source } = options;
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
	const service = createSkillSmith<Database>({
		repository: sqliteRepository,
		now: Date.now,
		id: () => crypto.randomUUID(),
		authority: {
			valid: (tx, auth, refs) =>
				auth.principal === CONVERSATION_DEFAULT_PRINCIPAL &&
				auth.scope === scope &&
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
		source,
		assemblyMode: "baseline",
		explorationFallback: true,
	});
	const handler = createBuildJobHandler({ service, write, authorityFor });
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
		const request: GuidanceRequest = {
			contractVersion: "skillsmith.v1",
			requestId: input.requestId,
			delivery: "artifact",
			task: {
				goal: input.goal,
				acceptance: input.acceptance,
				constraints: input.constraints,
				references: [],
			},
			audience: "external",
			environment: { id: "eumenes:direct-delivery", capabilities: [], policy },
			limits: {
				deadlineAt: Date.now() + 120_000,
				modelCalls: 3,
				sourceCalls: 12,
				candidates: 8,
				documents: 4,
				outputBytes: 32768,
				inputBytes: 65536,
				outputTokens: 4096,
			},
		};
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
	return {
		submit,
		get,
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
