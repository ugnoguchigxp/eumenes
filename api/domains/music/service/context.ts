import { musicPlan, musicPlanV2, type Prepared } from "../../capabilities";
import { z } from "zod";
import { delegatedTaskRules } from "../../inference";
export function musicContext(
	prepared: Prepared,
	request: unknown,
	schema: z.ZodType = prepared.package.revision >= 2 ? musicPlanV2 : musicPlan,
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
