export {
	createUiCompositions,
	type Caller,
	type UiCompositionsService,
} from "./service";
export {
	checkDefinitionText as checkUiDefinitionText,
	limits as uiCompositionLimits,
} from "./contracts";
export { migrations } from "./repository";
export { createUiCompositionResourceAdapter } from "./service/resource-adapter";
