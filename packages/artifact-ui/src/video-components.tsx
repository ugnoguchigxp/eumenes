import {
	VideoWorkspace,
	type VideoWorkspaceProps,
} from "@eumenes/design-system";
import { useAction } from "./action";
import type { ArtifactRequest } from "./contracts";

export type VideoWorkspaceResource = Omit<
	VideoWorkspaceProps,
	`on${string}` | "title"
> & {
	kind: "video-workspace";
	revision: number;
};

export function VideoWorkspaceView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const resource = action.resource;
	if (
		request.view !== "video-workspace" ||
		resource?.kind !== "video-workspace"
	)
		return null;
	return (
		<VideoWorkspace
			{...resource}
			title={request.title}
			pending={resource.pending || action.pending}
			videos={resource.videos.map((video) => ({
				...video,
				previewSrc:
					video.previewSrc ===
					`/api/videos/${encodeURIComponent(video.id)}/content`
						? video.previewSrc
						: undefined,
			}))}
			onGenerate={(value) =>
				void action.send("video-generate", {
					prompt: value.prompt,
					...(value.title !== undefined ? { title: value.title } : {}),
					...(value.seed !== undefined ? { seed: String(value.seed) } : {}),
					...(value.width !== undefined
						? { width: String(value.width), height: String(value.height) }
						: {}),
					...(value.durationSeconds !== undefined
						? { durationSeconds: String(value.durationSeconds) }
						: {}),
				})
			}
			onRetry={() => void action.send("video-reconcile", {})}
			onCancel={() => void action.send("video-cancel", {})}
			onDelete={(id) => void action.send("video-delete", { id })}
			onSelect={(id) => void action.send("video-select", { id })}
			onRefresh={() => void action.send("video-refresh", {})}
		/>
	);
}
