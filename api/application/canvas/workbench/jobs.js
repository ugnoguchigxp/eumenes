export function installCanvasJobs({
	conversationId,
	api,
	$,
	state,
	getSelection,
	hideCandidate,
	setRunStatus,
	notice,
	openArtwork,
	selectArtwork,
	pollRun,
	STATE_TEXT,
	now = Date.now,
	schedule = (callback, ms) => {
		setTimeout(callback, ms);
	},
}) {
	// 受付票は固定。画面の初回表示からジョブの全状態を読み直す。
	const canvasConversation = conversationId;
	let canvasJob = null;
	let lastCanvasRun = null;
	let lastCanvasJob = null;
	let canvasStatusUnavailable = false;
	let canvasUserActivityAt = 0;
	let canvasOperation = 0;
	for (const id of ["composer", "artworks", "revisions", "new-artwork"]) {
		$(id).addEventListener(
			id === "composer" ? "submit" : "click",
			() => {
				canvasUserActivityAt = now();
				canvasOperation++;
			},
			true,
		);
	}
	const CANVAS_JOB_TEXT = {
		queued: "Eumenesから受け付けた依頼を待機中…",
		running: "Eumenesから受け付けた依頼を制作中…",
		retry_wait: "制作の再実行を待機中…",
		cancel_requested: "制作を取り消しています…",
		failed: "制作を完了できませんでした。状態を確認して、依頼を送り直せます。",
		cancelled: "制作を取り消しました。",
		expired: "制作の期限を過ぎました。依頼を送り直せます。",
		interrupted: "制作が中断しました。依頼を送り直せます。",
		outcome_unknown:
			"制作結果を確認できませんでした。保存済み作品を確認してください。",
	};
	const CANVAS_JOB_ERROR = {
		canvas_revision_conflict:
			"編集元の版が変わりました。現在版を開いて作品を選び直してください。",
		canvas_source_changed: "依頼の参照が失効したため制作を終了しました。",
		canvas_model_budget:
			"制作の推論予算を使い切りました。結果を確認して依頼を送り直せます。",
		canvas_request_version_expired:
			"旧版の受付は実行できません。依頼を送り直してください。",
	};
	$("cancel").addEventListener(
		"click",
		(event) => {
			if (!canvasJob || state.runId) return;
			event.stopImmediatePropagation();
			void api("/api/jobs/" + encodeURIComponent(canvasJob.id) + "/cancel", {
				method: "POST",
				body: {},
			}).catch(() =>
				notice("取り消せませんでした。状態を再取得してください。"),
			);
		},
		true,
	);
	async function readCanvasJob() {
		if (!canvasConversation) return;
		const selected = getSelection();
		const operation = canvasOperation;
		try {
			const job = await api(
				"/api/jobs/latest?conversationId=" +
					encodeURIComponent(canvasConversation),
				{ quiet: true },
			);
			if (
				state.runId ||
				operation !== canvasOperation ||
				getSelection() !== selected ||
				!job ||
				job.acceptedAt <= canvasUserActivityAt
			)
				return;
			if (canvasStatusUnavailable) {
				notice("");
				canvasStatusUnavailable = false;
			}
			if (
				["queued", "running", "retry_wait", "cancel_requested"].includes(
					job.state,
				)
			) {
				if (canvasJob?.id !== job.id) hideCandidate();
				canvasJob = job;
				$("cancel").disabled = job.state === "cancel_requested";
				setRunStatus(CANVAS_JOB_TEXT[job.state]);
				return;
			}
			canvasJob = null;
			if (
				job.state === "completed" &&
				job.runId &&
				job.runId !== lastCanvasRun
			) {
				const run = await api("/api/runs/" + encodeURIComponent(job.runId), {
					quiet: true,
				});
				if (
					state.runId ||
					operation !== canvasOperation ||
					getSelection() !== selected
				)
					return;
				if (run.state !== "presented") {
					setRunStatus(
						STATE_TEXT[run.state] || "この候補は現在利用できません。",
					);
					return;
				}
				if (!run.isNew) await openArtwork(run.artworkId);
				else selectArtwork(null);
				if (
					state.runId ||
					operation !== canvasOperation ||
					(!run.isNew && state.artworkId !== run.artworkId)
				)
					return;
				state.runId = run.id;
				lastCanvasRun = run.id;
				void pollRun(run.id);
			} else if (job.state !== "completed") {
				const signature = `${job.id}:${job.state}:${job.errorCode ?? ""}`;
				if (lastCanvasJob !== signature) {
					hideCandidate();
					$("cancel").disabled = true;
					setRunStatus(
						CANVAS_JOB_ERROR[job.errorCode] ||
							CANVAS_JOB_TEXT[job.state] ||
							"制作状況を確認できませんでした。",
					);
					lastCanvasJob = signature;
				}
			}
		} catch {
			if (
				!state.runId &&
				operation === canvasOperation &&
				getSelection() === selected
			) {
				canvasStatusUnavailable = true;
				notice(
					"制作状況を取得できませんでした。再取得を続けています。更新ボタンでも確認できます。",
				);
			}
		}
	}
	let ready = Promise.resolve();
	if (canvasConversation) {
		$("refresh-artworks").addEventListener("click", () => void readCanvasJob());
		ready = (async function pollCanvasJob() {
			await readCanvasJob();
			schedule(pollCanvasJob, 1000);
		})();
	}
	return { refresh: readCanvasJob, ready };
}
