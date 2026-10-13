import {
	definitionRequests,
	parseDefinition,
} from "@eumenes/artifact-ui/contracts";
export const recognitionSource = "object-recognition";
export const recognitionDefinition = () =>
	JSON.stringify({
		view: "object-recognition-workspace",
		source: recognitionSource,
		title: "映っている物を調べる",
	});
export function isRecognitionDefinition(definition: string) {
	try {
		return definitionRequests(parseDefinition(definition)).some(
			(r) => r.view === "object-recognition-workspace",
		);
	} catch {
		return false;
	}
}
