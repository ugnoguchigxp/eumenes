import { ExternalAppLauncher } from "@eumenes/design-system";
import { useState } from "react";
import type { ArtifactRequest, Resource } from "./contracts";
import { useArtifactRuntime } from "./runtime";

export function ExternalAppLauncherView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const runtime = useArtifactRuntime(),
		source = request.source!;
	const data = runtime.snapshot[source];
	if (data?.kind !== "external-app-launcher") return null;
	return (
		<Launcher
			key={`${source}:${data.revision}:${data.available}`}
			request={request}
			source={source}
			data={data}
		/>
	);
}

/** Errors belong to one displayed connection, including an unavailable interval during a switch. */
function Launcher({
	request,
	source,
	data,
}: {
	request: ArtifactRequest;
	source: string;
	data: Extract<Resource, { kind: "external-app-launcher" }>;
}) {
	const runtime = useArtifactRuntime();
	const [error, setError] = useState("");
	return (
		<ExternalAppLauncher
			label={request.title ?? "別タブで開く"}
			available={data.available}
			busy={data.busy}
			preparing={data.preparing}
			error={data.error || error}
			onRetry={data.error ? runtime.refresh : undefined}
			onOpen={() => {
				setError("");
				void runtime
					.dispatch({
						id: crypto.randomUUID(),
						source,
						revision: data.revision,
						action: "external-app-open",
						values: {},
					})
					.then(
						(receipt) => {
							setError(
								receipt.status === "rejected" || receipt.status === "conflict"
									? receipt.message
									: "",
							);
						},
						() => setError("画面を開けませんでした。もう一度お試しください。"),
					);
			}}
		/>
	);
}
