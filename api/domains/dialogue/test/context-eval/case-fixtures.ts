import { type ContextCase, caseSchema } from "../../eval/context/case-schema";

/** A valid case; overrides replace whole top-level fields. */
export function makeCase(
	id: string,
	input: string | null,
	over: Partial<ContextCase> = {},
): ContextCase {
	const match = /^ctx-f(\d+)-(dev|holdout)-\d\d$/.exec(id)!;
	return caseSchema.parse({
		id,
		family: `F${match[1]}`,
		split: match[2],
		seed: {},
		input,
		...(input === null ? { trigger: { kind: "timer" } } : {}),
		expect: {
			checks: [{ kind: "brief_spoken_reply" }],
			rubric: [{ axis: "follows_current_request", condition: "依頼に従う" }],
		},
		...over,
	});
}
