import { model3dSourceData, type Model3dSourceData } from "./contracts";

/** The OpenUI source name of the screen (`{"view":"model3d-workspace","source":"model3d"}`). */
export const model3dArtifactSource = "model3d";

export function parseSourceData(data: unknown): Model3dSourceData {
	return model3dSourceData.parse(data);
}

/** A cheap numeric digest of the shown state, so the revision changes whenever it does. */
export function revisionOf(value: unknown): number {
	const text = JSON.stringify(value);
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1)
		hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return hash;
}
