import { Button } from "../design-system";
import type { WorkspaceState } from "./useWorkspace";

export function LiveComposerControls({ state }: { state: WorkspaceState }) {
	const live = state.live;
	if (!live) return null;
	const label = live.active ? "音声会話を終了" : "音声会話を開始";
	return (
		<fieldset className="composer-live-controls" aria-label="Live音声会話">
			<Button
				type="button"
				size="sm"
				variant={live.active ? "destructive" : "ghost"}
				disabled={live.busy}
				aria-label={label}
				title={label}
				onClick={() =>
					void (live.active
						? live.stop()
						: state.settings.data?.live.enabled &&
							  state.settings.data.live.model
							? live.start()
							: state.openLiveSettings())
				}
			>
				{live.active ? <LiveIcon kind="stop" /> : <LiveIcon kind="wave" />}
				<span>Live</span>
			</Button>
			{live.active && (
				<Button
					type="button"
					size="icon"
					className="composer-live-icon"
					variant="ghost"
					onClick={() => void live.mute()}
					aria-label={
						live.session?.muted
							? "音声会話のマイクを再開"
							: "音声会話のマイクを休止"
					}
				>
					{live.session?.muted ? (
						<LiveIcon kind="play" />
					) : (
						<LiveIcon kind="pause" />
					)}
				</Button>
			)}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="composer-live-icon"
				onClick={state.openLiveSettings}
				aria-label="音声会話の設定"
				title="音声会話の設定"
			>
				<LiveIcon kind="settings" />
			</Button>
		</fieldset>
	);
}

function LiveIcon({
	kind,
}: {
	kind: "stop" | "wave" | "play" | "pause" | "settings";
}) {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{kind === "stop" ? (
				<rect x="6" y="6" width="12" height="12" rx="2" />
			) : kind === "wave" ? (
				<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />
			) : kind === "play" ? (
				<path d="m8 5 11 7-11 7z" />
			) : kind === "pause" ? (
				<path d="M8 5v14M16 5v14" />
			) : (
				<>
					<path d="M4 7h4m6 0h6M4 17h10m6 0h0" />
					<circle cx="11" cy="7" r="3" />
					<circle cx="17" cy="17" r="3" />
				</>
			)}
		</svg>
	);
}
