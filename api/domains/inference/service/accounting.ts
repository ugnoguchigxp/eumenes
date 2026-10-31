import type { Database } from "bun:sqlite";

/** Full retained set, including failures, unadopted results and service probes. */
export function codexUsageInTransaction(
	db: Database,
	start: number,
	end: number,
) {
	return db
		.query(`SELECT id,connection_id AS connectionId,connection_name AS connectionName,
CASE WHEN usage_observed=1 THEN usage_model ELSE model END AS model,model AS requestedModel,
started,ended,status,session_role AS role,input_tokens AS inputTokens,
output_tokens AS outputTokens,cache_read_tokens AS cacheReadTokens,
cache_creation_tokens AS cacheCreationTokens,reasoning_tokens AS reasoningTokens,
cost_usd AS costUsd,billing_path AS billingPath,usage_observed AS observed
FROM inference_attempts WHERE (connection_kind='codex-sdk' OR billing_path='codex')
AND started>=? AND started<? ORDER BY started DESC,id`)
		.all(start, end) as Array<{
		id: string;
		connectionId: string | null;
		connectionName: string | null;
		model: string | null;
		requestedModel: string | null;
		started: number;
		ended: number | null;
		status: string;
		role: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
		cacheReadTokens: number | null;
		cacheCreationTokens: number | null;
		reasoningTokens: number | null;
		costUsd: number | null;
		billingPath: string | null;
		observed: number;
	}>;
}
