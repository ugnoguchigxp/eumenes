import {
	definitionRequests,
	parseDefinition,
} from "@eumenes/artifact-ui/contracts";
export const imageStudioSource = "image-studio";
export function imageArtifactDefinition() {
	return JSON.stringify({
		view: "image-workspace",
		source: imageStudioSource,
		title: "画像生成",
		presentation: "embedded",
	});
}

export function isImageArtifactDefinition(definition: string) {
	try {
		return definitionRequests(parseDefinition(definition)).some(
			(request) => request.view === "image-workspace",
		);
	} catch {
		return false;
	}
}
