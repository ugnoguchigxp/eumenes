import { LarmConnectionCard } from "./larm-connection";
import { CloudAdd } from "./cloud-add";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
	Diagnostics,
	LarmDetails,
	Probe,
} from "../../../../../client/settings";
import { type EumenesClient } from "../../../../../client";
import {
	type Settings,
	type Purpose,
	type ApplySettings,
} from "../../../../../api/domains/settings/contracts";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Field, Toggle, purposes, type Change, type NewCloud } from "../shared";

type ConnectionsSectionProps = {
	client: EumenesClient;
	value: Settings;
	change: Change;
	dirty: boolean;
	keys: ApplySettings["keys"];
	setKeys: React.Dispatch<React.SetStateAction<ApplySettings["keys"]>>;
	setRetry: (retry: null) => void;
	details: UseQueryResult<LarmDetails>;
	diagnostics: UseQueryResult<Diagnostics>;
	probes: UseQueryResult<Probe[]>;
	probe: (target: string) => Promise<void>;
	adding: boolean;
	setAdding: (adding: boolean) => void;
	newCloud: NewCloud;
	setNewCloud: React.Dispatch<React.SetStateAction<NewCloud>>;
	addCloud: () => void;
};
export function ConnectionsSection({
	client,
	value,
	change,
	dirty,
	keys,
	setKeys,
	setRetry,
	details,
	diagnostics,
	probes,
	probe,
	adding,
	setAdding,
	newCloud,
	setNewCloud,
	addCloud,
}: ConnectionsSectionProps) {
	return (
		<>
			<LarmConnectionCard
				value={value}
				change={change}
				dirty={dirty}
				details={details}
				probe={probe}
			/>
			{value.connections.map((c) => (
				<Card key={c.id}>
					<CardHeader>
						<CardTitle>{c.name}</CardTitle>
					</CardHeader>
					<CardContent>
						<Field label="接続名">
							<Input
								value={c.name}
								onChange={(e) =>
									change((s) => {
										s.connections.find((x) => x.id === c.id)!.name =
											e.target.value;
									})
								}
							/>
						</Field>
						<Field label="APIのベースURL">
							<Input
								value={c.baseUrl}
								onChange={(e) =>
									change((s) => {
										s.connections.find((x) => x.id === c.id)!.baseUrl =
											e.target.value;
									})
								}
							/>
						</Field>
						<Field
							label="認証用の環境変数名"
							hint="環境変数を使う場合はAPIキー欄を空にしてください。"
						>
							<Input
								value={c.envRef ?? ""}
								onChange={(e) =>
									change((s) => {
										s.connections.find((x) => x.id === c.id)!.envRef =
											e.target.value || null;
									})
								}
							/>
						</Field>
						<Toggle
							label="この接続を有効にする"
							value={c.enabled}
							onChange={(v) =>
								change((s) => {
									s.connections.find((x) => x.id === c.id)!.enabled = v;
								})
							}
						/>
						<Field
							label="APIキーの更新"
							hint="空欄なら保存済みのキーを維持します。"
						>
							<Input
								type="password"
								autoComplete="new-password"
								value={keys.find((k) => k.connectionId === c.id)?.value ?? ""}
								onChange={(e) => {
									setKeys((k) => [
										...k.filter((x) => x.connectionId !== c.id),
										...(e.target.value
											? [{ connectionId: c.id, value: e.target.value }]
											: []),
									]);
									setRetry(null);
								}}
							/>
						</Field>
						<p className="hint">
							認証:{" "}
							{diagnostics.data?.connections.find((x) => x.id === c.id)
								?.credentialAvailable
								? "登録済み"
								: "未登録"}
							{c.envRef && `（環境変数 ${c.envRef}）`}
						</p>
						<div className="settings-actions">
							<Button
								variant="secondary"
								onClick={() => {
									setKeys((k) => [
										...k.filter((x) => x.connectionId !== c.id),
										{ connectionId: c.id, value: null },
									]);
									setRetry(null);
								}}
							>
								キーを削除
							</Button>
							<Button
								variant="secondary"
								onClick={() =>
									change((s) => {
										const refs = s.resources
											.filter((r) => r.connectionId === c.id)
											.map((r) => r.id);
										s.connections = s.connections.filter((x) => x.id !== c.id);
										s.resources = s.resources.filter(
											(r) => r.connectionId !== c.id,
										);
										for (const p of Object.keys(purposes) as Purpose[])
											if (refs.includes(s.routes[p].fallbackId ?? "")) {
												s.routes[p].fallbackId = null;
												if (s.routes[p].mode === "cloud-only")
													s.routes[p].mode = "larm-preferred";
											}
										setKeys((k) => k.filter((x) => x.connectionId !== c.id));
									})
								}
							>
								接続を削除
							</Button>
						</div>
						{value.resources
							.filter((r) => r.connectionId === c.id)
							.map((r) => (
								<div className="settings-resource" key={r.id}>
									<strong>{purposes[r.purpose]}</strong>
									<Field label="用途">
										<select
											value={r.purpose}
											onChange={(e) =>
												change((s) => {
													const resource = s.resources.find(
														(x) => x.id === r.id,
													)!;
													const old = resource.purpose;
													resource.purpose = e.target.value as Purpose;
													resource.contextWindow =
														resource.purpose === "llm" ? 8192 : null;
													resource.voice =
														resource.purpose === "tts" ? "" : null;
													if (s.routes[old].fallbackId === r.id) {
														s.routes[old].fallbackId = null;
														if (s.routes[old].mode === "cloud-only")
															s.routes[old].mode = "larm-preferred";
													}
												})
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
											value={r.model}
											onChange={(e) =>
												change((s) => {
													s.resources.find((x) => x.id === r.id)!.model =
														e.target.value;
												})
											}
										/>
									</Field>
									{r.purpose === "llm" && (
										<Field label="文脈長">
											<Input
												type="number"
												min={2048}
												value={r.contextWindow ?? 8192}
												onChange={(e) =>
													change((s) => {
														s.resources.find(
															(x) => x.id === r.id,
														)!.contextWindow = Number(e.target.value);
													})
												}
											/>
										</Field>
									)}
									{r.purpose === "tts" && (
										<Field label="音声名">
											<Input
												value={r.voice ?? ""}
												onChange={(e) =>
													change((s) => {
														s.resources.find((x) => x.id === r.id)!.voice =
															e.target.value;
													})
												}
											/>
										</Field>
									)}
									{
										<Button
											variant="secondary"
											disabled={dirty || !c.enabled}
											onClick={() => void probe(r.id)}
										>
											{r.purpose === "llm"
												? "少量の会話テスト"
												: r.purpose === "asr"
													? "聞き取りテスト（無音）"
													: "読み上げ生成テスト"}
										</Button>
									}
								</div>
							))}
						<Button
							variant="secondary"
							onClick={() =>
								change((s) => {
									const p: Purpose = "llm";
									s.resources.push({
										id: crypto.randomUUID(),
										connectionId: c.id,
										purpose: p,
										model: "",
										contextWindow: 8192,
										voice: null,
									});
								})
							}
						>
							この接続にモデルを追加
						</Button>
					</CardContent>
				</Card>
			))}
			<CloudAdd
				adding={adding}
				setAdding={setAdding}
				newCloud={newCloud}
				setNewCloud={setNewCloud}
				addCloud={addCloud}
			/>
			<div className="settings-resource">
				<h3>接続確認の記録</h3>
				<p className="hint">
					保存した設定で確認します。会話テストはAPIへの送信と少量の利用が発生します。
				</p>
				{probes.data?.map((p) => (
					<p key={p.id}>
						{p.target === "larm"
							? "LARM"
							: (value.resources.find((r) => r.id === p.target)?.model ??
								"削除されたモデル")}
						: {p.status}
						{p.error && ` (${p.error})`}
						{p.revision !== value.revision && " — 以前の設定"}
						{p.status === "running" && (
							<Button
								size="sm"
								onClick={() =>
									void client.cancelProbe(p.id).then(() => probes.refetch())
								}
							>
								取消
							</Button>
						)}
					</p>
				))}
			</div>
		</>
	);
}
