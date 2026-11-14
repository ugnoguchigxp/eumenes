import type { Database } from "bun:sqlite";
import { appDigest, type AppDevelopment } from "../../domains/app-development";
import { appReviewInput } from "../../domains/capabilities";
import type {
	AdapterOrigin,
	SpecialistInvocation,
} from "../../domains/tool-runtime";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { createReviewSubagent } from "../review/subagent";

export const appReviewOperation = "app-development.review";

type Specialist = Extract<AdapterOrigin, { kind: "specialist" }>;
type Source = {
	request: string;
	conversationId: string;
	messageId: string;
	specialistEpoch?: number;
};
type Review = NonNullable<ReturnType<typeof createReviewSubagent>>;
type Prepared = { result: Awaited<ReturnType<Review>>; epoch: number };
type Dependencies = {
	store: Pick<SqliteStore, "read">;
	evaluate(): ReturnType<typeof createReviewSubagent>;
	source(
		db: Database,
		runId: string,
		sessionId: string,
		epoch?: number,
	): Source | null;
};

export function createAppReview(apps: AppDevelopment, deps: Dependencies) {
	function snapshot(
		db: Database,
		origin: Specialist,
		revision: number,
		epoch?: number,
	) {
		const source = deps.source(db, origin.runId, origin.sessionId, epoch);
		if (
			source?.specialistEpoch === undefined ||
			source.conversationId !== origin.conversationId
		)
			throw new Error("app_source_unavailable");
		const work = apps.draft(db, origin.workRef);
		if (
			work.sessionId !== origin.sessionId ||
			!apps.storage.available(db, work.appId)
		)
			throw new Error("work_not_found");
		if (work.revision !== revision) throw new Error("revision_conflict");
		if (!work.draft) throw new Error("app_draft_unavailable");
		return {
			draft: work.draft,
			request: work.request,
			source,
			epoch: source.specialistEpoch,
		};
	}
	return {
		async prepare(
			input: SpecialistInvocation,
			signal: AbortSignal,
		): Promise<Prepared> {
			const evaluate = deps.evaluate();
			if (!evaluate) throw new Error("review_unavailable");
			const { origin } = input;
			const { expectedRevision, skill } = appReviewInput.parse(input.input);
			const { draft, request, source, epoch } = deps.store.read((db) =>
				snapshot(db, origin, expectedRevision),
			);
			const result = await evaluate(
				{
					skill,
					target: { id: origin.workRef, version: String(expectedRevision) },
					originalRequest: request,
					request: source.request,
					conditions: { state: "none" },
					evidence: [{ id: "app-draft", document: draft }],
					sourceMessageIds: [source.messageId],
				},
				Date.now() + 120_000,
				signal,
				(db) => {
					snapshot(db, origin, expectedRevision, epoch);
					return true;
				},
			);
			return { result, epoch };
		},
		adopt(
			db: Database,
			origin: Specialist,
			input: unknown,
			prepared: unknown,
			requestId: string,
		) {
			const { expectedRevision } = appReviewInput.parse(input);
			const evaluation = prepared as Prepared | undefined;
			if (!evaluation) throw new Error("review_unavailable");
			snapshot(db, origin, expectedRevision, evaluation.epoch);
			return {
				receipt: evaluation.result,
				receiptRef: {
					owner: "app-development",
					operationId: requestId,
					digest: appDigest(evaluation.result),
				},
				resultRefs: [],
				replay: false,
				answerContext: { revision: expectedRevision, ...evaluation.result },
			};
		},
	};
}
