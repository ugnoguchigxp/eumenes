import type { Database } from "bun:sqlite";
import type { Settings } from "../../settings/contracts";
/** Control requests authorized by their host operation, independent of a dialogue parent. */
export function createIndependentControls(
	snapshotInTransaction: (db: Database) => Settings,
	capture: (
		db: Database,
		subject: string,
		purpose: "llm",
		deadline: number,
		snapshot: Settings,
	) => string,
) {
	return {
		/**
		 * Host-only control request that does not depend on a pending parent
		 * (e.g. after the source answer was accepted). Uses the *current* settings
		 * snapshot, LARM only, exact context, never inherits another deadline.
		 * `structuredOutput` makes the output schema a strict provider schema (see `controlJsonOptions`).
		 */
		captureMaintenanceControlInTransaction(
			db: Database,
			input: {
				subject: string;
				deadline: number;
				maxOutputTokens: number;
				structuredOutput?: boolean;
			},
		) {
			if (!input.subject || input.deadline <= Date.now())
				throw new Error("invalid_maintenance_control");
			const snapshot = structuredClone(snapshotInTransaction(db));
			snapshot.routes.llm.mode = "larm-only";
			snapshot.routes.llm.cloudAllowed = false;
			const requestId = capture(
				db,
				input.subject,
				"llm",
				input.deadline,
				snapshot,
			);
			db.query(
				"UPDATE inference_requests SET mode='control',output_limit=?,context_policy='exact',parents='[]' WHERE id=? AND status='pending'",
			).run(Math.min(2048, Math.max(1, input.maxOutputTokens)), requestId);
			if (input.structuredOutput)
				db.query(
					"UPDATE inference_requests SET structured_output=1 WHERE id=?",
				).run(requestId);
			return requestId;
		},
		captureUserControlInTransaction(
			db: Database,
			input: {
				subject: string;
				deadline: number;
				maxOutputTokens: number;
				route?: "subagent";
				structuredOutput?: boolean;
			},
		) {
			if (
				!/^[a-z][a-z0-9_-]{1,39}:[a-zA-Z0-9-]{1,160}$/.test(input.subject) ||
				!Number.isSafeInteger(input.deadline) ||
				input.deadline <= Date.now() ||
				input.deadline > Date.now() + 120_000 ||
				!Number.isSafeInteger(input.maxOutputTokens) ||
				input.maxOutputTokens < 1 ||
				input.maxOutputTokens > 8192
			)
				throw new Error("invalid_user_control");
			const snapshot = structuredClone(snapshotInTransaction(db));
			if (input.route !== "subagent") {
				snapshot.routes.llm.mode = "larm-only";
				snapshot.routes.llm.cloudAllowed = false;
			}
			const requestId = capture(
				db,
				input.subject,
				"llm",
				input.deadline,
				snapshot,
			);
			db.query(
				"UPDATE inference_requests SET mode='control',output_limit=?,context_policy='exact',parents='[]' WHERE id=? AND status='pending'",
			).run(input.maxOutputTokens, requestId);
			if (input.structuredOutput)
				db.query(
					"UPDATE inference_requests SET structured_output=1 WHERE id=?",
				).run(requestId);
			return requestId;
		},
	};
}
