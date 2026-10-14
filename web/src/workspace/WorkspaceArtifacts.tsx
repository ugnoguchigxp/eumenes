import {
	DrawingArtifact,
	drawingDefinition,
} from "../domains/excalidraw/DrawingArtifact";
import { ObjectRecognitionArtifact } from "../domains/object-recognition/ObjectRecognitionArtifact";
import {
	isRecognitionDefinition,
	recognitionDefinition,
} from "../domains/object-recognition/artifact-definition";
import {
	imageArtifactDefinition,
	isImageArtifactDefinition,
} from "../domains/image/artifact-definition";
import { ImageArtifact } from "../domains/image/ImageArtifact";
import { SettingsArtifact } from "../domains/settings/SettingsArtifact";
import {
	isSettingsArtifactDefinition,
	settingsArtifacts,
	settingsArtifactDefinition,
	type SettingsArtifactId,
} from "../domains/settings/artifact-definition";
import { useCallback } from "react";
import type { EumenesClient } from "../../../client";
import {
	musicArtifactDefinition,
	playlistArtifactDefinition,
} from "../domains/music/artifact-definition";
import { useArtifactWorkspace } from "../domains/artifact";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ArtifactPanel } from "../components/domains/artifact/ArtifactPanel";
import { MusicArtifact } from "../components/domains/music/MusicArtifact";
import {
	ToolchainArtifactHost,
	useToolchainArtifacts,
} from "../domains/toolchain-artifacts";
import { toolchainWebAdapters } from "./toolchain-adapters";

export function useOpenSettings(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		(id: SettingsArtifactId = "hub") => {
			const entry = settingsArtifacts[id];
			open({
				id: entry.id,
				title: entry.title,
				kind: "openui",
				definition: settingsArtifactDefinition(id),
			});
		},
		[open],
	);
}

export function useOpenRecognition(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "object-recognition",
				kind: "openui",
				title: "映っている物を調べる",
				definition: recognitionDefinition(),
			}),
		[open],
	);
}

export function useOpenDrawing(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "drawing-workspace",
				kind: "openui",
				title: "図を描く・編集する",
				definition: drawingDefinition,
				keepMounted: true,
			}),
		[open],
	);
}
export function useOpenImage(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "image-generation",
				kind: "openui",
				definition: imageArtifactDefinition(),
				title: "画像生成",
			}),
		[open],
	);
}
export function useOpenMusic(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "music-generation",
				kind: "openui",
				definition: musicArtifactDefinition(),
				title: "楽曲生成",
			}),
		[open],
	);
}
export function useOpenPlaylist(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "music-playlist",
				kind: "openui",
				definition: playlistArtifactDefinition(),
				title: "音楽プレイリスト",
			}),
		[open],
	);
}
export function WorkspaceArtifacts({
	client,
	artifacts,
}: {
	client: EumenesClient;
	artifacts: ReturnType<typeof useArtifactWorkspace>;
}) {
	const openSettings = useOpenSettings(artifacts.open);
	const { openById } = useToolchainArtifacts(client, artifacts.open);
	return artifacts.tabs.length > 0 ? (
		<ErrorBoundary label="artifact">
			<ArtifactPanel
				tabs={artifacts.tabs}
				activeTabId={artifacts.activeTabId}
				onSelect={artifacts.select}
				onClose={artifacts.close}
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
						) : isSettingsArtifactDefinition(definition) ? (
							<SettingsArtifact definition={definition} onOpen={openSettings} />
						) : isRecognitionDefinition(definition) ? (
							<ObjectRecognitionArtifact
								client={client}
								definition={definition}
							/>
						) : isImageArtifactDefinition(definition) ? (
							<ImageArtifact
								client={client}
								definition={definition}
								onClose={() => artifacts.close(artifacts.activeTabId!)}
							/>
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
