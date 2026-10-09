import { createContext, useContext } from "react";
import type { ArtifactEvent, Receipt, Snapshot } from "./contracts";

export type ArtifactRuntime = {
	snapshot: Snapshot;
	dispatch: (event: ArtifactEvent) => Promise<Receipt>;
	/** Theme controlled by the host's preview toolbar, when present. */
	previewTheme?: "light" | "dark";
};
export const ArtifactRuntimeContext = createContext<ArtifactRuntime | null>(
	null,
);
export function useArtifactRuntime() {
	const runtime = useContext(ArtifactRuntimeContext);
	if (!runtime) throw new Error("Artifact host が必要です");
	return runtime;
}
