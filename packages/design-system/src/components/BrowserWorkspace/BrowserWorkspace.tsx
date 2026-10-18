import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { BrowserCaptureList } from "./BrowserCaptureList";
import { BrowserConnectionPanel } from "./BrowserConnectionPanel";
import { BrowserTabList } from "./BrowserTabList";
import { BrowserTaskList } from "./BrowserTaskList";
import { disconnectedNote, unavailableLabel } from "./labels";
import type { BrowserWorkspaceProps } from "./types";
import "./BrowserWorkspace.css";

export type { BrowserWorkspaceProps } from "./types";

function urlProblem(value: string): string | undefined {
	const text = value.trim();
	if (!text) return "開きたいURLを入力してください。";
	try {
		const url = new URL(text);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return "http または https のURLを入力してください。";
	} catch {
		return "URLの形式が正しくありません。";
	}
	return undefined;
}

/** Props only: the host supplies every tab, task and capture and handles each event. */
export function BrowserWorkspace({
	title = "ブラウザ",
	availability,
	connection,
	executablePath,
	tabs,
	tasks,
	captures,
	selectedCaptureId,
	previewSrc,
	pending,
	loading,
	error,
	message,
	onConnect,
	onDisconnect,
	onSaveExecutablePath,
	onOpenUrl,
	onFocusTab,
	onCloseTab,
	onSelectCapture,
	onDownloadCapture,
	onCancelTask,
	onCancelCapture,
}: BrowserWorkspaceProps) {
	const id = useId();
	const [url, setUrl] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const available = availability.available;
	const connected = connection.state === "connected";
	const disabled = !available || pending;
	const problem = submitted ? urlProblem(url) : undefined;
	function submit() {
		setSubmitted(true);
		if (urlProblem(url)) return;
		onOpenUrl(url.trim());
		setUrl("");
		setSubmitted(false);
	}
	return (
		<section
			className="browser-workspace"
			aria-label={title}
			aria-busy={loading || undefined}
		>
			{!availability.available && (
				<p role="alert" className="browser-workspace-unavailable">
					現在は使えません。{unavailableLabel(availability.reason)}
				</p>
			)}
			<BrowserConnectionPanel
				connection={connection}
				executablePath={executablePath}
				pending={pending}
				onConnect={onConnect}
				onDisconnect={onDisconnect}
				onSaveExecutablePath={onSaveExecutablePath}
			/>
			{connected ? (
				<>
					<form
						className="browser-workspace-section"
						aria-label="新しくURLを開く"
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
					>
						<h3>新しくURLを開く</h3>
						<div className="browser-workspace-open">
							<Input
								id={`${id}-url`}
								type="url"
								inputMode="url"
								aria-label="開くURL"
								aria-invalid={problem ? true : undefined}
								aria-describedby={problem ? `${id}-url-error` : undefined}
								placeholder="https://example.com"
								value={url}
								disabled={disabled}
								onChange={(event) => setUrl(event.target.value)}
							/>
							<Button type="submit" disabled={disabled}>
								新しく開く
							</Button>
						</div>
						{problem && (
							<p
								id={`${id}-url-error`}
								role="alert"
								className="browser-workspace-problem"
							>
								{problem}
							</p>
						)}
					</form>
					<BrowserTabList
						tabs={tabs}
						disabled={disabled}
						onFocusTab={onFocusTab}
						onCloseTab={onCloseTab}
					/>
				</>
			) : (
				<p className="browser-workspace-empty">{disconnectedNote}</p>
			)}
			<BrowserTaskList
				tasks={tasks}
				disabled={pending}
				onCancelTask={onCancelTask}
			/>
			<BrowserCaptureList
				captures={captures}
				selectedCaptureId={selectedCaptureId}
				previewSrc={previewSrc}
				disabled={pending}
				onSelectCapture={onSelectCapture}
				onDownloadCapture={onDownloadCapture}
				onCancelCapture={onCancelCapture}
			/>
			{loading && (
				<output className="browser-workspace-feedback">読み込み中です。</output>
			)}
			{error && (
				<p role="alert" className="browser-workspace-problem">
					{error}
				</p>
			)}
			{message && (
				<output className="browser-workspace-feedback" aria-live="polite">
					{message}
				</output>
			)}
		</section>
	);
}
