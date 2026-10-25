import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import { Button, Modal } from "../design-system";
import "./ErrorReportDialog.css";

type Report =
	| { state: "loading" }
	| { state: "ready"; text: string }
	| { state: "error" };

/** The heading of a failed answer, in its bubble and above its report. */
export const RUN_FAILURE_HEADING = "回答を取得できませんでした";

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
				<strong>{RUN_FAILURE_HEADING}</strong>
			</div>
			<p className="message-error-summary">{summary}</p>
			<ErrorReportButton
				load={(signal) => client.runErrorReport(runId, signal)}
				heading={RUN_FAILURE_HEADING}
				summary={summary}
			/>
		</article>
	);
}

/**
 * The detail of a failure: the diagnostic text the backend builds, shown in a dialog and copied as one block for
 * pasting into an LLM. The text is fetched when the dialog opens and kept only here. `trigger: "icon"` is the
 * small warning icon for places without room for a text button (the conversation's route track).
 */
export function ErrorReportButton({
	load,
	heading,
	summary,
	trigger = "text",
	label = "エラーの詳細",
	hidden = false,
}: {
	/** Fetches the report text when the dialog opens. */
	load: (signal: AbortSignal) => Promise<{ text: string }>;
	/** The heading of the summary above the report. */
	heading: string;
	/** The one-line cause shown under the heading, when the caller knows it. */
	summary?: string;
	trigger?: "text" | "icon";
	/** The accessible name of the trigger. */
	label?: string;
	/** Hides the trigger while keeping an open dialog (the failure cleared while its report is being read). */
	hidden?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [report, setReport] = useState<Report>({ state: "loading" });
	const [copied, setCopied] = useState<"done" | "failed" | null>(null);
	const loader = useRef(load);
	loader.current = load;
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		loader
			.current(controller.signal)
			.then((value) => setReport({ state: "ready", text: value.text }))
			.catch(() => {
				if (!controller.signal.aborted) setReport({ state: "error" });
			});
		return () => controller.abort();
	}, [open]);
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
			{hidden ? null : trigger === "icon" ? (
				<button
					type="button"
					className="error-report-icon"
					aria-label={label}
					title="エラーの詳細"
					onClick={show}
				>
					<svg
						aria-hidden="true"
						viewBox="0 0 24 24"
						width="12"
						height="12"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
						<path d="M12 9v4M12 17h.01" />
					</svg>
				</button>
			) : (
				<Button
					variant="secondary"
					size="sm"
					className="error-report-open"
					onClick={show}
				>
					{label}
				</Button>
			)}
			<Modal
				open={open}
				onOpenChange={(next) => (next ? show() : setOpen(false))}
				title="エラーレポート"
				description="IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください"
				draggable={false}
			>
				<div className="aui-stack">
					<section className="error-report-summary" aria-label="エラーの概要">
						<strong>{heading}</strong>
						{summary && <p>{summary}</p>}
					</section>
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
