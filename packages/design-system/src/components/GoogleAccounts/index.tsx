import { useState } from "react";
import {
	ArrowLeft,
	Check,
	CircleAlert,
	ExternalLink,
	Image,
	Mail,
	UserRound,
} from "lucide-react";
import "./style.css";
export type GoogleAccountsProps = {
	revision?: number;
	configured: boolean;
	status: "disconnected" | "connected" | "reconnect" | "disconnecting";
	profile?: { name: string; email: string; picture?: string };
	pending: boolean;
	busy?: boolean;
	message?: string;
	authorizationUrl?: string;
	onConnect(): void;
	onCancel(): void;
	onDisconnect(): void;
	onBack(): void;
};
function GoogleMark({ small = false }: { small?: boolean }) {
	return (
		<svg
			aria-hidden="true"
			width={small ? 22 : 56}
			height={small ? 22 : 56}
			viewBox="0 0 48 48"
		>
			<path
				fill="#4285F4"
				d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.8-3.5 6.1-8.7 6.1-15z"
			/>
			<path
				fill="#34A853"
				d="M24 44c5.4 0 9.9-1.8 13.2-4.8l-6.6-5.1c-1.8 1.2-4 1.9-6.6 1.9-5.2 0-9.6-3.5-11.2-8.2H6v5.3A20 20 0 0 0 24 44z"
			/>
			<path
				fill="#FBBC05"
				d="M12.8 27.8a12 12 0 0 1 0-7.6v-5.3H6a20 20 0 0 0 0 18.2z"
			/>
			<path
				fill="#EA4335"
				d="M24 12c2.9 0 5.4 1 7.4 2.9l5.6-5.6A19.2 19.2 0 0 0 24 4 20 20 0 0 0 6 14.9l6.8 5.3C14.4 15.5 18.8 12 24 12z"
			/>
		</svg>
	);
}
export function GoogleAccounts(props: GoogleAccountsProps) {
	const [confirmation, setConfirmation] = useState<{
		revision?: number;
		email?: string;
	} | null>(null);
	const confirm =
		confirmation !== null &&
		confirmation.revision === props.revision &&
		confirmation.email === props.profile?.email &&
		props.configured &&
		props.status !== "disconnecting";
	const disabled = props.busy || props.pending;
	const linked = !!props.profile;
	return (
		<section className="ds-google-accounts" aria-label="Google連携">
			<button className="ds-google-back" type="button" onClick={props.onBack}>
				<ArrowLeft size={17} />
				設定
			</button>
			<header>
				<h2>Google連携</h2>
				<p>Googleアカウントの接続を管理します。</p>
			</header>
			{!props.configured && (
				<div className="ds-google-notice" role="status">
					この配布版にはGoogle連携の設定が含まれていません。設定済みの配布版では、ここからGoogleにログインして接続できます。
				</div>
			)}
			{linked ? (
				<>
					<h3>接続済みアカウント</h3>
					<div className="ds-google-card">
						<div className="ds-google-identity">
							<div className="ds-google-avatar">
								{props.profile?.picture ? (
									<img
										src={props.profile.picture}
										alt=""
										referrerPolicy="no-referrer"
									/>
								) : (
									props.profile?.name.slice(0, 1)
								)}
							</div>
							<div className="ds-google-person">
								<strong>{props.profile?.name}</strong>
								<span>{props.profile?.email}</span>
							</div>
							<span
								className={`ds-google-badge ${props.status === "connected" ? "is-connected" : "is-warning"}`}
							>
								{props.status === "connected" ? (
									<Check size={15} />
								) : (
									<CircleAlert size={15} />
								)}{" "}
								{props.status === "connected"
									? "接続済み"
									: props.status === "disconnecting"
										? "解除中"
										: "再接続が必要"}
							</span>
						</div>
						{props.status === "reconnect" ? (
							<div className="ds-google-reconnect">
								<strong>
									<CircleAlert size={20} />
									もう一度、認証してください
								</strong>
								<p>接続を続けるにはGoogleでの確認が必要です。</p>
								<button
									className="ds-google-primary"
									disabled={disabled || !props.configured}
									onClick={props.onConnect}
									type="button"
								>
									再接続する
								</button>
							</div>
						) : props.status === "disconnecting" ? (
							<div className="ds-google-notice">
								Google側の連携解除を確認しています。通信が戻ると自動で再試行します。
							</div>
						) : (
							<div className="ds-google-permissions">
								<h4>許可済みのアクセス</h4>
								<p>
									<Check size={20} />
									基本プロフィール
								</p>
								<p>
									<Check size={20} />
									メールアドレス
								</p>
							</div>
						)}
						<div className="ds-google-card-footer">
							<button
								className="ds-google-danger"
								type="button"
								disabled={
									!props.configured ||
									props.busy ||
									props.status === "disconnecting"
								}
								onClick={() =>
									setConfirmation({
										revision: props.revision,
										email: props.profile?.email,
									})
								}
							>
								連携を解除
							</button>
						</div>
					</div>
					<p className="ds-google-hint">
						別のアカウントを利用する場合は、連携を解除してから接続してください。
					</p>
				</>
			) : (
				<>
					<div className="ds-google-empty">
						<GoogleMark />
						<h3>Googleアカウントを接続</h3>
						<p>
							利用するアカウントを選んで
							<br />
							Eumenesと連携します。
						</p>
						<button
							className="ds-google-connect"
							type="button"
							onClick={props.onConnect}
							disabled={disabled || !props.configured}
						>
							<GoogleMark small />
							Googleアカウントを接続
						</button>
						<span className="ds-google-hint">
							<ExternalLink size={15} />
							Googleの認証画面が別タブで開きます
						</span>
					</div>
					<div className="ds-google-information">
						<h4>接続時に確認する情報</h4>
						<p>
							<UserRound size={21} />
							名前
						</p>
						<p>
							<Mail size={21} />
							メールアドレス
						</p>
						<p>
							<Image size={21} />
							プロフィール画像
						</p>
					</div>
				</>
			)}
			{props.pending && (
				<div className="ds-google-notice" role="status">
					Googleでの認証を待っています。
					{props.authorizationUrl && (
						<a
							href={props.authorizationUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							認証画面を開く <ExternalLink size={13} />
						</a>
					)}
					<button
						type="button"
						className="ds-google-back"
						disabled={props.busy}
						onClick={props.onCancel}
					>
						キャンセル
					</button>
				</div>
			)}
			{confirm && (
				<div
					className="ds-google-confirm"
					role="alertdialog"
					aria-label="Google連携を解除しますか？"
				>
					<strong>Google連携を解除しますか？</strong>
					<p>
						Eumenesから接続情報を削除し、Googleへのアクセス許可を取り消します。
					</p>
					<div>
						<button type="button" onClick={() => setConfirmation(null)}>
							キャンセル
						</button>
						<button
							className="ds-google-danger"
							type="button"
							disabled={props.busy}
							onClick={() => {
								setConfirmation(null);
								props.onDisconnect();
							}}
						>
							解除する
						</button>
					</div>
				</div>
			)}
			<output className="ds-google-message" aria-live="polite">
				{props.message}
			</output>
			{linked && (
				<p className="ds-google-saved">接続情報は自動で保存されます</p>
			)}
		</section>
	);
}
