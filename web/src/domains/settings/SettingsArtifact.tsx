import {
	ArtifactRenderer,
	definitionRequests,
	parseDefinition,
	type ArtifactRuntime,
} from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { useSettingsDraft } from "./SettingsDraftHost";
import { useVoiceSettings } from "./useVoiceSettings";
import { useRecordsRuntime } from "./useRecordsRuntime";

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
	if (hasSource(definition, "settings-records"))
		return <RecordsSettingsArtifact definition={definition} onOpen={onOpen} />;
	if (hasSource(definition, "settings-voice-input"))
		return <VoiceSettingsArtifact definition={definition} onOpen={onOpen} />;
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen)}
		/>
	);
}

function RecordsSettingsArtifact({
	definition,
	onOpen,
}: {
	definition: string;
	onOpen: (id: SettingsArtifactId) => void;
}) {
	const host = useSettingsDraft();
	const records = useRecordsRuntime(host.client, true);
	if (hasSource(definition, "settings-voice-input"))
		return (
			<VoiceSettingsArtifact
				definition={definition}
				onOpen={onOpen}
				records={records}
			/>
		);
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen, undefined, records)}
		/>
	);
}

function VoiceSettingsArtifact({
	definition,
	onOpen,
	records,
}: {
	definition: string;
	onOpen: (id: SettingsArtifactId) => void;
	records?: ArtifactRuntime;
}) {
	const host = useSettingsDraft();
	const voice = useVoiceSettings(host);
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen, voice, records)}
		/>
	);
}

function hasSource(definition: string, source: string) {
	try {
		return definitionRequests(parseDefinition(definition)).some(
			(r) => r.source === source,
		);
	} catch {
		return false;
	}
}
