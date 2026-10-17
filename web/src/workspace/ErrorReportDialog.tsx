import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../client";
import { Button, Modal } from "../design-system";
import "./ErrorReportDialog.css";

type Report =
	| { state: "loading" }
	| { state: "ready"; text: string }
	| { state: "error" };

/**
 * The detail of a failed answer: the diagnostic text the backend builds for the run, shown in a dialog and
 * copied as one block for pasting into an LLM. The text is fetched when the dialog opens and kept only here.
 */
export function ErrorReportButton({
	client,
	runId,
}: {
	client: EumenesClient;
	runId: string;
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
			<Button variant="ghost" size="sm" onClick={show}>
				詳細
			</Button>
			<Modal
				open={open}
				onOpenChange={(next) => (next ? show() : setOpen(false))}
				title="エラーレポート"
				description="IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください"
				draggable={false}
			>
				<div className="aui-stack">
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
						{copied === "done" ? "コピーしました" : "コピー"}
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
