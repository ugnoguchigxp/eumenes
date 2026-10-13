import {
	ArtifactRenderer,
	definitionRequests,
	parseDefinition,
} from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { useSettingsDraft } from "./SettingsDraftHost";
import { useVoiceSettings } from "./useVoiceSettings";

import { settingsArtifactRuntime } from "./artifact-runtime";
import type { SettingsArtifactId } from "./artifact-definition";

export function SettingsArtifact({
	definition,
	onOpen,
}: {
	definition: string;
	onOpen: (id: SettingsArtifactId) => void;
}) {
	const host = useSettingsDraft();
	if (!host.value)
		return (
			<p role={host.query.isError ? "alert" : "status"}>
				{host.query.isError
					? "設定を読み込めません。APIの接続を確認してください。"
					: "設定を読み込んでいます…"}
			</p>
		);
	if (hasVoiceSource(definition))
		return <VoiceSettingsArtifact definition={definition} onOpen={onOpen} />;
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen)}
		/>
	);
}

function VoiceSettingsArtifact({
	definition,
	onOpen,
}: {
	definition: string;
	onOpen: (id: SettingsArtifactId) => void;
}) {
	const host = useSettingsDraft();
	const voice = useVoiceSettings(host);
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen, voice)}
		/>
	);
}

function hasVoiceSource(definition: string) {
	try {
		return definitionRequests(parseDefinition(definition)).some(
			(r) => r.source === "settings-voice-input",
		);
	} catch {
		return false;
	}
}
