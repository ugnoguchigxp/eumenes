import {
	DrawingWorkspace,
	type DrawingWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
export type DrawingResource = Omit<
	DrawingWorkspaceProps,
	"onNew" | "onOpen" | "onRefresh"
> & { kind: "drawing-workspace"; revision: number };
export function DrawingWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request),
		r = action.resource as DrawingResource;
	// URLs come only from the host's runtime snapshot, and stay within the authenticated SPA.
	const url =
		r.url &&
		/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/#drawing\/[a-f0-9-]{36}(\?revision=\d+)?$/.test(
			r.url,
		)
			? r.url
			: undefined;
	return (
		<DrawingWorkspace
			{...r}
			url={url}
			onNew={() => {
				void action.send("drawing-new", {});
			}}
			onOpen={(id) => {
				void action.send("drawing-open", { id });
			}}
			onRefresh={() => {
				void action.send("drawing-refresh", {});
			}}
		/>
	);
}
