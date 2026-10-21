import type { DialogueDeps, GenerateInput } from "./context";
import { analyzeRequest } from "./request-analysis";
import {
	findCandidates,
	prepareRecallQuery,
	retainedCandidates,
} from "./selection-trace";

/** At most two analysis phases: retained functions, then one discovery's four new candidates. */
export async function analyzeInitialRequest(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	repair: () => void,
) {
	if (!input.routing || input.agent)
		return { found: undefined, first: undefined };
	let found = retainedCandidates(deps, input);
	let first = await analyzeRequest(deps, input, found, signal, repair);
	if (first.analysis.next === "find_toolchain") {
		const excluded = new Set(found.route.cards.map((card) => card.revisionId));
		const searched = await findCandidates(
			deps,
			input,
			signal,
			first.analysis.query,
			excluded,
		);
		found = { ...searched, started: found.started };
		const selected = await analyzeRequest(deps, input, found, signal, repair);
		first = { ...selected, repaired: first.repaired || selected.repaired };
	}
	if (first.analysis.next === "answer" || first.analysis.next === "toolchain")
		await prepareRecallQuery(deps, input, found, signal);
	return { found, first };
}
