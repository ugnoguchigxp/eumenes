import { imagePlan, type Prepared } from "../../capabilities";
import { z } from "zod";
export function imageContext(
	prepared: Prepared,
	request: unknown,
	schema: z.ZodType = imagePlan,
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
	const tools = prepared.package.toolRevisionIds?.map((id) =>
		prepared.dependencies.find((d) => d.revisionId === id),
	);
	if (!tools?.length || tools.some((t) => !t))
		throw new Error("required_tool_missing");
	const instructions =
		guidance.join("\n\n") +
		"\nTOOLS=" +
		JSON.stringify(
			tools!.map((t) => ({ title: t!.title, summary: t!.summary })),
		) +
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
