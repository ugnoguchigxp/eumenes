/** The imported short contract is the only pipeline definition/check implementation. */
import {
	authoringOutcome,
	checkDefinition,
	createCatalogView,
	CONTRACT_VERSION,
	type ComponentRecord,
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
