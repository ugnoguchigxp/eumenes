import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import {
	connectingHint,
	connectionEndReasonLabel,
	connectionStateLabels,
	unavailableLabel,
} from "./labels";
import type {
	BrowserConnection as Connection,
	BrowserPickedPath,
} from "./types";

export type BrowserConnectionPanelProps = {
	settingsOnly?: boolean;
	connectionOnly?: boolean;
	connection: Connection;
	executablePath?: string;
	suggestedExecutablePath?: string;
	pickedExecutable?: BrowserPickedPath;
	canBrowseExecutable?: boolean;
	pending?: boolean;
	onConnect: () => void;
	onDisconnect: () => void;
	onSaveExecutablePath: (path: string) => void;
	onBrowseExecutablePath?: () => void;
};

/** 接続の開始・切断と、Braveの実行ファイルのパス設定。 */
export function BrowserConnectionPanel({
	settingsOnly,
	connectionOnly,
	connection,
	executablePath,
	suggestedExecutablePath,
	pickedExecutable,
	canBrowseExecutable,
	pending,
	onConnect,
	onDisconnect,
	onSaveExecutablePath,
	onBrowseExecutablePath,
}: BrowserConnectionPanelProps) {
	const id = useId();
	const configured = Boolean(executablePath?.trim());
	const picked = pickedExecutable?.path.trim() ? pickedExecutable : undefined;
	const offered =
		configured || picked ? undefined : suggestedExecutablePath?.trim();
	// A chosen file, the saved path or an offered install arrives after the first render; it replaces
	// the field then. Each choice counts, even of the same file again.
	const initial =
		picked?.path.trim() ??
		(configured ? (executablePath ?? "") : (offered ?? ""));
	const seed = picked ? `pick:${picked.pickId}` : `value:${initial}`;
	const [draft, setDraft] = useState(initial);
	const [shown, setShown] = useState(seed);
	if (seed !== shown) {
		setShown(seed);
		setDraft(initial);
	}
	const { state, endReason } = connection;
	const trimmed = draft.trim();
	return (
		<section className="browser-workspace-section" aria-label="接続">
			{!settingsOnly && (
				<>
					<h3>
						接続 <span>{connectionStateLabels[state]}</span>
					</h3>
					{state === "disconnected" && (
						<>
							{!configured && (
								<p className="browser-workspace-empty">
									{unavailableLabel("browser_not_configured")}
								</p>
							)}
							{endReason && (
								<p className="browser-workspace-empty">
									{connectionEndReasonLabel(endReason)}
								</p>
							)}
							<div className="browser-workspace-actions">
								<Button
									type="button"
									disabled={pending || !configured}
									onClick={onConnect}
								>
									ブラウザに接続
								</Button>
							</div>
						</>
					)}
					{state === "connecting" && (
						<output className="browser-workspace-feedback" aria-live="polite">
							{connectingHint}
						</output>
					)}
					{state === "connected" && (
						<div className="browser-workspace-actions">
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={onDisconnect}
							>
								切断
							</Button>
						</div>
					)}
				</>
			)}
			{!connectionOnly && (
				<details open={settingsOnly || !configured || undefined}>
					<summary>Braveの場所</summary>
					{offered && (
						<p className="browser-workspace-empty">
							このコンピュータでBraveが見つかりました。保存すると接続できます。
						</p>
					)}
					<form
						className="browser-workspace-open"
						aria-label="Braveの実行ファイル"
						onSubmit={(event) => {
							event.preventDefault();
							onSaveExecutablePath(trimmed);
						}}
					>
						<Input
							id={`${id}-path`}
							aria-label="Braveの実行ファイルのパス"
							placeholder="例: /Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
							value={draft}
							disabled={pending}
							onChange={(event) => setDraft(event.target.value)}
						/>
						{canBrowseExecutable && onBrowseExecutablePath && (
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={onBrowseExecutablePath}
							>
								参照…
							</Button>
						)}
						<Button
							type="submit"
							disabled={pending || (!trimmed && !configured)}
						>
							保存
						</Button>
					</form>
				</details>
			)}
		</section>
	);
}
