import type { Database } from "bun:sqlite";
import {
	createBuildJobHandler,
	type Authority,
	createSkillSmith,
	type Ports,
	type GuidanceRequest,
} from "eumenes-skill-smith";
import { sqliteRepository } from "eumenes-skill-smith/sqlite";
import { z } from "zod";
import type { HandlerDefinition, QueueService } from "../../domains/queue";
import type { DialogueService } from "../../domains/dialogue";
import type { GuidanceReadContext } from "../../domains/dialogue/contracts/specialist";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { getLogger } from "../../infrastructure/logger";

type Dialogue = Pick<
	DialogueService,
	"specialistExecutionSourceInTransaction" | "notifySpecialistInTransaction"
>;

const log = getLogger("knowledge");
export const specialistScope = "knowledge:specialist:";
export const specialistBuildHorizonMs = 180_000;
const noticeKind = "knowledge.guidance_notice.v1";
const noticePayload = z.strictObject({ requestRef: z.uuid() });
type NoticePayload = z.infer<typeof noticePayload>;

export function createSpecialistGuidance(
	store: SqliteStore,
	queue: QueueService,
	ports: Ports<Database>,
	baselineHandler: ReturnType<typeof createBuildJobHandler<Database>>,
) {
	let dialogue: Dialogue | undefined;
	const request = sqliteRepository.request;

	function executionSource(tx: Database, auth: Authority) {
		return auth.parentRef && auth.scope.startsWith(specialistScope)
			? dialogue?.specialistExecutionSourceInTransaction(
					tx,
					auth.parentRef,
					auth.scope.slice(specialistScope.length),
					auth.epoch,
				)
			: null;
	}

	function valid(tx: Database, auth: Authority) {
		const source = executionSource(tx, auth);
		return !!source && auth.sourceRefs.includes(source.messageId);
	}

	const service = createSkillSmith({
		...ports,
		assemblyMode: "compact",
		limits: { ...ports.limits, maxSubmitHorizonMs: specialistBuildHorizonMs },
		authority: {
			valid: (tx, auth, refs) =>
				auth.principal === CONVERSATION_DEFAULT_PRINCIPAL &&
				valid(tx, auth) &&
				refs.every((ref) => !sqliteRepository.blocked(tx, ref)),
		},
	});
	const compactHandler = createBuildJobHandler({
		service,
		write: (operation) => store.write(operation),
		authorityFor: (tx, ref) => {
			const row = request(tx, ref);
			return row && valid(tx, row.authority) ? row.authority : null;
		},
		observeCall: (ref, call) => {
			log.info("knowledge.specialist_build_call", {
				subjectId: ref,
				phase: call.operation,
				kind: call.kind,
				outcome: call.outcome,
				validationCode: call.validationCode,
				durationMs: call.durationMs,
			});
		},
	});
	const handlerFor = (scope: string) =>
		scope.startsWith(specialistScope) ? compactHandler : baselineHandler;

	function enqueueNotice(tx: Database, ref: string) {
		const row = request(tx, ref);
		const source = row && executionSource(tx, row.authority);
		if (!row?.outcome || !source) return;
		queue.enqueueInTransaction(tx, {
			scope: row.authority.scope,
			kind: noticeKind,
			dedupeKey: ref,
			payload: { requestRef: ref },
			subjectRef: ref,
			lane: "background",
			concurrencyKey: "conversation:" + source.conversationId,
			deadlineAtMs: Date.now() + 30_000,
			maxAttempts: 3,
		});
	}

	const notices: HandlerDefinition<NoticePayload, NoticePayload, void> = {
		kind: noticeKind,
		payloadVersions: [1],
		schema: noticePayload,
		recovery: "replay_safe",
		prepareInTransaction(tx, claim) {
			const row = request(tx, claim.payload.requestRef);
			return row?.outcome &&
				row.ref === claim.subjectRef &&
				row.authority.scope === claim.scope &&
				valid(tx, row.authority)
				? { status: "ready", input: claim.payload }
				: { status: "stale", reason: "guidance_source_stale" };
		},
		async execute({ requestRef }, { signal }) {
			await store.write((tx) => {
				signal.throwIfAborted();
				const row = request(tx, requestRef);
				const source = row && executionSource(tx, row.authority);
				if (!row || !source?.specialistSessionId || !row.authority.parentRef)
					return;
				const notified = dialogue?.notifySpecialistInTransaction(tx, {
					sessionId: source.specialistSessionId,
					epoch: row.authority.epoch,
					sourceRunId: row.authority.parentRef,
					eventId: "knowledge-guidance:" + row.ref,
					event: { kind: "knowledge.guidance", requestRef: row.ref },
				});
				if (!notified) throw Error("guidance_session_busy");
				log.info("knowledge.specialist_build_settled", {
					subjectId: row.ref,
					runId: row.authority.parentRef,
					kind: row.outcome?.kind,
					status: "notified",
				});
			});
		},
		classify(error) {
			return error instanceof Error && error.message === "guidance_session_busy"
				? "retry"
				: "fail";
		},
		settleInTransaction: () => "applied",
		cancelInTransaction() {},
	};
	queue.registerHandler(notices);

	const handler: typeof compactHandler = {
		...baselineHandler,
		prepareInTransaction: (tx, claim) =>
			handlerFor(claim.scope).prepareInTransaction(tx, claim),
		execute: (input, context) =>
			handlerFor(input.authority.scope).execute(input, context),
		settleInTransaction(tx, claim, input, outcome) {
			const settled = handlerFor(claim.scope).settleInTransaction(
				tx,
				claim,
				input,
				outcome,
			);
			if (settled === "applied" && claim.scope.startsWith(specialistScope))
				enqueueNotice(tx, claim.payload.requestRef);
			return settled;
		},
		cancelInTransaction(tx, job, reason) {
			const row = request(tx, job.payload.requestRef);
			if (row)
				handlerFor(row.authority.scope).cancelInTransaction(tx, job, reason);
		},
	};

	async function read(requestRef: string, context: GuidanceReadContext) {
		const row = store.read((tx) => {
			context.assertCurrent(tx);
			const found = request(tx, requestRef);
			if (
				!found ||
				found.authority.scope !== specialistScope + context.sessionId ||
				found.authority.epoch !== context.sessionEpoch ||
				!valid(tx, found.authority)
			)
				return null;
			return found;
		});
		if (!row)
			return { kind: "unavailable" as const, reason: "request_unavailable" };
		const situation = row.request.task.situation;
		if (situation?.revision !== String(context.revision))
			return {
				kind: "unavailable" as const,
				reason: "guidance_revision_changed",
			};
		const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
		const result = await service.getSkillDelivery(
			requestRef,
			row.authority,
			(operation) =>
				store.read((tx) => {
					context.assertCurrent(tx);
					return operation(tx);
				}),
			signal,
			{
				signal,
				async reserve(kind) {
					await store.write((tx) => {
						context.assertCurrent(tx);
						service.reserveDelivery(tx, requestRef, row.authority, kind);
					});
				},
			},
		);
		store.read(context.assertCurrent);
		if (result.kind === "pending")
			return { kind: "pending" as const, requestRef };
		if (result.kind === "needs_input") return result;
		if (result.kind !== "ready")
			return { kind: "unavailable" as const, reason: result.code };
		const content = store.read((tx) => {
			context.assertCurrent(tx);
			return sqliteRepository.build(tx, result.auditRef)?.content;
		});
		log.info("knowledge.specialist_contextual_delivery", {
			subjectId: requestRef,
			workRevision: context.revision,
			skillDigest: result.skill.digest,
			documentCount: result.dependencyVersions.length,
			externalDocumentCount: content?.dependencies.filter(
				(source) => source.external,
			).length,
			count: row.usage.sourceCalls,
			decision: content?.decision.strategy,
		});
		return { ...result, situation };
	}

	return {
		handler,
		read,
		attachDialogue(port: Dialogue) {
			dialogue = port;
		},
		async submit(
			input: GuidanceRequest,
			searchTask: string,
			runId: string,
			context: GuidanceReadContext,
		) {
			const ref = await store.write((tx) => {
				context.signal.throwIfAborted();
				context.assertCurrent(tx);
				const auth: Authority = {
					principal: CONVERSATION_DEFAULT_PRINCIPAL,
					scope: specialistScope + context.sessionId,
					epoch: context.sessionEpoch,
					parentRef: runId,
					sourceRefs: [],
					searchTask,
					permissions: ["build"],
				};
				const source = executionSource(tx, auth);
				if (!source) throw Error("guidance_turn_stale");
				auth.sourceRefs = [source.messageId];
				const result = service.submitArtifact(tx, input, auth);
				if (!result.requestRef) throw Error("knowledge_submission_failed");
				return result.requestRef;
			});
			log.info("knowledge.specialist_build_requested", {
				runId,
				subjectId: ref,
			});
			return { kind: "pending" as const, requestRef: ref };
		},
		finishTurn(
			tx: Database,
			sessionId: string,
			runId: string,
			completed: boolean,
		) {
			const row = sqliteRepository.requestByKey(
				tx,
				specialistScope + sessionId,
				runId,
			);
			if (!row || row.authority.parentRef !== runId) return;
			if (!completed) {
				service.cancel(tx, row.ref, row.authority);
				return;
			}
			if (row.outcome) enqueueNotice(tx, row.ref);
			else service.activate(tx, row.ref, row.authority, true);
		},
	};
}
