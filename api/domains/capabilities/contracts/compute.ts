import { z } from "zod";
export const computePythonSubmit = z.strictObject({
	code: z
		.string()
		.min(1)
		.max(65536)
		.describe(
			"Pythonコード。答えをresultへ代入。進捗はreport(message, ratio)、成果物は/work/artifactsに保存。",
		),
	inputs: z
		.record(z.string(), z.json())
		.default({})
		.describe(
			"利用者の数値・表などを渡すJSON object。コードからinputsで参照。",
		),
	timeoutSec: z.number().int().min(1).max(60).default(60),
	accelerator: z.enum(["cpu", "auto"]).default("auto"),
});
export const computeJobTarget = z.strictObject({
	jobId: z.uuid().describe("snapshot.jobs[].idのEumenes発行ID"),
});
export const computeArtifactTarget = computeJobTarget.extend({
	artifactId: z.uuid().describe("そのjobのartifacts[].id"),
});
