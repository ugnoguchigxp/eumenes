/** The imported short contract is the only pipeline definition/check implementation. */
import {
	authoringOutcome,
	bindSourceRequest,
	checkDefinition,
	createCatalogView,
	CONTRACT_VERSION,
	parseJsonStrict,
	type ComponentRecord,
	type PipelineDefinition,
} from "eumenes-pipeline";
export { CONTRACT_VERSION };
export function checkPipelineDefinition(
	raw: unknown,
	records: readonly ComponentRecord[],
	sourceRequest: string,
) {
	const catalog = createCatalogView(records, {
		version: CONTRACT_VERSION,
		offer: (r) => r.enabled && r.support !== "excluded",
	});
	return checkDefinition(raw, catalog, { sourceRequest });
}
export function parsePipelineOutcome(raw: unknown) {
	return authoringOutcome.safeParse(raw);
}
/** Planner output is read strictly: duplicate keys and excess nesting are structural defects. */
export function parsePipelineJson(text: string) {
	return parseJsonStrict(text);
}
/**
 * The host owns the original request: a model's copy is replaced before checking and returned as
 * evidence, so a copying slip neither reaches the plan nor goes unrecorded.
 */
export function bindPipelineRequest(
	definition: PipelineDefinition,
	sourceRequest: string,
) {
	return bindSourceRequest(definition, sourceRequest);
}
