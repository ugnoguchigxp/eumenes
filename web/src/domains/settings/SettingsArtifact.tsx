import { ArtifactRenderer } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { useSettingsDraft } from "./SettingsDraftHost";
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
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={settingsArtifactRuntime(host, onOpen)}
		/>
	);
}
