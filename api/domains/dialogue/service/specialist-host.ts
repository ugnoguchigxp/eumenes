import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import { specialistExecutionSource } from "./specialist-source";
import {
	notifySpecialist,
	specialistAuthority,
	specialistResultText,
} from "./specialist-notices";
import { forgetSessionObservations } from "../repository/specialist-observations";

/** Public host integration for session-scoped sources and child observations. */
export function createSpecialistHost(deps: DialogueDeps) {
	return {
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
