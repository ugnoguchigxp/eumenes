import {
	musicPlan,
	musicPlanV2,
	musicPlanV3,
	type Prepared,
} from "../../capabilities";
import { z } from "zod";
import { delegatedTaskRules } from "../../inference";
/**
 * How long the model may plan a piece or a playback (the run's deadline, less the 15 s kept after it, still bounds
 * it). A local dense model reads the whole plan input without a cache hit: 45 s ran out before it answered.
 */
export const PLAN_MS = 120_000;
export const musicSchema = (prepared: Prepared) =>
	prepared.package.revision >= 3
		? musicPlanV3
		: prepared.package.revision >= 2
			? musicPlanV2
			: musicPlan;
export function musicContext(
	prepared: Prepared,
	request: unknown,
	schema: z.ZodType = musicSchema(prepared),
) {
	const required = [
		prepared.package.profileRevisionId,
		...(prepared.package.requiredSkillRevisionIds ?? []),
	];
	const guidance = required.map(
		(id) => prepared.dependencies.find((d) => d.revisionId === id)?.body,
	);
	if (guidance.some((body) => !body?.trim()))
		throw new Error("required_context_missing");
	const outputSchema = z.toJSONSchema(schema);
	const instructions =
		delegatedTaskRules +
		"\n" +
		guidance.join("\n\n") +
		"\nOUTPUT_SCHEMA=" +
		JSON.stringify(outputSchema);
	return {
		messages: [
			{ role: "system" as const, content: instructions },
			{ role: "user" as const, content: JSON.stringify(request) },
		],
		control: { instructions, outputSchema },
	};
}
