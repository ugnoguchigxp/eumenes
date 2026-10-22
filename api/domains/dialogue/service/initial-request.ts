import type { DialogueDeps, GenerateInput } from "./context";
import { analyzeRequest } from "./request-analysis";
import { settledAnalysis } from "./initial-decision";
import {
	findCandidates,
	prepareRecallQuery,
	retainedCandidates,
} from "./selection-trace";

/**
 * At most two analysis phases: retained functions, then one discovery's four new candidates. A continuation run
 * has one phase: the discovery of its named purpose.
 */
export async function analyzeInitialRequest(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	repair: () => void,
) {
	if (!input.routing || input.agent)
		return { found: undefined, first: undefined };
	// A continuation's purpose is already named: its one discovery searches that, not the retained offer.
	const need = input.routing.continuation?.need;
	if (need) {
		const found = await findCandidates(deps, input, signal, need);
		const first = await analyzeRequest(deps, input, found, signal, repair);
		if (first.analysis.next === "answer" || first.analysis.next === "toolchain")
			await prepareRecallQuery(deps, input, found, signal);
		return { found, first };
	}
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
		const selected = await analyzeRequest(
			deps,
			input,
			found,
			signal,
			repair,
			settledAnalysis(first.analysis),
		);
		first = { ...selected, repaired: first.repaired || selected.repaired };
	}
	if (first.analysis.next === "answer" || first.analysis.next === "toolchain")
		await prepareRecallQuery(deps, input, found, signal);
	return { found, first };
}
