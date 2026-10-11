import { musicPlan, type Prepared } from "../../capabilities";
import { z } from "zod";
export function musicContext(prepared: Prepared, request: unknown) {
	const required = [
		prepared.package.profileRevisionId,
		...(prepared.package.requiredSkillRevisionIds ?? []),
	];
	const guidance = required.map(
		(id) => prepared.dependencies.find((d) => d.revisionId === id)?.body,
	);
	if (guidance.some((body) => !body?.trim()))
		throw new Error("required_context_missing");
	const outputSchema = z.toJSONSchema(musicPlan);
	const instructions =
		guidance.join("\n\n") + "\nOUTPUT_SCHEMA=" + JSON.stringify(outputSchema);
	return {
		messages: [
			{ role: "system" as const, content: instructions },
			{ role: "user" as const, content: JSON.stringify(request) },
		],
		control: { instructions, outputSchema },
	};
}
