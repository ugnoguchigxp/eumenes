export { createCapabilities, zSchema, type Capabilities } from "./service";
export {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
	toolchainPassages,
} from "./service/toolchains";
export { flatObjectSchema } from "./service/registry";
export { migration, learnedMigration } from "./repository";
export * from "./contracts";
export { registerCapabilities } from "./controller";
export { migrations } from "./repository";

export {
	validateRequirementSchema,
	requirementValueMatches,
} from "./service/requirement-schema";

export { coordinatorSkill } from "./builtin/dots";

export { imageBuiltins } from "./builtin/image";
export { musicBuiltins } from "./builtin/music";

export { toolchainBuiltins } from "./builtin/toolchains";
import { toolchainBuiltins as registeredToolchains } from "./builtin/toolchains";
/** Function names of the builtin toolchains (for detecting call syntax written as text). */
export const builtinToolchainFunctions: readonly string[] =
	registeredToolchains.map((d) => d.functionName!);

export { drawingRequest, drawingPlan } from "./contracts/excalidraw";
