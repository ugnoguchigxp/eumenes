export { createCapabilities, zSchema, type Capabilities } from "./service";
export {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
	toolchainPassages,
} from "./service/toolchains";
export { migration, learnedMigration } from "./repository";
export * from "./contracts";
export { registerCapabilities } from "./controller";
export { migrations } from "./repository";

export {
	validateRequirementSchema,
	requirementValueMatches,
} from "./service/requirement-schema";

export { coordinatorSkill, dotsMcpSkill } from "./builtin/dots";

export { imageBuiltins } from "./builtin/image";
export { musicBuiltins } from "./builtin/music";

export { toolchainBuiltins } from "./builtin/toolchains";
import { toolchainBuiltins as registeredToolchains } from "./builtin/toolchains";
import { bundleToolchainFunctions } from "./service/bundle-files";
export { dormantBundleFile } from "./service/bundle-files";
/**
 * Function names of the builtin toolchains and of those shipped in bundles (for detecting
 * call syntax written as text).
 */
export const builtinToolchainFunctions: readonly string[] = [
	// A toolchain keeps its function name across revisions.
	...new Set([
		...registeredToolchains.map((d) => d.functionName!),
		...bundleToolchainFunctions(),
	]),
];

export { drawingRequest, drawingPlan } from "./contracts/excalidraw";
