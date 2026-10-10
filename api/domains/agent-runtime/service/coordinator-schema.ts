import { z } from "zod";
import { routeSchema, selectSchema } from "../contracts";
import { researchInput } from "../../capabilities";

/** The model may select only a currently issued candidate; host authority is checked again. */
export function coordinatorSchema(
	phase: string,
	candidates: unknown,
	question?: string,
) {
	if (phase === "route") return routeSchema;
	const refs = (Array.isArray(candidates) ? candidates : []).flatMap((c) => {
		const parsed = selectSchema.options[0].shape.candidateRef.safeParse(
			c?.candidateRef,
		);
		return parsed.success ? [parsed.data] : [];
	});
	const alternatives = selectSchema.options.slice(1) as [
		(typeof selectSchema.options)[1],
		(typeof selectSchema.options)[2],
		(typeof selectSchema.options)[3],
	];
	const input = question ? researchInput : z.unknown();
	return refs.length
		? z.discriminatedUnion("action", [
				selectSchema.options[0].extend({
					candidateRef: z.enum(refs as [string, ...string[]]),
					input,
				}),
				...alternatives,
			])
		: z.discriminatedUnion("action", alternatives);
}
