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
import { TimerArtifact } from "../components/domains/timers/TimerArtifact";
import { TimerSetupArtifact } from "../components/domains/timers/TimerSetupArtifact";
import {
	timerSetupDefinition,
	timerDefinition,
	timerArtifactSource,
	timerSetupSource,
} from "../domains/timers/artifact-definition";

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
			open({
				id: "timer",
				kind: "openui",
				title,
				definition: ref ? timerDefinition(ref.timerId) : timerSetupDefinition(),
			});
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
	const openTimer = useOpenTimer(artifacts.open);
	const openSettings = useOpenSettings(artifacts.open);
	return artifacts.tabs.length > 0 ? (
		<ErrorBoundary label="artifact">
			<ArtifactPanel
				tabs={artifacts.tabs}
				activeTabId={artifacts.activeTabId}
				onSelect={artifacts.select}
				onClose={artifacts.close}
				renderOpenUI={(definition) =>
					isSettingsArtifactDefinition(definition) ? (
						<SettingsArtifact definition={definition} onOpen={openSettings} />
					) : timerArtifactSource(definition) === timerSetupSource ? (
						<TimerSetupArtifact
							client={client}
							definition={definition}
							onStarted={openTimer}
						/>
					) : timerArtifactSource(definition) ? (
						<TimerArtifact
							key={definition}
							client={client}
							timerId={timerArtifactSource(definition)!.slice(6)}
							definition={definition}
							onNewTimer={() => openTimer()}
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
					<TimerArtifact
						key={timerId}
						client={client}
						timerId={timerId}
						onNewTimer={() => openTimer()}
					/>
				)}
			/>
		</ErrorBoundary>
	) : null;
}
