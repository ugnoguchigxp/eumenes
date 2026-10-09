import { type Purpose } from "../../../../../api/domains/settings/contracts";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Field, Toggle, purposes, type NewCloud } from "../shared";

type CloudAddProps = {
	adding: boolean;
	setAdding: (adding: boolean) => void;
	newCloud: NewCloud;
	setNewCloud: React.Dispatch<React.SetStateAction<NewCloud>>;
	addCloud: () => void;
};
export function CloudAdd({
	adding,
	setAdding,
	newCloud,
	setNewCloud,
	addCloud,
}: CloudAddProps) {
	return (
		<>
			{!adding ? (
				<Button onClick={() => setAdding(true)}>クラウドAPIを登録</Button>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>クラウドAPIの登録</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="hint">
							OpenAI互換の会話・音声認識・WAV音声合成に対応します。
						</p>
						<Field label="接続名">
							<Input
								value={newCloud.name}
								onChange={(e) =>
									setNewCloud((n) => ({ ...n, name: e.target.value }))
								}
							/>
						</Field>
						<Field
							label="APIのベースURL"
							hint="例: https://example.com/v1。末尾に用途別のAPIパスを追加します。"
						>
							<Input
								value={newCloud.url}
								onChange={(e) =>
									setNewCloud((n) => ({ ...n, url: e.target.value }))
								}
							/>
						</Field>
						<Field label="APIキー">
							<Input
								type="password"
								autoComplete="new-password"
								value={newCloud.key}
								onChange={(e) =>
									setNewCloud((n) => ({ ...n, key: e.target.value }))
								}
							/>
						</Field>
						<Field label="環境変数名（APIキーの代わり）">
							<Input
								value={newCloud.envRef}
								onChange={(e) =>
									setNewCloud((n) => ({ ...n, envRef: e.target.value }))
								}
							/>
						</Field>
						<Field label="用途">
							<select
								value={newCloud.purpose}
								onChange={(e) =>
									setNewCloud((n) => ({
										...n,
										purpose: e.target.value as Purpose,
									}))
								}
							>
								{Object.entries(purposes).map(([p, label]) => (
									<option key={p} value={p}>
										{label}
									</option>
								))}
							</select>
						</Field>
						<Field label="モデル名">
							<Input
								value={newCloud.model}
								onChange={(e) =>
									setNewCloud((n) => ({ ...n, model: e.target.value }))
								}
							/>
						</Field>
						{newCloud.purpose === "llm" && (
							<Field label="文脈長">
								<Input
									type="number"
									value={newCloud.context}
									onChange={(e) =>
										setNewCloud((n) => ({
											...n,
											context: Number(e.target.value),
										}))
									}
								/>
							</Field>
						)}
						{newCloud.purpose === "tts" && (
							<Field label="音声名">
								<Input
									value={newCloud.voice}
									onChange={(e) =>
										setNewCloud((n) => ({ ...n, voice: e.target.value }))
									}
								/>
							</Field>
						)}
						<Toggle
							label="この用途の代替先として使う"
							value={newCloud.assign}
							onChange={(v) => setNewCloud((n) => ({ ...n, assign: v }))}
							hint="既に代替先を選んでいる場合は、その選択を維持します。"
						/>
						<div className="settings-actions">
							<Button onClick={addCloud}>登録内容を追加</Button>
							<Button
								variant="secondary"
								onClick={() => {
									setAdding(false);
									setNewCloud((n) => ({ ...n, key: "" }));
								}}
							>
								やめる
							</Button>
						</div>
					</CardContent>
				</Card>
			)}
		</>
	);
}
