import { ExternalAppLauncher } from "@eumenes/design-system";
import { useState } from "react";
import type { ArtifactRequest } from "./contracts";
import { useArtifactRuntime } from "./runtime";

export function ExternalAppLauncherView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const runtime = useArtifactRuntime(),
		source = request.source!;
	const data = runtime.snapshot[source];
	const [error, setError] = useState("");
	if (data?.kind !== "external-app-launcher") return null;
	return (
		<ExternalAppLauncher
			label={request.title ?? "別タブで開く"}
			available={data.available}
			busy={data.busy}
			error={error}
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
