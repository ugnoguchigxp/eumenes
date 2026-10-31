export { createWebResearch, type WebResearchService } from "./service";
export { registerWebResearch } from "./controller";
export { createWebResearchResourceAdapter } from "./service/resource-adapter";
export { createWebCache, openWebCache } from "./service/cache";
export { createWebAcquisition } from "./adapters/llm-fetch";
export { webToolArguments } from "./adapters/toolchain";
export {
	createWebContentReview,
	contentReviewSchema,
} from "./adapters/content-review";
export type { /** @public */ AcquisitionPort } from "./adapters/llm-fetch";

export { migrations } from "./repository";
