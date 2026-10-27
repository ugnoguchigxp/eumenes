import "./ExternalAppLauncher.css";
import { ExternalLink } from "lucide-react";
import { Button } from "../Button";

export type ExternalAppLauncherProps = {
	label: string;
	available: boolean;
	busy?: boolean;
	preparing?: boolean;
	error?: string;
	onRetry?: () => void;
	onOpen: () => void;
};

/** Presentation only: credentials, URLs and application APIs stay with the host. */
export function ExternalAppLauncher({
	label,
	available,
	busy = false,
	preparing = false,
	error,
	onRetry,
	onOpen,
}: ExternalAppLauncherProps) {
	return (
		<section className="ds-external-app-launcher" aria-label={label}>
			<Button
				type="button"
				onClick={onOpen}
				disabled={!available || busy || preparing}
				aria-busy={busy || preparing}
			>
				<ExternalLink size={16} aria-hidden="true" />
				{preparing ? "起動を準備しています…" : busy ? "接続しています…" : label}
			</Button>
			<p>別タブで開きます。</p>
			{!available && !preparing && !error && (
				<p role="status">
					接続を利用できません。保存済みの接続設定を確認してください。
				</p>
			)}
			{error && <p role="alert">{error}</p>}
			{error && onRetry && (
				<Button type="button" onClick={onRetry} disabled={preparing || busy}>
					起動を再試行
				</Button>
			)}
		</section>
	);
}
