/**
 * The studio's checks of a composition for the backend: the views and directions it may use,
 * the meaning check and the model's values. Kept apart from `contracts` so the browser's
 * initial bundle does not carry the expression engine.
 */
export {
	compositionDirections,
	compositionViews,
	type CompositionModelDefinition,
} from "./composition-contracts";
export { computeValues } from "./composition-compute";
export { validateComposition } from "./composition-validate";
