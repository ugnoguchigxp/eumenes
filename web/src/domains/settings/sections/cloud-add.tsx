import {
	connectionKinds,
	type ConnectionKind,
	type Purpose,
} from "../../../../../api/domains/settings/contracts";
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
	connectionKindDefaults,
	connectionKindLabels,
	purposes,
	type NewCloud,
} from "../shared";

const kindHints: Record<ConnectionKind, string> = {
	"openai-compatible": "OpenAI互換の会話・音声認識・WAV音声合成に対応します。",
	"codex-sdk":
		"Codex SDKで会話・サブエージェントの応答を生成します（会話用途のみ）。APIキーを空にするとCodex CLIのログインを使います。",
	"claude-agent-sdk":
		"Claude Agent SDKで会話・サブエージェントの応答を生成します（会話用途のみ）。組込みツールは使いません。APIキーを空にするとClaude Codeのログインを使います。",
	"claude-managed-agents":
		"Claude Managed Agentsのセッションで応答を生成します（会話用途のみ）。保存済みのエージェントと環境を指定し、ターンごとにセッションを作成・削除します。",
};

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
						<Field label="接続の種類">
							<select
								value={newCloud.kind}
								onChange={(e) => {
									const kind = e.target.value as ConnectionKind;
									const d = connectionKindDefaults[kind];
									setNewCloud((n) => {
										// Replace only values still equal to the previous kind's defaults.
										const p = connectionKindDefaults[n.kind];
										return {
											...n,
											kind,
											url: !n.url || n.url === p.url ? d.url : n.url,
											model:
												!n.model || n.model === p.model ? d.model : n.model,
											context: n.context === p.context ? d.context : n.context,
											...(kind !== "openai-compatible"
												? { purpose: "llm" as const }
												: {}),
										};
									});
								}}
							>
								{connectionKinds.map((k) => (
									<option key={k} value={k}>
										{connectionKindLabels[k]}
									</option>
								))}
							</select>
						</Field>
						<p className="hint">{kindHints[newCloud.kind]}</p>
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
							hint={
								newCloud.kind === "openai-compatible"
									? "例: https://example.com/v1。末尾に用途別のAPIパスを追加します。"
									: "APIキーを使う場合の送信先です。ログインを使う場合は参照しません。"
							}
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
						{newCloud.kind === "claude-managed-agents" && (
							<>
								<Field
									label="エージェントID"
									hint="例: agent_... (保存済みのエージェント)"
								>
									<Input
										value={newCloud.agentId}
										onChange={(e) =>
											setNewCloud((n) => ({ ...n, agentId: e.target.value }))
										}
									/>
								</Field>
								<Field label="環境ID" hint="例: env_...">
									<Input
										value={newCloud.environmentId}
										onChange={(e) =>
											setNewCloud((n) => ({
												...n,
												environmentId: e.target.value,
											}))
										}
									/>
								</Field>
							</>
						)}
						{newCloud.kind === "openai-compatible" && (
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
						)}
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
