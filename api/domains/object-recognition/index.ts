export {
	createObjectRecognition,
	type ObjectRecognitionService,
} from "./service";
export {
	registerObjectRecognition,
	type RecognitionSharing,
} from "./controller";
export type { ImageMaterial } from "./service/handoff";
export { migrations } from "./repository";
export { list as recognitionListInTransaction } from "./repository";
