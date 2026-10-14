export {
	createObjectRecognition,
	type ObjectRecognitionService,
} from "./service";
export { registerObjectRecognition } from "./controller";
export { migrations } from "./repository";
export { list as recognitionListInTransaction } from "./repository";
