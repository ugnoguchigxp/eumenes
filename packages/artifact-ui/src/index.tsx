import { Renderer } from "@openuidev/react-lang";
import { artifactLibrary } from "./library";
import { ArtifactRuntimeContext, type ArtifactRuntime } from "./runtime";
export { compileArtifact, compileLang } from "./compiler";
export { artifactLibrary } from "./library";
export * from "./contracts";
export type { ArtifactRuntime } from "./runtime";

/** Host supplies validated Lang and authorized data. No SDK toolProvider is installed. */
export function ArtifactRenderer({ lang, runtime }: { lang: string; runtime: ArtifactRuntime }) {
	return <ArtifactRuntimeContext.Provider value={runtime}><div className="artifact-ui"><Renderer response={lang} library={artifactLibrary} isStreaming={false} publishObservability={false}/></div></ArtifactRuntimeContext.Provider>;
}
