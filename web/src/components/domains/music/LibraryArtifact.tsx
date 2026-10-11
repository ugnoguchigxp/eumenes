import { ArtifactRenderer } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../../client";
import { useLibraryRuntime } from "../../../domains/music/use-library-runtime";
export function LibraryArtifact({
	client,
	definition,
	conversationId,
}: {
	client: EumenesClient;
	definition: string;
	conversationId: string;
}) {
	const { runtime, loading, error, retry } = useLibraryRuntime(
		client,
		conversationId,
		definition,
	);
	if (error)
		return (
			<div role="alert">
				<p>プレイリストを取得できませんでした。</p>
				<button
					onClick={() => {
						void retry();
					}}
				>
					再試行
				</button>
			</div>
		);
	if (loading) return <output>プレイリストを準備しています。</output>;
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
