import {
	asrLanguages,
	type Settings,
} from "../../../../../api/domains/settings/contracts";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Field, Toggle, type Change } from "../shared";

type GeneralSectionProps = { value: Settings; change: Change };
export function GeneralSection({ value, change }: GeneralSectionProps) {
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>会話</CardTitle>
				</CardHeader>
				<CardContent>
					<Field label="AIの名前" hint="空欄の場合は名前を設定しません。">
						<input
							type="text"
							maxLength={40}
							value={value.general.agentName}
							onChange={(e) =>
								change((s) => {
									s.general.agentName = e.target.value;
								})
							}
						/>
					</Field>
					<Field label="あなたの名前" hint="空欄の場合は名前で呼びません。">
						<input
							type="text"
							maxLength={40}
							value={value.general.userName}
							onChange={(e) =>
								change((s) => {
									s.general.userName = e.target.value;
								})
							}
						/>
					</Field>
					<Field
						label="利用する言語"
						hint="聞き取り結果がここにない言語の文字を含む場合は破棄します（最低1つ）。"
					>
						<fieldset className="language-options">
							{asrLanguages.map(([code, label]) => (
								<Toggle
									key={code}
									label={label}
									value={value.general.asrLanguages.includes(code)}
									onChange={(on) =>
										change((s) => {
											const next = on
												? [...s.general.asrLanguages, code]
												: s.general.asrLanguages.filter((c) => c !== code);
											if (next.length) s.general.asrLanguages = next;
										})
									}
								/>
							))}
						</fieldset>
					</Field>
					<Field label="口調">
						<select
							value={value.general.persona}
							onChange={(e) =>
								change((s) => {
									s.general.persona = e.target
										.value as Settings["general"]["persona"];
								})
							}
						>
							<option value="butler">執事</option>
							<option value="maid">メイド</option>
							<option value="strategist">参謀</option>
							<option value="sage">老師</option>
						</select>
					</Field>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>コーディング監督</CardTitle>
				</CardHeader>
				<CardContent>
					<Toggle
						label="監督AIの指示を実行前に確認する"
						hint="リポジトリ内の文章などに誘導された指示が自動で実行されるのを防ぎます。推奨はオンです。"
						value={value.codingSupervision.approveInstructions}
						onChange={(on) =>
							change((s) => {
								s.codingSupervision.approveInstructions = on;
							})
						}
					/>
				</CardContent>
			</Card>
		</>
	);
}
