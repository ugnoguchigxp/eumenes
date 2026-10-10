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
export function additionalValidationParents(
	db: Database,
	voiceLlmId: string,
	requestIds: string[],
	valid: (db: Database, id: string) => boolean,
) {
	if (new Set(requestIds).size !== requestIds.length || requestIds.length > 4)
		throw new Error("invalid_voice_inference");
	for (const id of requestIds) {
		const r = get(db, id);
		if (
			!r ||
			r.mode !== "control" ||
			r.status !== "accepted" ||
			r.controlPolicyRequestId !== voiceLlmId ||
			!valid(db, id)
		)
			throw new Error("permission_revoked");
	}
	return requestIds;
}
