import { type Settings } from "../../../../../api/domains/settings/contracts";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Subtitle } from "../../../components/domains/subtitle/Subtitle";
import { Field, Toggle, type Change } from "../shared";

type AppearanceSectionProps = { value: Settings; change: Change };
export function AppearanceSection({ value, change }: AppearanceSectionProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>表示</CardTitle>
			</CardHeader>
			<CardContent>
				<Field label="テーマ">
					<select
						value={value.general.theme}
						onChange={(e) =>
							change((s) => {
								s.general.theme = e.target
									.value as Settings["general"]["theme"];
							})
						}
					>
						<option value="system">端末の設定に合わせる</option>
						<option value="light">ライト</option>
						<option value="dark">ダーク</option>
					</select>
				</Field>
				<Toggle
					label="読み上げ字幕を表示する"
					value={value.general.subtitles.enabled}
					onChange={(v) =>
						change((s) => {
							s.general.subtitles.enabled = v;
						})
					}
					hint="読み上げに合わせて画面中央に字幕を出します。"
				/>
				<Field label="字幕のデザイン">
					<select
						value={value.general.subtitles.style}
						onChange={(e) =>
							change((s) => {
								s.general.subtitles.style = e.target
									.value as Settings["general"]["subtitles"]["style"];
							})
						}
					>
						<option value="netflix">シネマ（白文字・影）</option>
						<option value="prime">ボックス（半透明の黒背景）</option>
						<option value="classic">クラシック（黄文字・黒縁）</option>
						<option value="glass">ガラス（ぼかし背景）</option>
					</select>
				</Field>
				<Field label="字幕の大きさ">
					<select
						value={value.general.subtitles.size}
						onChange={(e) =>
							change((s) => {
								s.general.subtitles.size = e.target
									.value as Settings["general"]["subtitles"]["size"];
							})
						}
					>
						<option value="medium">中</option>
						<option value="large">大</option>
						<option value="xlarge">特大</option>
					</select>
				</Field>
				<div className="subtitle-preview-stage" aria-hidden="true">
					<Subtitle
						text="これは字幕のプレビューです。"
						style={value.general.subtitles.style}
						size={value.general.subtitles.size}
						inline
					/>
				</div>
			</CardContent>
		</Card>
	);
}
