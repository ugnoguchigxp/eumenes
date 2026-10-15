import { ActivityTimeline, type ActivityEntry } from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";

export type ActivityResource = {
	kind: "activity-timeline";
	revision: number;
	entries: ActivityEntry[];
	connected: boolean;
	emptyText?: string;
};
export function ActivityTimelineView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const resource = action.resource;
	if (resource?.kind !== "activity-timeline") return null;
	return (
		<ActivityTimeline
			title={request.title}
			entries={resource.entries}
			connected={resource.connected}
			emptyText={resource.emptyText}
		/>
	);
}
