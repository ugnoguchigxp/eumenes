import { collaborationState } from "../repository/collaboration-state";
import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import {
	hasSpecialistContribution,
	specialistExecutionResponse,
	specialistExecutionSource,
} from "./specialist-source";
import {
	notifySpecialist,
	specialistAuthority,
	specialistResultText,
} from "./specialist-notices";
import { forgetSessionObservations } from "../repository/specialist-observations";
import { specialistReviewConditions } from "./collaboration-state";
import { specialistHandoffMaterials } from "./specialist-handoff-context";

/** Public host integration for session-scoped sources and child observations. */
export function createSpecialistHost(deps: DialogueDeps) {
	return {
		specialistHandoffReferencesInTransaction: (
			db: Database,
			sessionId: string,
		) => specialistHandoffMaterials(deps, db, sessionId),
		specialistContributionInTransaction: (
			db: Database,
			input: Parameters<typeof hasSpecialistContribution>[2],
		) => hasSpecialistContribution(deps, db, input),
		specialistExecutionResponseInTransaction: (
			db: Database,
			conversationId: string,
			messageId: string,
			sessionId: string,
		) =>
			specialistExecutionResponse(
				deps,
				db,
				conversationId,
				messageId,
				sessionId,
			),
		specialistReviewConditionsInTransaction: (
			db: Database,
			sessionId: string,
		) => specialistReviewConditions(deps, db, sessionId),
		specialistCollaborationState: (sessionId: string): unknown =>
			deps.store.read((db) => {
				const row = collaborationState(db, sessionId);
				return row ? JSON.parse(row.body) : null;
			}),
		forgetSpecialistObservationsInTransaction: forgetSessionObservations,
		specialistResultTextInTransaction: (
			db: Database,
			sessionId: string,
			childId: string,
		) => specialistResultText(deps, db, sessionId, childId),
		specialistExecutionSourceInTransaction: (
			db: Database,
			runId: string,
			expectedSession?: string,
			expectedEpoch?: number,
		) =>
			specialistExecutionSource(
				deps,
				db,
				runId,
				expectedSession,
				expectedEpoch,
			),
		specialistAuthorityInTransaction: (db: Database, sessionId: string) =>
			specialistAuthority(deps, db, sessionId),
		notifySpecialistInTransaction: (
			db: Database,
			input: Parameters<typeof notifySpecialist>[2],
		) => notifySpecialist(deps, db, input),
		async notifySpecialist(input: Parameters<typeof notifySpecialist>[2]) {
			const accepted = await deps.store.write((db) =>
				notifySpecialist(deps, db, input),
			);
			if (accepted) deps.queue.wake();
			return accepted;
		},
	};
}
