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
import { TimerArtifact } from "../components/domains/timers/TimerArtifact";
import { TimerSetupArtifact } from "../components/domains/timers/TimerSetupArtifact";
import { timerSetupDefinition } from "../domains/timers/artifact-definition";

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
export function useOpenTimer(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		(ref?: { timerId: string }, title = "タイマー") => {
			open(
				ref
					? {
							id: "timer",
							kind: "timer",
							title,
							timerId: ref.timerId,
						}
					: {
							id: "timer",
							kind: "openui",
							title,
							definition: timerSetupDefinition(),
						},
			);
		},
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
	return artifacts.tabs.length > 0 ? (
		<ErrorBoundary label="artifact">
			<ArtifactPanel
				tabs={artifacts.tabs}
				activeTabId={artifacts.activeTabId}
				onSelect={artifacts.select}
				onClose={artifacts.close}
				renderOpenUI={(definition) =>
					definition === timerSetupDefinition() ? (
						<TimerSetupArtifact
							client={client}
							definition={definition}
							onStarted={(ref, title) =>
								artifacts.open({
									id: "timer",
									kind: "timer",
									timerId: ref.timerId,
									title,
								})
							}
						/>
					) : (
						<MusicArtifact
							key={definition}
							client={client}
							definition={definition}
						/>
					)
				}
				renderTimer={(timerId) => (
					<TimerArtifact key={timerId} client={client} timerId={timerId} />
				)}
			/>
		</ErrorBoundary>
	) : null;
}
