import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { SettingsInputField } from "@eumenes/design-system";
import type { Receipt, Snapshot } from "@eumenes/artifact-ui";
import type { Settings } from "../../../../api/domains/settings/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { draftStoreFor } from "../toolchain-artifacts/drafts";
import type { DraftView } from "../toolchain-artifacts/drafts";

const DOCUMENT = "document:settings@1";
const prefix = "catalog.";
const accepted: Receipt = { status: "accepted", message: "" };
const refuse = (message: string): Receipt => ({ status: "rejected", message });
const choices = (values: string[]) =>
	values.map((value) => ({ value, label: value }));

/** The existing settings section supplies the controls; selection stages the registered structure. */
export function useModelCatalog(
	client: EumenesClient,
	saved: Settings | undefined,
	effective: Settings | undefined,
	view: DraftView,
	active: boolean,
) {
	const [selected, setSelected] = useState({
		connection: "",
		purpose: "asr",
		model: "",
		voice: "",
		language: "",
	});
	const [message, setMessage] = useState("");
	const connections =
		saved?.connections.filter(
			(c) => c.kind === "cloudflare-workers-ai" && c.enabled,
		) ?? [];
	const connection =
		connections.find((c) => c.id === selected.connection) ?? connections[0];
	const current = effective?.connections.find((c) => c.id === connection?.id);
	const changed =
		!!connection &&
		(JSON.stringify(current) !== JSON.stringify(connection) ||
			view.secrets.some((s) => s.target === connection.id) ||
			view.structural.some(
				(s) =>
					s.input.connectionId === connection.id &&
					s.structure === "structure:settings.delete-connection@1",
			));
	const query = useQuery({
		queryKey: [
			queryRoots.connectionModels,
			client.identity,
			connection?.id,
			connection?.epoch,
			connection?.accountId,
		],
		queryFn: ({ signal }) =>
			client.connectionModels(connection!.id, signal, true),
		enabled: false,
		retry: false,
	});
	const models =
		query.data?.models.filter((m) => m.purpose === selected.purpose) ?? [];
	const model = models.find((m) => m.id === selected.model);
	const speech = model?.speech;
	const enabled = active && !!connection && !changed && !view.busy;
	const fields: SettingsInputField[] = [
		{
			id: prefix + "connection",
			label: "音声モデルを取得する接続",
			control: "select",
			value: connection?.id ?? "",
			options: connections.map((c) => ({ value: c.id, label: c.name })),
			disabled: !connections.length,
		},
		{
			id: prefix + "purpose",
			label: "モデルの用途",
			control: "select",
			value: selected.purpose,
			options: [
				{ value: "asr", label: "聞き取り（ASR）" },
				{ value: "tts", label: "読み上げ（TTS）" },
			],
		},
		{
			id: prefix + "model",
			label: "取得したモデル",
			control: "select",
			value: selected.model,
			options: [
				{ value: "", label: "選択してください" },
				...models
					.filter((m) => m.speech?.supported)
					.map((m) => ({ value: m.id, label: m.displayName })),
			],
			disabled:
				!enabled ||
				query.isFetching ||
				query.isError ||
				!models.some((m) => m.speech?.supported),
		},
	];
	if (speech?.voiceSelectable)
		fields.push({
			id: prefix + "voice",
			label: "モデルの声",
			control: speech.voices.length ? "select" : "text",
			value: selected.voice,
			options: [
				{
					value: "",
					label: speech.voiceRequired
						? "選択してください"
						: "サービスの既定の声",
				},
				...choices(speech.voices),
			],
			maxLength: 200,
		});
	if (speech?.languageSelectable)
		fields.push({
			id: prefix + "language",
			label: "モデルの言語",
			control: speech.languages.length ? "select" : "text",
			value: selected.language,
			options: [
				{
					value: "",
					label: speech.languageRequired
						? "選択してください"
						: "サービスの既定",
				},
				...choices(speech.languages),
			],
			maxLength: 80,
			help: speech.languages.length
				? undefined
				: "言語コードを指定できます。未入力ではサービスの既定を使います。対応言語はモデルの仕様を確認してください。",
		});
	const unavailable = models.filter((m) => !m.speech?.supported);
	const error = query.isError
		? "モデルを取得できません。Account ID・APIトークン・Workers AIの権限と通信状態を確認して、再取得してください。"
		: "";
	const description = !connections.length
		? "接続の種類にCloudflare Workers AIを選び、Account IDとAPIトークンを登録・保存してください。"
		: changed
			? "接続の変更を保存してからモデルを再取得してください。"
			: "保存した接続で一覧を取得し、モデルを下書きに追加してから設定を保存します。利用先は「利用するAI」で選べます。";
	const resource: Extract<Snapshot[string], { kind: "settings-section" }> = {
		kind: "settings-section",
		revision: (saved?.revision ?? 0) * 1_000_000 + view.version,
		dirty:
			view.entries.length > 0 ||
			view.structural.length > 0 ||
			view.secrets.length > 0,
		busy: view.busy,
		fields,
		description,
		message: [
			error,
			message,
			query.data && !error
				? "一覧取得済み。音声の動作確認は別途行ってください。"
				: "",
			...unavailable.map(
				(m) =>
					`${m.displayName}：${m.speech?.reason === "workers_ai_audio_decoder_unavailable" ? "音声変換にffmpegが必要です" : "入出力形式が未対応のため選択できません"}`,
			),
		]
			.filter(Boolean)
			.join("\n"),
		actions: [
			{
				id: "catalog-refresh",
				label: query.isFetching
					? "モデル一覧を取得中…"
					: "接続確認・モデル一覧を更新",
				disabled: !enabled || query.isFetching,
			},
			{
				id: "catalog-add",
				label: "選んだモデルを下書きに追加",
				disabled:
					!enabled || query.isFetching || query.isError || !speech?.supported,
			},
		],
	};
	return {
		resource,
		edit(key: string, wire: string): Receipt | null {
			if (!active || !key.startsWith(prefix)) return null;
			const field = key.slice(prefix.length);
			if (field === "connection") {
				if (!connections.some((c) => c.id === wire))
					return refuse("登録した接続から選んでください。");
				setSelected({
					connection: wire,
					purpose: selected.purpose,
					model: "",
					voice: "",
					language: "",
				});
			} else if (field === "purpose" && ["asr", "tts"].includes(wire))
				setSelected({
					...selected,
					purpose: wire,
					model: "",
					voice: "",
					language: "",
				});
			else if (field === "model") {
				const next = models.find((m) => m.id === wire && m.speech?.supported);
				if (wire && !next)
					return refuse("取得した一覧からモデルを選んでください。");
				setSelected({
					...selected,
					model: wire,
					voice: next?.speech?.voiceDefault ?? "",
					language: next?.speech?.languageDefault ?? "",
				});
			} else if (field === "voice" || field === "language") {
				const offered = field === "voice" ? speech?.voices : speech?.languages;
				if (
					!offered ||
					(wire && offered.length && !offered.includes(wire)) ||
					wire.length > (field === "voice" ? 200 : 80)
				)
					return refuse("モデルの選択肢を確認してください。");
				setSelected({ ...selected, [field]: wire });
			} else return refuse("この項目は変更できません。");
			setMessage("");
			return accepted;
		},
		async run(id: string): Promise<Receipt | null> {
			if (!active || !["catalog-refresh", "catalog-add"].includes(id))
				return null;
			if (!enabled || query.isFetching)
				return refuse("接続の変更を保存してから操作してください。");
			if (id === "catalog-refresh") {
				setSelected((s) => ({ ...s, model: "", voice: "", language: "" }));
				setMessage("");
				await query.refetch();
				return accepted;
			}
			if (query.isError || !model || !speech?.supported)
				return refuse("取得した一覧からモデルを選んでください。");
			if (
				(speech.voiceRequired && !selected.voice) ||
				(speech.languageRequired && !selected.language)
			)
				return refuse("モデルに必要な声・言語を指定してください。");
			const exists =
				saved?.resources.some(
					(r) =>
						r.connectionId === connection!.id &&
						r.purpose === selected.purpose &&
						r.model === model.id &&
						(r.voice ?? "") === selected.voice &&
						(r.language ?? "") === selected.language,
				) ||
				view.structural.some(
					(s) =>
						s.structure === "structure:settings.add-resource@2" &&
						s.input.connectionId === connection!.id &&
						s.input.purpose === selected.purpose &&
						s.input.model === model.id &&
						(s.input.voice ?? "") === selected.voice &&
						(s.input.language ?? "") === selected.language,
				);
			if (exists)
				return refuse(
					"このモデルと声・言語は登録済み、または下書きに追加済みです。",
				);
			const resourceId = crypto.randomUUID();
			draftStoreFor(client.identity, DOCUMENT).stage({
				id: crypto.randomUUID(),
				created: resourceId,
				structure: "structure:settings.add-resource@2",
				label: `音声モデルを追加（${connection!.name} / ${model.displayName}）`,
				input: {
					resourceId,
					connectionId: connection!.id,
					purpose: selected.purpose,
					model: model.id,
					...(selected.voice ? { voice: selected.voice } : {}),
					...(selected.language ? { language: selected.language } : {}),
				},
			});
			setMessage(
				"下書きに追加しました。「設定の変更をすべて保存」で保存してください。",
			);
			return accepted;
		},
	};
}
