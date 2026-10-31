export { createCapabilities, zSchema, type Capabilities } from "./service";
export {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
	toolchainPassages,
} from "./service/toolchains";
export * from "./contracts";
export { registerCapabilities } from "./controller";
export { migrations } from "./repository";

export {
	validateRequirementSchema,
	requirementValueMatches,
} from "./service/requirement-schema";

export { dotsMcpSkill } from "./builtin/dots";

export { /** @public */ imageBuiltins } from "./builtin/image";

export { /** @public */ toolchainBuiltins } from "./builtin/toolchains";
export {
	/** @public */ bundleFiles,
	/** @public */ dormantBundleFile,
} from "./service/bundle-files";

export { drawingRequest, drawingPlan } from "./contracts/excalidraw";
