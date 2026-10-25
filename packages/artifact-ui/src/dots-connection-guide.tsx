import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
	Input,
	Textarea,
} from "@eumenes/design-system";
import { useId } from "react";
export type DotsConnectionSetup = { resourceUrl: string; clientId?: string };
const monitoringRequest =
	"このプラグインの command.available（queue_id=eumenes-dots）を監視し、届いたメッセージに返答して、返答と累積要約をMCPへ保存してください。連携手順に従い、作業用Sessionや定期ポーリングは作らないでください。";
/** Public registration details only. OAuth credentials stay with the server and ChatGPT. */
export function DotsConnectionGuide({ setup }: { setup: DotsConnectionSetup }) {
	const id = useId();
	return (
		<Card>
			<CardHeader>
				<CardTitle>ChatGPTとの接続</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p>ChatGPTのプラグイン設定で、このEumenesにOAuthで接続してください。</p>
				<label htmlFor={`${id}-url`}>MCPサーバーURL</label>
				<Input id={`${id}-url`} value={setup.resourceUrl} readOnly />
				{setup.clientId && (
					<>
						<label htmlFor={`${id}-client`}>公開クライアントID</label>
						<Input id={`${id}-client`} value={setup.clientId} readOnly />
						<p className="text-sm text-muted-foreground">
							クライアントシークレットは空欄にします。公開クライアントの認証方式は
							none です。
						</p>
					</>
				)}
				<a
					className="underline"
					href="https://chatgpt.com/plugins"
					target="_blank"
					rel="noopener noreferrer"
				>
					ChatGPTで接続設定を開く
				</a>
				<ol className="list-decimal pl-5 space-y-2">
					<li>
						カスタムMCPサーバーを追加し、上のURLとOAuthを指定します。既存の接続を使う場合は、ツールとイベントを再スキャンします。
					</li>
					<li>
						対象のdotでこのプラグインを選び、次の依頼文を送って監視を開始します。
					</li>
					<li>
						この画面で状態を更新し、監視登録後にメッセージを送ります。初回の返答で接続を確認します。
					</li>
				</ol>
				<label htmlFor={`${id}-monitor`}>監視開始の依頼文</label>
				<Textarea
					id={`${id}-monitor`}
					value={monitoringRequest}
					readOnly
					rows={4}
				/>
				<p className="text-sm text-muted-foreground">
					連携後に渡したメッセージから返答と要約を受け取ります。ChatGPTの会話画面全体の取得権限を付与する操作ではありません。
				</p>
			</CardContent>
		</Card>
	);
}
