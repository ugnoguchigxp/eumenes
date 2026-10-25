export { createOcr, type OcrService } from "./service";
export { registerOcr } from "./controller";
export { migrations } from "./repository";
export { list as ocrListInTransaction } from "./repository";
export {
	createOcrResourceAdapter,
	DOCUMENT_RESOURCE_KIND,
} from "./service/resource-adapter";
