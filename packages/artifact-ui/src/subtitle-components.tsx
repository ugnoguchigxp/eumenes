import { SubtitlePreview } from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useArtifactRuntime } from "./runtime";
import type { SubtitlePreviewResource } from "./settings-contracts";

export function SubtitlePreviewView({ request }: { request: ArtifactRequest }) {
	const resource = useArtifactRuntime().snapshot[
		request.source!
	] as SubtitlePreviewResource;
	return (
		<SubtitlePreview
			title={request.title}
			text={resource.text}
			style={resource.style}
			size={resource.size}
			enabled={resource.enabled}
		/>
	);
}
