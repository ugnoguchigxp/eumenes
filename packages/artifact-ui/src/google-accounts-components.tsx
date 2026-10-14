import {
	GoogleAccounts,
	type GoogleAccountsProps,
} from "@eumenes/design-system";
import { useState } from "react";
import type { ArtifactRequest, ArtifactEvent } from "./contracts";
import { useArtifactRuntime } from "./runtime";
export type GoogleAccountsResource = Omit<
	GoogleAccountsProps,
	"onConnect" | "onCancel" | "onDisconnect" | "onBack"
> & { kind: "google-accounts"; revision: number };
export function GoogleAccountsView({ request }: { request: ArtifactRequest }) {
	const runtime = useArtifactRuntime();
	const [error, setError] = useState("");
	const resource = runtime.snapshot[request.source!] as GoogleAccountsResource;
	function send(action: ArtifactEvent["action"]) {
		void runtime
			.dispatch({
				id: crypto.randomUUID(),
				source: request.source!,
				revision: resource.revision,
				action,
				values: {},
			})
			.then((receipt) =>
				setError(receipt.status === "accepted" ? "" : receipt.message),
			)
			.catch(() =>
				setError("操作を完了できませんでした。もう一度お試しください。"),
			);
	}
	return (
		<GoogleAccounts
			{...resource}
			message={error || resource.message}
			onConnect={() => send("google-connect")}
			onCancel={() => send("google-cancel")}
			onDisconnect={() => send("google-disconnect")}
			onBack={() => send("google-back")}
		/>
	);
}
