import { caseFilesOf, parseCaseFiles } from "../../eval/context/case-loader";
import { type ContextCase, caseSchema } from "../../eval/context/case-schema";

/**
 * The cases the recorded experiment still holds in a form the harness reads. Its work-state cases (F5, F14) seed the
 * TODO ledger, which is retired: those files stay as the record they are and are left out here.
 */
export function loadRecordedCases(experimentDir: string): ContextCase[] {
	return parseCaseFiles(
		caseFilesOf(experimentDir).filter(
			({ text }) => caseSchema.safeParse(JSON.parse(text)).success,
		),
	);
}

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
