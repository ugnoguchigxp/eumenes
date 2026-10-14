import { useEffect, useRef, useState } from "react";

/** Browser media is local UI state; the captured File is handed to the host. */
export function useCameraCapture(onCapture: (file: File) => Promise<void>) {
	const preview = useRef<HTMLVideoElement>(null);
	const stream = useRef<MediaStream | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const generation = useRef(0);
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [opened, setOpened] = useState(false);
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

	async function open() {
		stop();
		const token = generation.current;
		setError("");
		try {
			if (!navigator.mediaDevices?.getUserMedia)
				throw new Error("camera_unavailable");
			const next = await navigator.mediaDevices.getUserMedia({
				video: true,
				audio: false,
			});
			if (token !== generation.current) {
				next.getTracks().forEach((track) => track.stop());
				return;
			}
			stream.current = next;
			if (preview.current) {
				preview.current.srcObject = next;
				await preview.current.play();
			}
			setOpened(true);
		} catch {
			stop();
			setOpened(false);
			setError("カメラを開けませんでした。ブラウザのカメラ許可を確認してください。");
		}
	}

	async function photo() {
		const video = preview.current;
		if (!video?.videoWidth) return;
		const token = generation.current;
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext("2d")?.drawImage(video, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.9),
		);
		if (!blob || token !== generation.current) return;
		stop();
		setOpened(false);
		try {
			await onCapture(new File([blob], "camera.jpg", { type: "image/jpeg" }));
		} catch {
			setError("画像を保存できませんでした。");
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
				void onCapture(
					new File([blob], mime.startsWith("video/mp4") ? "camera.mp4" : "camera.webm", {
						type: blob.type,
					}),
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
		recording,
		error,
		open,
		photo,
		record,
		finishRecording: () => recorder.current?.stop(),
		close,
	};
}
