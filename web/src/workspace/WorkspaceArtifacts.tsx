import { DrawingArtifact } from "../domains/excalidraw/DrawingArtifact";
import type { EumenesClient } from "../../../client";
import { useArtifactWorkspace } from "../domains/artifact";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ArtifactPanel } from "../components/domains/artifact/ArtifactPanel";
import { MusicArtifact } from "../components/domains/music/MusicArtifact";
import { ToolchainArtifactHost } from "../domains/toolchain-artifacts/ToolchainArtifactHost";
import { useToolchainArtifacts } from "../domains/toolchain-artifacts";
import { toolchainWebAdapters } from "./toolchain-adapters";

export default function WorkspaceArtifacts({
	client,
	artifacts,
	onCloseTab,
}: {
	client: EumenesClient;
	artifacts: ReturnType<typeof useArtifactWorkspace>;
	/** Closing a tab goes through the specialist session: unsaved work asks first. */
	onCloseTab: (tabId: string) => void;
}) {
	const { openById } = useToolchainArtifacts(client, artifacts.open);
	return artifacts.tabs.length > 0 ? (
		<ErrorBoundary label="artifact">
			<ArtifactPanel
				tabs={artifacts.tabs}
				activeTabId={artifacts.activeTabId}
				onSelect={artifacts.select}
				onClose={onCloseTab}
				renderToolchain={(tab, visible) => (
					<ToolchainArtifactHost
						client={client}
						adapters={toolchainWebAdapters}
						artifactRevisionId={tab.artifactRevisionId}
						artifactId={tab.id}
						variantId={tab.variantId}
						targetRef={tab.targetRef}
						visible={visible}
						onTargetChange={(ref) => artifacts.setTarget(tab.id, ref)}
						onNavigate={openById}
					/>
				)}
				renderOpenUI={(definition) => (
					<>
						{JSON.parse(definition).view === "drawing-workspace" ? (
							<DrawingArtifact client={client} definition={definition} />
						) : (
							<MusicArtifact
								key={definition}
								client={client}
								definition={definition}
							/>
						)}
					</>
				)}
			/>
		</ErrorBoundary>
	) : null;
}
