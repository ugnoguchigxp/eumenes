import { Button } from "../Button";
import { useCameraCapture } from "./useCameraCapture";

/** Standalone camera control; the workspace places the same hook in its split layout. */
export function CameraCapture({
	onCapture,
	disabled,
}: {
	onCapture: (file: File) => Promise<void>;
	disabled?: boolean;
}) {
	const { preview, ...camera } = useCameraCapture(onCapture);
	return (
		<div className="recognition-camera">
			<Button
				variant="secondary"
				onClick={() => void camera.open()}
				disabled={disabled || camera.opened}
			>
				カメラを開く
			</Button>
			<video
				ref={preview}
				autoPlay
				muted
				playsInline
				hidden={!camera.opened}
				aria-label="カメラプレビュー"
			/>
			{camera.opened && (
				<div className="recognition-actions">
					<Button
						disabled={disabled || camera.recording}
						onClick={() => void camera.photo()}
					>
						撮影して調べる
					</Button>
					<Button
						disabled={disabled}
						variant="secondary"
						onClick={() =>
							camera.recording ? camera.finishRecording() : camera.record()
						}
					>
						{camera.recording
							? "録画を終了して調べる"
							: "動画を撮影（最大30秒）"}
					</Button>
					<Button variant="secondary" onClick={camera.close}>
						カメラを閉じる
					</Button>
				</div>
			)}
			{camera.error && <p role="alert">{camera.error}</p>}
		</div>
	);
}
