import { useEffect, useState } from "react";
import "./live-voice.css";
import { Button } from "../../design-system";
import type { LiveNotice } from "../../../../api/domains/live-voice/contracts";
import type { useLiveVoice } from "./useLiveVoice";

function Notice({
	notice,
	onDisplayed,
}: {
	notice: LiveNotice;
	onDisplayed: (id: string) => Promise<void>;
}) {
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (notice.kind === "announcement" && !notice.displayed)
			void onDisplayed(notice.id).catch(() => {});
	}, [notice.id, notice.kind, notice.displayed, onDisplayed]);
	return (
		<div className="conversation-notice">
			<span>
				{notice.kind === "confirmation" ? "確認内容: " : "案内: "}
				{notice.text}
			</span>
			{notice.kind === "confirmation" && !notice.displayed && (
				<Button
					type="button"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						setError(false);
						void onDisplayed(notice.id)
							.catch(() => setError(true))
							.finally(() => setBusy(false));
					}}
				>
					内容を確認しました
				</Button>
			)}
			{error && (
				<span role="alert">
					確認を記録できませんでした。もう一度お試しください。
				</span>
			)}
		</div>
	);
}
export function LiveVoicePanel({
	live,
}: {
	live: ReturnType<typeof useLiveVoice>;
}) {
	if (!live.session || (live.session.test && !live.active)) return null;
	return (
		<section aria-label="音声会話" className="live-voice-panel">
			{live.session.test && (
				<p>
					音声の試用です。通常の会話履歴・記憶には追加せず、テスト字幕は終了時に削除します。
				</p>
			)}
			{live.session.segments
				.filter((s) => s.messageId === null && s.text)
				.map((segment) => (
					<div
						key={segment.id}
						className={`live-transcript live-transcript-${segment.speaker}`}
					>
						<small>
							{segment.speaker === "user" ? "あなた" : "Eumenes"} · 文字起こし
						</small>
						<p style={{ whiteSpace: "pre-wrap" }}>{segment.text}</p>
					</div>
				))}
			{live.active &&
				live.session.notices
					.filter((n) => n.text)
					.map((notice) => (
						<Notice
							key={notice.id}
							notice={notice}
							onDisplayed={live.displayed}
						/>
					))}
		</section>
	);
}
