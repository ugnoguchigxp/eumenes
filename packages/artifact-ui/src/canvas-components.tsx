import { CanvasWorkbench } from "@eumenes/design-system";
import { useAction } from "./action";
import type { ArtifactRequest } from "./contracts";

export function CanvasWorkspaceView({ request }: { request: ArtifactRequest }) {
	const { resource } = useAction(request);
	if (resource?.kind !== "canvas-workspace" || !resource.visible) return null;
	return (
		<CanvasWorkbench
			key={resource.conversationId}
			title={request.title || "Canvasアプリ"}
			conversationId={resource.conversationId}
		/>
	);
}
