import { ArtifactRenderer } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import type { EumenesClient } from "../../../../client";
import { useImageRuntime } from "./use-image-runtime";
export function ImageArtifact({
	client,
	definition,
	onClose,
}: {
	client: EumenesClient;
	definition: string;
	onClose?: () => void;
}) {
	const { runtime, loading, error } = useImageRuntime(client, "main", onClose);
	if (error) return <p role="alert">画像の情報を取得できませんでした。</p>;
	if (loading) return <output>画像を読み込み中です。</output>;
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
