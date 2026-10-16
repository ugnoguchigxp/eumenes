import type { Database } from "bun:sqlite";
import { get } from "../repository";
export function bindControlPolicy(db: Database, id: string, policyId: string) {
	const row = get(db, id);
	if (
		!row ||
		(row.mode === "control" && row.controlPolicyRequestId !== policyId)
	)
		throw new Error("control_policy_conflict");
	db.query(
		"UPDATE inference_requests SET control_policy_request_id=? WHERE id=? AND status='pending' AND control_policy_request_id IS NULL",
	).run(policyId, id);
}
