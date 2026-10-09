import type { UseQueryResult } from "@tanstack/react-query";
import type { Usage, Diagnostics } from "../../../../../client/settings";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { purposes } from "../shared";

type DataSectionProps = {
	diagnostics: UseQueryResult<Diagnostics>;
	usage: UseQueryResult<Usage[]>;
	downloadDiagnostics: () => Promise<void>;
};
export function DataSection({
	diagnostics,
	usage,
	downloadDiagnostics,
}: DataSectionProps) {
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>保存と送信</CardTitle>
				</CardHeader>
				<CardContent>
					<p>
						会話・設定・予約はこの端末のデータベースに保存します。APIキーは暗号化してbackendに保管します。
					</p>
					<p>
						クラウド送信の許可は「AIの使い方」で用途ごとに変更できます。費用は利用したサービスで確認してください。
					</p>
					<Button
						variant="secondary"
						onClick={() => void downloadDiagnostics()}
					>
						診断データを保存
					</Button>
					<p className="hint">
						接続状態と利用先の記録を保存します。APIキー・会話本文・録音は含めません。
					</p>
					{diagnostics.data?.keyError && (
						<p role="alert">
							保存済みキーを開けません。backendの暗号鍵を確認してください。LARMと環境変数による接続は引き続き利用できます。
						</p>
					)}
				</CardContent>
			</Card>
			<h3>直近100件の利用記録</h3>
			<div className="settings-table-wrap">
				<table>
					<thead>
						<tr>
							<th>用途</th>
							<th>利用先</th>
							<th>結果</th>
							<th>切替・失敗理由</th>
							<th>入力 / 出力トークン</th>
						</tr>
					</thead>
					<tbody>
						{usage.data?.map((u) => (
							<tr key={u.id}>
								<td>{purposes[u.purpose]}</td>
								<td>
									{u.source} / {u.model}
								</td>
								<td>{u.accepted ? "採用済み" : u.status}</td>
								<td>{u.reason ?? "—"}</td>
								<td>
									{u.inputTokens ?? "不明"} / {u.outputTokens ?? "不明"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{!usage.data?.length && (
				<p className="hint">利用記録はまだありません。</p>
			)}
			{usage.isError && <p role="alert">利用記録を読み込めません。</p>}
		</>
	);
}
