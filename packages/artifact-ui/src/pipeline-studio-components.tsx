import { PipelineStudio } from "@eumenes/design-system";
import { useMemo } from "react";
import { Feedback, useAction } from "./components";
import type { ArtifactEvent, ArtifactRequest, Resource } from "./contracts";
import type { PipelineStudioResource } from "./pipeline-studio-contracts";
import { diffLines } from "./ui-studio-diff";

/**
 * The task pipeline studio: the DesignSystem screen over the host's `pipeline-studio` source. Source
 * apply and publish are write actions; trials, opening a published pipeline and the session
 * operations are local actions of the Web adapter.
 */
export function PipelineStudioView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as Resource | PipelineStudioResource | undefined;
	const work = data?.kind === "pipeline-studio" ? data.work : null;
	// What the last change touched; the host's text is canonical, so a plain line diff is exact.
	const diff = useMemo(
		() => (work ? diffLines(work.previousSource, work.source) : null),
		[work],
	);
	if (data?.kind !== "pipeline-studio") return null;
	const send = (
		event: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	): Promise<boolean> => action.send(event, values);
	const written = (revision: number) =>
		work ? { workRef: work.workRef, expectedRevision: String(revision) } : null;
	return (
		<>
			<PipelineStudio
				title={request.title}
				work={work}
				diff={diff}
				history={data.history}
				session={data.session}
				stoppable={data.stoppable}
				trial={data.trial}
				library={data.library}
				onLibrary={(kind, query, more) =>
					void send("pipeline-library", {
						kind: kind ?? "close",
						query: query ?? "",
						more: String(!!more),
					})
				}
				pending={action.pending}
				result={{ status: action.status, message: action.message }}
				onApply={(text, revision) => {
					const base = written(revision);
					return base
						? send("pipeline-source-apply", { ...base, text })
						: Promise.resolve(false);
				}}
				onPublish={(revision) => {
					const base = written(revision);
					if (base) void send("pipeline-publish", base);
				}}
				onProbe={(query) => void send("pipeline-probe", { query })}
				onSelect={(utterance) => void send("pipeline-select", { utterance })}
				onFixture={(test) =>
					void send("pipeline-fixture", { test: String(test) })
				}
				onOpen={(toolchainId) => void send("pipeline-open", { toolchainId })}
				onRefresh={() => void send("pipeline-refresh")}
				onReturn={() => void send("pipeline-return")}
				onResume={() => void send("pipeline-resume")}
				onClose={() => void send("pipeline-close")}
				onStop={() => void send("pipeline-stop")}
			/>
			<Feedback message={action.message} />
		</>
	);
}
