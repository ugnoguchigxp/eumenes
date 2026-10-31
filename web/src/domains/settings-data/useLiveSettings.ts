import { useQuery } from "@tanstack/react-query";
import type {
	SettingsPanelAction,
	SettingsInputField,
} from "@eumenes/design-system";
import type { EumenesClient } from "../../../../client";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { useLiveVoice } from "../live-voice";

export function useLiveModelCatalog(
	client: EumenesClient,
	saved: Settings | undefined,
) {
	return useQuery({
		queryKey: [
			"live-models",
			client.identity,
			saved?.live.connectionId,
			saved?.connections.find((c) => c.id === saved.live.connectionId)?.epoch,
		],
		queryFn: ({ signal }) => client.liveModels(signal),
		enabled: false,
		retry: false,
	});
}

export function useLiveSettings({
	client,
	saved,
	effective,
	active,
	dirty,
	catalog,
}: {
	client: EumenesClient;
	saved: Settings | undefined;
	effective: Settings | undefined;
	active: boolean;
	dirty: boolean;
	catalog: ReturnType<typeof useLiveModelCatalog>;
}) {
	const live = useLiveVoice(client, saved, undefined, active);

	const disabled =
		dirty ||
		!saved?.live.enabled ||
		!saved.live.cloudAllowed ||
		!saved.live.connectionId;
	const actions: SettingsPanelAction[] = !active
		? []
		: [
				{
					id: "live-models",
					label: catalog.isFetching
						? "接続確認中…"
						: "接続を確認・モデル一覧を更新",
					disabled: disabled || catalog.isFetching,
				},
				{
					id: "live-test",
					label:
						live.active && live.session?.test
							? "音声テストを終了"
							: "音声会話を試す",
					disabled:
						live.busy ||
						(live.active && !live.session?.test) ||
						(!live.active && (disabled || !saved?.live.model)),
				},
			];
	const models = catalog.data?.models ?? [];
	const describe = [
		dirty ? "未保存の変更を保存してから接続・試用してください。" : "",
		catalog.error
			? "モデル一覧を取得できません。保存済みの接続とAPIキーを確認してください。"
			: "",
		live.error ?? "",
		live.active
			? `${live.session?.test ? "音声テスト中" : "音声会話中"}（${live.session?.muted ? "マイク休止中" : "マイクON"}）。APIの利用料金が発生します。`
			: "",
		...(live.session?.test
			? live.session.segments
					.slice(-6)
					.map((s) => `${s.speaker === "user" ? "あなた" : "AI"}: ${s.text}`)
			: []),
	]
		.filter(Boolean)
		.join("\n");
	return {
		actions,
		describe,
		inputs: (inputs: SettingsInputField[]) =>
			inputs.map((field) =>
				field.id === "live.model"
					? {
							...field,
							control: "select" as const,
							options: [
								{
									value: "",
									label: models.length
										? "モデルを選択してください"
										: "接続を選び、モデル一覧を更新してください",
								},
								...[...new Set([effective?.live.model ?? "", ...models])]
									.filter(Boolean)
									.map((id) => ({ value: id, label: id })),
							],
						}
					: field,
			),
		async run(id: string) {
			if (!active || !actions.some((a) => a.id === id && !a.disabled))
				return false;
			if (id === "live-models") {
				if (disabled) return false;
				await catalog.refetch();
				return true;
			}
			if (id === "live-test") {
				if (live.active) await live.stop();
				else if (!disabled) await live.start(true);
				return true;
			}
			return false;
		},
	};
}
