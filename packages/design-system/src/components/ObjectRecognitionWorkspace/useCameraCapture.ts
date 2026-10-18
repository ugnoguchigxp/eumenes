import { useEffect, useRef, useState } from "react";

export type CaptureOrigin = "camera" | "screen";
/** A screen still is scaled down to this long edge so it fits the chat image limits. */
const screenEdge = 2560;

/** Browser media is local UI state; the captured File is handed to the host. */
export function useCameraCapture(
	onCapture: (file: File, origin: CaptureOrigin) => Promise<void>,
) {
	const preview = useRef<HTMLVideoElement>(null);
	const stream = useRef<MediaStream | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const generation = useRef(0);
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [opened, setOpened] = useState(false);
	const [origin, setOrigin] = useState<CaptureOrigin>("camera");
	const originRef = useRef<CaptureOrigin>("camera");
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState("");

	function stop() {
		generation.current++;
		if (timeout.current) clearTimeout(timeout.current);
		timeout.current = null;
		if (recorder.current?.state === "recording") recorder.current.stop();
		recorder.current = null;
		stream.current?.getTracks().forEach((track) => track.stop());
		stream.current = null;
		if (preview.current) preview.current.srcObject = null;
	}

	useEffect(() => {
		const hide = () => {
			if (document.hidden) {
				stop();
				setOpened(false);
				setRecording(false);
			}
		};
		document.addEventListener("visibilitychange", hide);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", hide);
		};
	}, []);

	/** Opens the camera, or the browser's screen picker (which needs a click). True once showing. */
	async function open(kind: CaptureOrigin = "camera") {
		stop();
		const token = generation.current;
		setError("");
		originRef.current = kind;
		setOrigin(kind);
		try {
			const media = navigator.mediaDevices;
			if (kind === "screen" ? !media?.getDisplayMedia : !media?.getUserMedia)
				throw new Error("capture_unavailable");
			const next =
				kind === "screen"
					? await media.getDisplayMedia({ video: true, audio: false })
					: await media.getUserMedia({ video: true, audio: false });
			if (token !== generation.current) {
				next.getTracks().forEach((track) => track.stop());
				return;
			}
			stream.current = next;
			// Ending the share from the browser's own bar closes the capture too.
			next.getVideoTracks()[0]?.addEventListener("ended", () => {
				if (stream.current === next) close();
			});
			if (preview.current) {
				preview.current.srcObject = next;
				await preview.current.play();
			}
			setOpened(true);
			return true;
		} catch {
			// A later open() owns the stream now; this failure must not stop it.
			if (token !== generation.current) return false;
			stop();
			setOpened(false);
			setError(
				kind === "screen"
					? "画面を共有できませんでした。共有する画面を選び、ブラウザの画面収録の許可を確認してください。"
					: "カメラを開けませんでした。ブラウザのカメラ許可を確認してください。",
			);
			return false;
		}
	}

	async function photo() {
		const video = preview.current;
		if (!video?.videoWidth) return false;
		const token = generation.current;
		const kind = originRef.current;
		const scale =
			kind === "screen"
				? Math.min(
						1,
						screenEdge / Math.max(video.videoWidth, video.videoHeight),
					)
				: 1;
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		canvas
			.getContext("2d")
			?.drawImage(video, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.9),
		);
		if (!blob || token !== generation.current) return false;
		stop();
		setOpened(false);
		try {
			await onCapture(
				new File([blob], `${kind}.jpg`, { type: "image/jpeg" }),
				kind,
			);
			return true;
		} catch {
			setError("画像を保存できませんでした。");
			return false;
		}
	}

	function record() {
		if (!stream.current) return;
		setError("");
		try {
			const mime = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find(
				(type) => MediaRecorder.isTypeSupported(type),
			);
			if (!mime) throw new Error("recording_unavailable");
			const next = new MediaRecorder(stream.current, {
				mimeType: mime,
				videoBitsPerSecond: 2_000_000,
			});
			const token = generation.current;
			const chunks: Blob[] = [];
			let bytes = 0;
			let oversized = false;
			next.ondataavailable = (event) => {
				bytes += event.data.size;
				if (bytes > 16 * 1024 * 1024) {
					oversized = true;
					stop();
					setOpened(false);
					setRecording(false);
					setError("動画が16 MiBを超えました。短く撮影してください。");
				} else chunks.push(event.data);
			};
			next.onstop = () => {
				if (token !== generation.current || oversized) return;
				const blob = new Blob(chunks, { type: mime.split(";")[0] });
				stop();
				setOpened(false);
				setRecording(false);
				const kind = originRef.current;
				void onCapture(
					new File(
						[blob],
						mime.startsWith("video/mp4") ? `${kind}.mp4` : `${kind}.webm`,
						{
							type: blob.type,
						},
					),
					kind,
				).catch(() => setError("動画を保存できませんでした。"));
			};
			recorder.current = next;
			next.start(250);
			setRecording(true);
			timeout.current = setTimeout(() => {
				if (next.state === "recording") next.stop();
			}, 29000);
		} catch {
			setError(
				"このブラウザでは動画を撮影できません。静止画または動画ファイルを選んでください。",
			);
		}
	}

	function close() {
		stop();
		setOpened(false);
		setRecording(false);
	}

	return {
		preview,
		opened,
		origin,
		recording,
		error,
		open,
		photo,
		record,
		finishRecording: () => recorder.current?.stop(),
		close,
	};
}
