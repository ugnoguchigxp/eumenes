import type { Database } from "bun:sqlite";
import type { Invocation } from "../contracts";

/** Includes superseded executions so budget and provenance checks remain complete. */
export function invocationHistory(db: Database, taskId: string) {
	return (
		db
			.query(
				"SELECT * FROM tool_invocations WHERE owner_task_id=? ORDER BY created_at,id",
			)
			.all(taskId) as Invocation[]
	).map((r) => ({
		id: r.id,
		arguments: r.args_json ? (JSON.parse(r.args_json) as unknown) : undefined,
		operationFingerprint: r.operation_fingerprint ?? null,
		toolRevisionId: r.tool_revision_id,
		stepId: r.step_id,
		argsDigest: r.args_digest,
		state: r.state,
		origin: (r.origin ?? "tool") as "tool" | "candidate-cache",
		superseded: !!r.superseded,
	}));
}
