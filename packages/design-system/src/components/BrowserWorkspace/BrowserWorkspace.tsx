import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { BrowserCaptureList } from "./BrowserCaptureList";
import { BrowserConnectionPanel } from "./BrowserConnectionPanel";
import { BrowserHistoryDetailModal } from "./BrowserHistoryDetail";
import { BrowserHistoryList } from "./BrowserHistoryList";
import { BrowserTabList } from "./BrowserTabList";
import { BrowserScriptPanel } from "./BrowserScriptPanel";
import {
	connectionStateLabels,
	disconnectedNote,
	unavailableLabel,
} from "./labels";
import type { BrowserWorkspaceProps } from "./types";
import "./BrowserWorkspace.css";
export type { BrowserWorkspaceProps } from "./types";

function urlProblem(value: string): string | undefined {
	if (!value.trim()) return "開きたいURLを入力してください。";
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return "http または https のURLを入力してください。";
	} catch {
		return "URLの形式が正しくありません。";
	}
	return undefined;
}

/** Content inside the shared ArtifactPanel. Requests and answers remain in the conversation. */
export function BrowserWorkspace(props: BrowserWorkspaceProps) {
	const id = useId();
	const [url, setUrl] = useState("");
	const [activeView, setActiveView] = useState("operation");
	const [submitted, setSubmitted] = useState(false);
	const {
		connection,
		availability,
		pending,
		tabs,
		tasks,
		captures,
		histories,
		replays,
	} = props;
	const openHistory = histories.find(
		(h) => h.historyId === props.selectedHistoryId,
	);
	const historyDetail =
		props.historyDetail?.historyId === props.selectedHistoryId
			? props.historyDetail
			: undefined;
	const focusSeq = props.focus?.seq;
	const focusCaptureId = props.focus?.captureId;
	const selectCapture = useRef(props.onSelectCapture);
	useEffect(() => {
		selectCapture.current = props.onSelectCapture;
	});
	const [shownFocus, setShownFocus] = useState<number>();
	if (focusSeq !== shownFocus) {
		setShownFocus(focusSeq);
		if (focusSeq !== undefined) setActiveView("captures");
	}
	useEffect(() => {
		if (focusSeq !== undefined && focusCaptureId)
			selectCapture.current(focusCaptureId);
	}, [focusSeq, focusCaptureId]);
	const connected = connection.state === "connected";
	const disabled = !availability.available || pending;
	const problem = submitted ? urlProblem(url) : undefined;
	return (
		<section
			className="browser-workspace"
			aria-label={props.title ?? "ブラウザ"}
			aria-busy={props.loading || undefined}
		>
			<div className="browser-workspace-toolbar">
				<span data-connected={connected}>
					{connectionStateLabels[connection.state]}
				</span>
				<span className="browser-workspace-target">
					対象: {tabs.find((t) => t.active)?.title || "未選択"}
				</span>
				{props.onOpenSettings && (
					<Button variant="ghost" size="sm" onClick={props.onOpenSettings}>
						設定
					</Button>
				)}
			</div>
			<Tabs value={activeView} onValueChange={setActiveView}>
				<TabsList aria-label="ブラウザの表示">
					<TabsTrigger value="operation">操作</TabsTrigger>
					<TabsTrigger value="history">履歴</TabsTrigger>
					<TabsTrigger value="connection">接続・タブ</TabsTrigger>
					<TabsTrigger value="captures">撮影画像</TabsTrigger>
				</TabsList>
				<TabsContent
					value="operation"
					forceMount
					hidden={activeView !== "operation"}
				>
					<BrowserScriptPanel
						tasks={tasks}
						pending={pending}
						onCancelTask={props.onCancelTask}
					/>
				</TabsContent>
				<TabsContent value="history">
					<BrowserHistoryList
						histories={histories}
						replays={replays}
						pending={pending}
						onOpen={props.onSelectHistory}
						onReplay={props.onReplayHistory}
						onCancelReplay={props.onCancelReplay}
					/>
				</TabsContent>
				<TabsContent value="connection">
					{!availability.available && (
						<p role="status">{unavailableLabel(availability.reason)}</p>
					)}
					<BrowserConnectionPanel {...props} connectionOnly />
					{connected ? (
						<>
							<form
								className="browser-workspace-section"
								aria-label="新しくURLを開く"
								onSubmit={(e) => {
									e.preventDefault();
									setSubmitted(true);
									if (urlProblem(url)) return;
									props.onOpenUrl(url.trim());
									setUrl("");
									setSubmitted(false);
								}}
							>
								<h3>新しくURLを開く</h3>
								<div className="browser-workspace-open">
									<Input
										id={`${id}-url`}
										aria-label="開くURL"
										type="url"
										inputMode="url"
										placeholder="https://example.com"
										aria-invalid={problem ? true : undefined}
										value={url}
										disabled={disabled}
										onChange={(e) => setUrl(e.target.value)}
									/>
									<Button type="submit" disabled={disabled}>
										新しく開く
									</Button>
								</div>
								{problem && <p role="alert">{problem}</p>}
							</form>
							<BrowserTabList
								tabs={tabs}
								disabled={disabled}
								onFocusTab={props.onFocusTab}
								onCloseTab={props.onCloseTab}
							/>
						</>
					) : (
						<p className="browser-workspace-empty">{disconnectedNote}</p>
					)}
				</TabsContent>
				<TabsContent value="captures">
					<BrowserCaptureList
						captures={captures}
						selectedCaptureId={props.selectedCaptureId}
						previewSrc={props.previewSrc}
						disabled={pending}
						onSelectCapture={props.onSelectCapture}
						onDownloadCapture={props.onDownloadCapture}
						onCancelCapture={props.onCancelCapture}
					/>
				</TabsContent>
			</Tabs>
			{props.selectedHistoryId && (
				<BrowserHistoryDetailModal
					key={props.selectedHistoryId}
					fallbackTitle={openHistory?.title ?? "履歴"}
					detail={historyDetail}
					replay={replays.find((r) => r.historyId === props.selectedHistoryId)}
					error={props.historyDetailError}
					pending={pending}
					message={props.message}
					onClose={() => props.onSelectHistory(undefined)}
					onDelete={props.onDeleteHistory}
					onReplay={props.onReplayHistory}
					onCancelReplay={props.onCancelReplay}
				/>
			)}
			{props.loading && (
				<output className="browser-workspace-feedback">読み込み中です。</output>
			)}
			{props.error && (
				<p role="alert" className="browser-workspace-problem">
					{props.error}
				</p>
			)}
			{props.message && !props.selectedHistoryId && (
				<output aria-live="polite" className="browser-workspace-feedback">
					{props.message}
				</output>
			)}
		</section>
	);
}
