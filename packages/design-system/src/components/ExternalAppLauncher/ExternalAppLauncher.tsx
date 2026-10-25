import "./ExternalAppLauncher.css";
import { ExternalLink } from "lucide-react";
import { Button } from "../Button";

export type ExternalAppLauncherProps = {
	label: string;
	available: boolean;
	busy?: boolean;
	error?: string;
	onOpen: () => void;
};

/** Presentation only: credentials, URLs and application APIs stay with the host. */
export function ExternalAppLauncher({
	label,
	available,
	busy = false,
	error,
	onOpen,
}: ExternalAppLauncherProps) {
	return (
		<section className="ds-external-app-launcher" aria-label={label}>
			<Button
				type="button"
				onClick={onOpen}
				disabled={!available || busy}
				aria-busy={busy}
			>
				<ExternalLink size={16} aria-hidden="true" />
				{busy ? "接続しています…" : label}
			</Button>
			<p>別タブで開きます。</p>
			{!available && (
				<p role="status">
					接続を利用できません。保存済みの接続設定を確認してください。
				</p>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
