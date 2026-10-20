import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { BrowserConnectionPanel } from "./BrowserConnectionPanel";
import type { BrowserWorkspaceProps } from "./types";

export function BrowserSettings(
	props: BrowserWorkspaceProps & {
		bridge?: {
			revision: number;
			enabled: boolean;
			configured: boolean;
			available: boolean;
		};
		onSaveBridge: (input: {
			token: string;
			enabled: boolean;
			clear: boolean;
			expectedRevision: number;
		}) => Promise<boolean>;
		onOpenBrowser: () => void;
	},
) {
	const tokenId = useId();
	const [token, setToken] = useState("");
	const [enabled, setEnabled] = useState(props.bridge?.enabled ?? false);
	const [version, setVersion] = useState(props.bridge?.revision);
	if (version !== props.bridge?.revision) {
		setVersion(props.bridge?.revision);
		setToken("");
		setEnabled(props.bridge?.enabled ?? false);
	}
	async function save(clear = false) {
		try {
			await props.onSaveBridge({
				token: clear ? "" : token,
				enabled: clear ? false : enabled,
				clear,
				expectedRevision: props.bridge?.revision ?? 0,
			});
		} finally {
			setToken("");
		}
	}
	return (
		<section className="browser-workspace" aria-label="ブラウザの設定">
			<BrowserConnectionPanel {...props} settingsOnly />
			<section
				className="browser-workspace-section"
				aria-label="拡張機能と接続の承認"
			>
				<h3>拡張機能と接続の承認</h3>
				<strong>Playwright MCP Bridge</strong>
				<a
					href="https://github.com/microsoft/playwright/blob/main/packages/extension/README.md"
					target="_blank"
					rel="noreferrer"
				>
					導入とトークン取得の手順
				</a>
				<label>
					<input
						type="checkbox"
						checked={enabled}
						disabled={props.pending || !props.bridge?.available}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					接続時の手動承認を省略
				</label>
				<p>
					{props.bridge?.configured
						? "接続トークンは登録済みです。変更する場合だけ入力してください。"
						: "拡張機能に表示される接続トークンを登録してください。"}
				</p>
				<label htmlFor={tokenId}>
					接続トークン
					<Input
						id={tokenId}
						type="password"
						autoComplete="off"
						aria-label="接続トークン"
						value={token}
						disabled={props.pending || !props.bridge?.available}
						onChange={(e) => setToken(e.target.value)}
					/>
				</label>
				{!props.bridge?.available && (
					<p role="status">
						接続トークンの設定を取得できないか、暗号化の準備ができていません。
					</p>
				)}
				<p className="browser-workspace-feedback">
					接続用ページが開く場合があります。送信・購入などの操作の承認は引き続き必要です。
				</p>
				<div className="browser-workspace-actions">
					<Button
						disabled={
							props.pending ||
							!props.bridge?.available ||
							(enabled && !token && !props.bridge?.configured)
						}
						onClick={() => void save()}
					>
						承認の設定を保存
					</Button>
					{props.bridge?.configured && (
						<Button
							variant="outline"
							disabled={props.pending}
							onClick={() => void save(true)}
						>
							トークンを削除
						</Button>
					)}
				</div>
			</section>
			<Button variant="outline" onClick={props.onOpenBrowser}>
				ブラウザを開く
			</Button>
			{props.error && <p role="alert">{props.error}</p>}
			{props.message && <output aria-live="polite">{props.message}</output>}
		</section>
	);
}
