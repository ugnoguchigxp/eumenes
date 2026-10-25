import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../client";
import { Button, Modal } from "../design-system";
import "./ErrorReportDialog.css";

type Report =
	| { state: "loading" }
	| { state: "ready"; text: string }
	| { state: "error" };

/**
 * The answer of a run that ended without one (failed or interrupted), shown as the assistant's bubble: what
 * went wrong in one line, with the full error report one click away. It is the only place this is reported.
 */
export function RunFailureNotice({
	client,
	runId,
	summary,
	agentName,
}: {
	client: EumenesClient;
	runId: string;
	summary: string;
	agentName?: string;
}) {
	return (
		<article
			className="message message-assistant message-error"
			aria-label="回答エラー"
		>
			<small className="message-author">{agentName || "Eumenes"}</small>
			<div className="message-error-head">
				<svg
					aria-hidden="true"
					viewBox="0 0 24 24"
					width="16"
					height="16"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
					<path d="M12 9v4M12 17h.01" />
				</svg>
				<strong>回答を取得できませんでした</strong>
			</div>
			<p className="message-error-summary">{summary}</p>
			<ErrorReportButton client={client} runId={runId} summary={summary} />
		</article>
	);
}

/**
 * The detail of a failed answer: the diagnostic text the backend builds for the run, shown in a dialog and
 * copied as one block for pasting into an LLM. The text is fetched when the dialog opens and kept only here.
 */
export function ErrorReportButton({
	client,
	runId,
	summary,
}: {
	client: EumenesClient;
	runId: string;
	/** The one-line cause shown above the report, when the caller knows it. */
	summary?: string;
}) {
	const [open, setOpen] = useState(false);
	const [report, setReport] = useState<Report>({ state: "loading" });
	const [copied, setCopied] = useState<"done" | "failed" | null>(null);
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		client
			.runErrorReport(runId, controller.signal)
			.then((value) => setReport({ state: "ready", text: value.text }))
			.catch(() => {
				if (!controller.signal.aborted) setReport({ state: "error" });
			});
		return () => controller.abort();
	}, [client, runId, open]);
	const show = () => {
		setReport({ state: "loading" });
		setCopied(null);
		setOpen(true);
	};
	const copy = () => {
		if (report.state !== "ready") return;
		const write = navigator.clipboard?.writeText(report.text);
		if (!write) return setCopied("failed");
		write.then(
			() => setCopied("done"),
			() => setCopied("failed"),
		);
	};
	return (
		<>
			<Button
				variant="secondary"
				size="sm"
				className="error-report-open"
				onClick={show}
			>
				エラーの詳細
			</Button>
			<Modal
				open={open}
				onOpenChange={(next) => (next ? show() : setOpen(false))}
				title="エラーレポート"
				description="IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください"
				draggable={false}
			>
				<div className="aui-stack">
					{summary && (
						<section className="error-report-summary" aria-label="エラーの概要">
							<strong>回答を取得できませんでした</strong>
							<p>{summary}</p>
						</section>
					)}
					{report.state === "loading" && <output>読み込み中</output>}
					{report.state === "error" && (
						<p role="alert">エラーレポートを取得できませんでした。</p>
					)}
					{report.state === "ready" && (
						<pre className="error-report-text" aria-label="エラーレポート本文">
							{report.text}
						</pre>
					)}
					<Button
						type="button"
						variant="secondary"
						disabled={report.state !== "ready"}
						onClick={copy}
					>
						{copied === "done" ? "コピーしました" : "レポートをコピー"}
					</Button>
					{copied === "failed" && (
						<p role="alert">
							コピーできませんでした。テキストを選択してください。
						</p>
					)}
				</div>
			</Modal>
		</>
	);
}
