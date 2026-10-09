import { VoiceDevices } from "./voice-devices";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Usage } from "../../../../../client/settings";
import { useQuery } from "@tanstack/react-query";
import { type EumenesClient } from "../../../../../client";
import { type Settings } from "../../../../../api/domains/settings/contracts";
import { queryRoots } from "../../../queryKeys";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import {
	Field,
	Toggle,
	SpeechSpeed,
	SamplePlayer,
	KnownVoiceSelect,
	presentationLabel,
	type Change,
} from "../shared";

type VoiceSectionProps = {
	client: EumenesClient;
	value: Settings;
	saved: Settings | undefined;
	change: Change;
	larmChanged: boolean;
	usage: UseQueryResult<Usage[]>;
	devices: MediaDeviceInfo[];
	deviceError: string;
	discover: () => Promise<void>;
	outputSupported: boolean;
};
export function VoiceSection({
	client,
	value,
	saved,
	change,
	larmChanged,
	usage,
	devices,
	deviceError,
	discover,
	outputSupported,
}: VoiceSectionProps) {
	const voices = useQuery({
		queryKey: [
			queryRoots.larmVoices,
			client.identity,
			saved?.larm.baseUrl,
			saved?.larm.profile,
			saved?.larm.audience,
		],
		queryFn: ({ signal }) => client.larmVoices(signal),
		enabled: !!value && !larmChanged,
		retry: 0,
	});
	const voiceCatalog = larmChanged ? undefined : voices.data;
	const character = voiceCatalog?.voices.find(
		(v) => v.id === (value.larm.voice || voiceCatalog.default_voice),
	);
	const voicevox = voiceCatalog?.model === "voicevox-core";
	function selectCharacter(id: string) {
		const selected = voiceCatalog?.voices.find(
			(v) => v.id === (id || voiceCatalog.default_voice),
		);
		change((s) => {
			s.larm.voice = id;
			s.larm.style = selected?.default_style;
			for (const [field, capability] of [
				["speed", "speed"],
				["pitchScale", "pitch_scale"],
				["intonationScale", "intonation_scale"],
			] as const) {
				const range = selected?.capabilities[capability];
				const current = s.larm[field];
				if (
					range &&
					current !== undefined &&
					(current < range.minimum || current > range.maximum)
				)
					s.larm[field] = range.default;
			}
		});
	}
	const speechCredit =
		usage.data
			?.filter((u) => u.purpose === "tts" && u.accepted && u.source === "larm")
			.flatMap((u) => u.providerDetails ?? [])
			.find(
				(d) =>
					d.model === voiceCatalog?.model &&
					d.speechVoice === character?.id &&
					d.speechCredit,
			)?.speechCredit ?? character?.credit;
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>アバターの読み上げ音声</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="hint">
						変更を適用すると、声と速さは次の発話から、音量は次の再生から反映します。
					</p>
					<Field
						label={`読み上げ音量（${Math.round(value.voice.outputVolume * 100)}%）`}
						hint="0%で消音になります。マイクの音量には影響しません。"
					>
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={value.voice.outputVolume}
							onChange={(e) =>
								change((s) => {
									s.voice.outputVolume = Number(e.target.value);
								})
							}
						/>
					</Field>
					<div className="settings-resource">
						<h3>LARMの声</h3>
						<Field
							label="キャラクター"
							hint="自動選択では、LARMが指定する声を使います。"
						>
							{voices.data && !larmChanged && voices.data.voices.length > 0 ? (
								<select
									value={value.larm.voice}
									onChange={(e) => selectCharacter(e.target.value)}
								>
									<option value="">
										既定のキャラクター
										{voiceCatalog?.default_voice &&
											`（${voiceCatalog.voices.find((v) => v.id === voiceCatalog.default_voice)?.display_name ?? voiceCatalog.default_voice}）`}
									</option>
									{value.larm.voice &&
										!voices.data.voices.some(
											(v) => v.id === value.larm.voice,
										) && (
											<option value={value.larm.voice}>
												{value.larm.voice}（現在の一覧にありません）
											</option>
										)}
									{voices.data.voices.map((v) => (
										<option key={v.id} value={v.id}>
											{v.display_name}
											{presentationLabel[v.voice_presentation ?? ""] ?? ""}
										</option>
									))}
								</select>
							) : (
								<KnownVoiceSelect
									value={value.larm.voice}
									emptyLabel="既定のキャラクター"
									onChange={selectCharacter}
								/>
							)}
						</Field>
						{larmChanged ? (
							<p className="hint">
								接続先の変更を適用すると、声の一覧を取得できます。
							</p>
						) : voices.isFetching ? (
							<output>声の一覧を取得しています…</output>
						) : (
							(voices.isError || voices.data?.voices.length === 0) && (
								<p className="hint">
									声の一覧を取得できません。保存したキャラクターと調整値は保持しています。
								</p>
							)
						)}
						{voiceCatalog && value.larm.voice && !character && (
							<p role="alert">
								保存したキャラクターが一覧にありません。再取得するか、既定のキャラクターに戻してください。
							</p>
						)}
						<div className="settings-actions">
							<Button
								variant="secondary"
								disabled={voices.isFetching || larmChanged}
								onClick={() => void voices.refetch()}
							>
								声の一覧を再取得
							</Button>
							<Button variant="secondary" onClick={() => selectCharacter("")}>
								既定のキャラクターに戻す
							</Button>
							<SamplePlayer
								client={client}
								disabled={larmChanged}
								voice={{
									voice: value.larm.voice || undefined,
									style: value.larm.style,
									speed: value.larm.speed,
									pitchScale: value.larm.pitchScale,
									intonationScale: value.larm.intonationScale,
								}}
							/>
						</div>
						{voicevox && character && (
							<>
								<Field label="発話スタイル">
									<select
										value={value.larm.style ?? character.default_style ?? ""}
										onChange={(e) =>
											change((s) => {
												s.larm.style = e.target.value || undefined;
											})
										}
									>
										<option value="">キャラクターの既定スタイル</option>
										{value.larm.style &&
											!character.styles.some(
												(s) => s.id === value.larm.style,
											) && (
												<option value={value.larm.style}>
													{value.larm.style}（このキャラクターでは未対応）
												</option>
											)}
										{character.styles.map((s) => (
											<option key={s.id} value={s.id}>
												{s.display_name}
											</option>
										))}
									</select>
								</Field>
								{(
									[
										[
											"pitchScale",
											"pitch_scale",
											"声の高さ",
											-0.15,
											0.15,
											0,
											0.01,
										],
										[
											"intonationScale",
											"intonation_scale",
											"抑揚",
											0,
											2,
											1,
											0.05,
										],
									] as const
								).map(
									([field, capability, label, min, max, standard, step]) => {
										const range = character.capabilities[capability];
										const setting =
											value.larm[field] ?? range?.default ?? standard;
										return (
											<Field
												key={field}
												label={`${label}（${setting.toFixed(2)}）`}
												hint={
													field === "pitchScale"
														? "数値は音声サービスの調整値です。0が基準です。"
														: "1が基準、0で平坦になります。"
												}
											>
												<input
													type="range"
													min={range?.minimum ?? min}
													max={range?.maximum ?? max}
													step={step}
													value={setting}
													disabled={!range}
													onChange={(e) =>
														change((s) => {
															s.larm[field] = Number(e.target.value);
														})
													}
												/>
											</Field>
										);
									},
								)}
								<Toggle
									label="文章に合わせて抑揚・速さ・高さを変える（簡易）"
									value={value.larm.autoIntonation ?? false}
									onChange={(v) =>
										change((s) => {
											s.larm.autoIntonation = v;
											if (v && s.larm.intonationScale === undefined)
												s.larm.intonationScale =
													character.capabilities.intonation_scale?.default ?? 1;
										})
									}
									hint="疑問文・感嘆文・注意を促す文の抑揚・速さ・高さを、設定値を基準に句ごとに増減させます。"
								/>
								{value.larm.autoIntonation && (
									<Field
										label={`自動調整の強さ（${Math.round((value.larm.autoStrength ?? 1) * 100)}%）`}
										hint="上の設定値を基準に、文章ごとに増減させる幅の倍率です。0%で基準値のまま、200%で2倍まで動かします。"
									>
										<input
											type="range"
											min={0}
											max={2}
											step={0.05}
											value={value.larm.autoStrength ?? 1}
											onChange={(e) =>
												change((s) => {
													s.larm.autoStrength = Number(e.target.value);
												})
											}
										/>
									</Field>
								)}
							</>
						)}
						{voiceCatalog && !voicevox && (
							<p className="hint">
								このモデルではVOICEVOXのスタイル・高さ・抑揚を使いません。
							</p>
						)}
						<SpeechSpeed
							value={
								value.larm.speed ?? character?.capabilities.speed?.default ?? 1
							}
							range={character?.capabilities.speed}
							onChange={(v) =>
								change((s) => {
									s.larm.speed = v;
								})
							}
						/>
						{speechCredit && <p className="hint">クレジット: {speechCredit}</p>}
					</div>
					{value.resources
						.filter((r) => r.purpose === "tts")
						.map((r) => (
							<div className="settings-resource" key={r.id}>
								<h3>
									{value.connections.find((c) => c.id === r.connectionId)?.name}{" "}
									/ {r.model}
								</h3>
								<p className="hint">
									{value.routes.tts.fallbackId === r.id
										? "現在のクラウド読み上げ先です。"
										: "この接続先を読み上げに選んだときに使います。"}
								</p>
								<Field
									label="クラウドの声の種類（音声ID）"
									hint="このサービスが提供する音声IDを入力してください。"
								>
									<Input
										value={r.voice ?? ""}
										maxLength={200}
										onChange={(e) =>
											change((s) => {
												s.resources.find((x) => x.id === r.id)!.voice =
													e.target.value;
											})
										}
									/>
								</Field>
								<SpeechSpeed
									value={r.speed ?? 1}
									onChange={(v) =>
										change((s) => {
											s.resources.find((x) => x.id === r.id)!.speed = v;
										})
									}
								/>
							</div>
						))}
					{!value.resources.some((r) => r.purpose === "tts") && (
						<p className="hint">
							クラウドの声を使う場合は「接続先」で読み上げ用のモデルを登録してください。
						</p>
					)}
				</CardContent>
			</Card>
			<VoiceDevices
				value={value}
				change={change}
				devices={devices}
				deviceError={deviceError}
				discover={discover}
				outputSupported={outputSupported}
			/>
		</>
	);
}
