import { musicStudioSource } from "./artifact-definition";

export function musicArtifactDefinition(id?: string) {
	return JSON.stringify({
		view: "music-workspace",
		source: id === undefined ? musicStudioSource : `music-${id}`,
		title: "音楽・効果音生成",
	});
}
