import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import {
	connectingHint,
	connectionEndReasonLabel,
	connectionStateLabels,
	unavailableLabel,
} from "./labels";
import type { BrowserConnection as Connection } from "./types";

export type BrowserConnectionPanelProps = {
	connection: Connection;
	executablePath?: string;
	pending?: boolean;
	onConnect: () => void;
	onDisconnect: () => void;
	onSaveExecutablePath: (path: string) => void;
};

/** 接続の開始・切断と、Braveの実行ファイルのパス設定。 */
export function BrowserConnectionPanel({
	connection,
	executablePath,
	pending,
	onConnect,
	onDisconnect,
	onSaveExecutablePath,
}: BrowserConnectionPanelProps) {
	const id = useId();
	const [draft, setDraft] = useState(executablePath ?? "");
	const configured = Boolean(executablePath?.trim());
	const { state, endReason } = connection;
	const trimmed = draft.trim();
	return (
		<section className="browser-workspace-section" aria-label="接続">
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
			<details open={!configured || undefined}>
				<summary>設定</summary>
				<form
					className="browser-workspace-open"
					aria-label="Braveの実行ファイル"
					onSubmit={(event) => {
						event.preventDefault();
						if (trimmed) onSaveExecutablePath(trimmed);
					}}
				>
					<Input
						id={`${id}-path`}
						aria-label="Braveの実行ファイルのパス"
						placeholder="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
						value={draft}
						disabled={pending}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button type="submit" disabled={pending || !trimmed}>
						保存
					</Button>
				</form>
			</details>
		</section>
	);
}
