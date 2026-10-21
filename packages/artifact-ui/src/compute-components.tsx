import {
	ComputeWorkspace,
	type ComputeWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
export type ComputeWorkspaceResource = Pick<
	ComputeWorkspaceProps,
	"jobs" | "available" | "selectedJobId"
> & { kind: "compute"; revision: number };
export function ComputeWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const resource = action.resource;
	if (resource?.kind !== "compute") return null;
	return (
		<ComputeWorkspace
			key={resource.selectedJobId}
			jobs={resource.jobs.map((j) => ({
				...j,
				artifacts: j.artifacts.map((a) => ({
					...a,
					url:
						a.mime === "image/png" && a.url?.startsWith("blob:")
							? a.url
							: undefined,
				})),
			}))}
			selectedJobId={resource.selectedJobId}
			available={resource.available}
			pending={action.pending}
			message={action.message}
			onCancel={(id) => {
				void action.send("compute-cancel", { jobId: id });
			}}
			onReconcile={(id) => {
				void action.send("compute-reconcile", { jobId: id });
			}}
			onRefresh={() => {
				void action.send("compute-refresh", {});
			}}
			onDownload={(jobId, artifactId, name) => {
				void action.send("compute-download", { jobId, artifactId, name });
			}}
		/>
	);
}
