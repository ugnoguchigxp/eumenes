import { ArtifactRenderer } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import { useRecognitionRuntime } from "./use-recognition-runtime";
export function ObjectRecognitionArtifact({
	client,
	definition,
}: {
	client: EumenesClient;
	definition: string;
}) {
	const { runtime } = useRecognitionRuntime(client);
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
