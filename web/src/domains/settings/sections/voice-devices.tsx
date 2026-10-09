import { type Settings } from "../../../../../api/domains/settings/contracts";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Field, Toggle, type Change } from "../shared";

type VoiceDevicesProps = {
	value: Settings;
	change: Change;
	devices: MediaDeviceInfo[];
	deviceError: string;
	discover: () => Promise<void>;
	outputSupported: boolean;
};
export function VoiceDevices({
	value,
	change,
	devices,
	deviceError,
	discover,
	outputSupported,
}: VoiceDevicesProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>声での会話</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="hint">
					録音と機器の調整は次の音声開始から、読み上げの設定は次の発話から反映します。
				</p>
				<Toggle
					label="回答を読み上げる"
					value={value.voice.autoSpeak}
					onChange={(v) =>
						change((s) => {
							s.voice.autoSpeak = v;
						})
					}
					hint="オフでも回答のテキストは会話に残ります。"
				/>
				<Toggle
					label="話し始めたら読み上げを止める"
					value={value.voice.bargeIn}
					onChange={(v) =>
						change((s) => {
							s.voice.bargeIn = v;
						})
					}
				/>
				<Button variant="secondary" onClick={() => void discover()}>
					音声機器を確認
				</Button>
				{deviceError && <p role="alert">{deviceError}</p>}
				<Field
					label="マイク"
					hint="変更は次に音声を開始したときに反映されます。"
				>
					<select
						value={value.voice.inputDevice}
						onChange={(e) =>
							change((s) => {
								s.voice.inputDevice = e.target.value;
							})
						}
					>
						<option value="">システム標準</option>
						{devices
							.filter((d) => d.kind === "audioinput")
							.map((d) => (
								<option key={d.deviceId} value={d.deviceId}>
									{d.label || "マイク"}
								</option>
							))}
						{value.voice.inputDevice &&
							!devices.some((d) => d.deviceId === value.voice.inputDevice) && (
								<option value={value.voice.inputDevice}>
									選択したマイクを確認できません
								</option>
							)}
					</select>
				</Field>
				{outputSupported ? (
					<Field label="再生機器">
						<select
							value={value.voice.outputDevice}
							onChange={(e) =>
								change((s) => {
									s.voice.outputDevice = e.target.value;
								})
							}
						>
							<option value="">システム標準</option>
							{devices
								.filter((d) => d.kind === "audiooutput")
								.map((d) => (
									<option key={d.deviceId} value={d.deviceId}>
										{d.label || "再生機器"}
									</option>
								))}
							{value.voice.outputDevice &&
								!devices.some(
									(d) => d.deviceId === value.voice.outputDevice,
								) && (
									<option value={value.voice.outputDevice}>
										選択した機器を確認できません
									</option>
								)}
						</select>
					</Field>
				) : (
					<p className="hint">
						このブラウザでは再生先の切替に対応していません。システム標準を使います。
					</p>
				)}
				<Field
					label="声を検出するしきい値"
					hint="小さい値ほど小さな声を拾います。"
				>
					<Input
						type="number"
						min={0.001}
						max={0.1}
						step={0.001}
						value={value.voice.threshold}
						onChange={(e) =>
							change((s) => {
								s.voice.threshold = Number(e.target.value);
							})
						}
					/>
				</Field>
				<Field label="発話を確定する無音時間（ミリ秒）">
					<Input
						type="number"
						min={300}
						max={3000}
						step={100}
						value={value.voice.silenceMs}
						onChange={(e) =>
							change((s) => {
								s.voice.silenceMs = Number(e.target.value);
							})
						}
					/>
				</Field>
				{(
					["echoCancellation", "noiseSuppression", "autoGainControl"] as const
				).map((key, i) => (
					<Toggle
						key={key}
						label={
							[
								"エコーを抑える",
								"周囲の雑音を抑える",
								"マイクの音量を自動調整する",
							][i]!
						}
						value={value.voice[key]}
						onChange={(v) =>
							change((s) => {
								s.voice[key] = v;
							})
						}
					/>
				))}
			</CardContent>
		</Card>
	);
}
