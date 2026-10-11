import { ArtifactRenderer } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import type { EumenesClient } from "../../../../../client";
import { useMusicRuntime } from "../../../domains/music/use-music-runtime";

/** Music supplies authorized runtime data; all presentation comes from the stored JSON. */
export function MusicArtifact({
	client,
	definition,
	conversationId = "main",
}: {
	client: EumenesClient;
	definition: string;
	conversationId?: string;
}) {
	const { runtime, loading, error } = useMusicRuntime(
		client,
		conversationId,
		definition,
	);
	if (error) return <p role="alert">楽曲の情報を取得できませんでした。</p>;
	if (loading) return <output>楽曲を読み込み中です。</output>;
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
