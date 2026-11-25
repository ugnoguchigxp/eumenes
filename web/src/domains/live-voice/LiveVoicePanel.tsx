import { useEffect } from "react";
import "./live-voice.css";
import type { LiveNotice } from "../../../../api/domains/live-voice/contracts";
import type { useLiveVoice } from "./useLiveVoice";

function Notice({
	notice,
	onDisplayed,
}: {
	notice: LiveNotice;
	onDisplayed: (id: string) => Promise<void>;
}) {
	useEffect(() => {
		if (!notice.displayed) void onDisplayed(notice.id).catch(() => {});
	}, [notice.id, notice.displayed, onDisplayed]);
	return (
		<div className="conversation-notice">
			<span>案内: {notice.text}</span>
		</div>
	);
}
export function LiveVoicePanel({
	live,
	agentName,
}: {
	live: ReturnType<typeof useLiveVoice>;
	agentName?: string;
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
							{segment.speaker === "user" ? "あなた" : agentName || "Eumenes"} ·
							文字起こし
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
