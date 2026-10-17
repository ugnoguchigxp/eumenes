/** One model call as recorded in raw.jsonl. Scoring and analysis re-run offline from these rows. */
import { z } from "zod";

export const LANES = ["fixture", "live"] as const;
export type Lane = (typeof LANES)[number];

export const SERIALIZATIONS = ["larm-messages", "flattened"] as const;
export type Serialization = (typeof SERIALIZATIONS)[number];

export const rawRowSchema = z
	.object({
		lane: z.enum(LANES),
		arm: z.string().min(1),
		caseId: z.string().min(1),
		trial: z.number().int().min(1),
		/**
		 * ok: an answer came back. contract_failure: the generation contract was not met even after the one
		 * structural correction (a model result, scored as a failure). transport_error: no model result (counted apart).
		 */
		status: z.enum(["ok", "transport_error", "contract_failure"]),
		answer: z
			.object({
				text: z.string(),
				toolCalls: z.array(
					z
						.object({ name: z.string(), arguments: z.string().optional() })
						.strict(),
				),
			})
			.strict()
			.optional(),
		/** The one structural correction was used. */
		repaired: z.boolean(),
		errorCode: z.string().optional(),
		startedAt: z.string(),
		latencyMs: z.number().min(0),
		messageCount: z.number().int().min(0),
		promptBytes: z.number().int().min(0),
		/** The product's token estimate (`estimateMessageTokens`) of the messages sent; only ratios between arms are used. */
		promptTokensEstimate: z.number().int().min(0),
		promptSha256: z.string(),
	})
	.strict();
export type RawRow = z.infer<typeof rawRowSchema>;

export function parseRawLines(text: string): RawRow[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line, index) => {
			try {
				return rawRowSchema.parse(JSON.parse(line));
			} catch {
				throw new Error(`context_eval_raw_row_invalid:line_${index + 1}`);
			}
		});
}

/** run.json: what a run directory was made from. */
export const runMetaSchema = z
	.object({
		format: z.literal("context-eval.run"),
		experiment: z.string().min(1),
		lane: z.enum(LANES),
		/** How the arms' messages reached the model (evaluation design section 6.2). */
		serialization: z.enum(SERIALIZATIONS),
		split: z.enum(["dev", "holdout", "all"]),
		startedAt: z.string(),
		/** sha256 of manifest.json when the run was made, else null (nothing frozen yet). */
		manifestSha256: z.string().nullable(),
		/** Live only: sha256 of the saved LARM connection settings the run read. Null for the fixture lane. */
		settingsSnapshot: z.string().nullable(),
		arms: z.array(z.string().min(1)).min(1),
		baseline: z.string().min(1),
		trials: z.number().int().min(1),
		concurrency: z.number().int().min(1),
		caseIds: z.array(z.string().min(1)).min(1),
		/** Present when this directory is a sanctioned re-run of the transport errors of another run. */
		rerunOf: z
			.object({
				runDir: z.string(),
				sourceRawSha256: z.string(),
				/** `arm|caseId|trial` of every row that was replaced. */
				replaced: z.array(z.string()),
			})
			.strict()
			.optional(),
	})
	.strict();
export type RunMeta = z.infer<typeof runMetaSchema>;

export const rowKey = (row: Pick<RawRow, "arm" | "caseId" | "trial">) =>
	`${row.arm}|${row.caseId}|${row.trial}`;

/** Rows must belong to the run they sit in: known arm and case, trial in range, one row per (arm, case, trial). */
export function rawRowIssues(rows: readonly RawRow[], meta: RunMeta): string[] {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const key = rowKey(row);
		if (row.lane !== meta.lane) issues.push(`${key}: lane_mismatch`);
		if (!meta.arms.includes(row.arm)) issues.push(`${key}: unknown_arm`);
		if (!meta.caseIds.includes(row.caseId)) issues.push(`${key}: unknown_case`);
		if (row.trial < 1 || row.trial > meta.trials)
			issues.push(`${key}: trial_out_of_range`);
		if (seen.has(key)) issues.push(`${key}: duplicate_row`);
		seen.add(key);
	}
	return issues;
}
