import type { SpatialModels } from "../contracts";
import { createPlaceholder } from "./placeholder";

/** Replace a factory here; renderers never branch on object IDs or provider names. */
export const spatialModels: SpatialModels = Object.freeze({
	cpu: createPlaceholder,
	memory: createPlaceholder,
	ssd: createPlaceholder,
	network: createPlaceholder,
	provider: createPlaceholder,
});
