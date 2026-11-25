import type { LlmPort, LlmRequest } from "eumenes-agency";
import { planSchema } from "eumenes-agency/agenda";
import { z } from "zod";

const addition = planSchema.shape.add.element.extend({
	researchSource: z.enum(["public", "work"]).nullable(),
});
export const backgroundPlanSchema = planSchema.extend({
	add: addition.array().max(7),
});

/** The model chooses the source. Only its public research proposals reach the external researcher. */
export async function completeBackgroundPlan<T>(
	llm: LlmPort,
	request: LlmRequest<T>,
	signal: AbortSignal,
	eligible: (research: { text: string; refs: string[] }) => boolean,
) {
	if (!Object.is(request.schema, planSchema))
		return llm.complete(request, signal);
	const result = await llm.complete(
		{ ...request, schema: backgroundPlanSchema },
		signal,
	);
	signal.throwIfAborted();
	const add = result.value.add
		.filter(
			(item) =>
				item.kind !== "research" ||
				(item.researchSource === "public" && eligible(item)),
		)
		.map(({ researchSource: _source, ...item }) => item);
	return { ...result, value: request.schema.parse({ ...result.value, add }) };
}
