export { createCapabilities, zSchema, type Capabilities } from "./service";
export { migration, learnedMigration } from "./repository";
export * from "./contracts";
export { registerCapabilities } from "./controller";
export { migrations } from "./repository";

export {
	validateRequirementSchema,
	requirementValueMatches,
} from "./service/requirement-schema";
