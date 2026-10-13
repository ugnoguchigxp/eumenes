import { useEffect, useRef, useState } from "react";
import { Button } from "../Button";
export function CameraCapture({ onCapture, disabled }: { onCapture: (file: File) => Promise<void>; disabled?: boolean }) {
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
		if (recorder.current?.state === "recording") recorder.current.stop();
		recorder.current = null;
		stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
		if (preview.current) preview.current.srcObject = null;
	}
	useEffect(() => {
		const hide = () => { if (document.hidden) { stop(); setOpened(false); setRecording(false); } };
		document.addEventListener("visibilitychange", hide);
		return () => { stop(); document.removeEventListener("visibilitychange", hide); };
	}, []);
	async function open() {
		stop(); const token = generation.current; setError("");
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
			const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
			if (token !== generation.current) { s.getTracks().forEach(t => t.stop()); return; }
			stream.current = s; setOpened(true);
			if (preview.current) { preview.current.srcObject = s; await preview.current.play(); }
		} catch { stop(); setOpened(false); setError("カメラを開けませんでした。ブラウザのカメラ許可を確認してください。"); }
	}
	async function photo() {
		const video = preview.current; if (!video?.videoWidth) return;
		const token = generation.current;
		const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
		canvas.getContext("2d")?.drawImage(video, 0, 0);
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
		if (blob && token === generation.current) { stop(); setOpened(false); await onCapture(new File([blob], "camera.jpg", { type: "image/jpeg" })); }
	}
	function record() {
		if (!stream.current) return;
		setError("");
		try {
			const mime = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
			if (!mime) throw new Error("recording_unavailable");
			const r = new MediaRecorder(stream.current, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
			const token = generation.current; const chunks: Blob[] = []; let bytes = 0; let oversized = false;
			r.ondataavailable = e => {
				bytes += e.data.size;
				if (bytes > 16 * 1024 * 1024) { oversized = true; stop(); setOpened(false); setRecording(false); setError("動画が16 MiBを超えました。短く撮影してください。"); }
				else chunks.push(e.data);
			};
			r.onstop = () => {
				if (token !== generation.current || oversized) return;
				const blob = new Blob(chunks, { type: mime.split(";")[0] });
				stop(); setOpened(false); setRecording(false);
				void onCapture(new File([blob], mime.startsWith("video/mp4") ? "camera.mp4" : "camera.webm", { type: blob.type })).catch(() => setError("動画を保存できませんでした。"));
			};
			recorder.current = r; r.start(250); setRecording(true);
			timeout.current = setTimeout(() => { if (r.state === "recording") r.stop(); }, 29000);
		} catch { setError("このブラウザでは動画を撮影できません。静止画または動画ファイルを選んでください。"); }
	}
	return <div className="recognition-camera">
		<Button variant="secondary" onClick={() => void open()} disabled={disabled || opened}>カメラを開く</Button>
		<video ref={preview} autoPlay muted playsInline hidden={!opened} aria-label="カメラプレビュー" />
		{opened && <div className="recognition-actions">
			<Button disabled={disabled || recording} onClick={() => void photo().catch(() => setError("画像を保存できませんでした。"))}>撮影して調べる</Button>
			<Button disabled={disabled} variant="secondary" onClick={() => recording ? recorder.current?.stop() : record()}>{recording ? "録画を終了して調べる" : "動画を撮影（最大30秒）"}</Button>
			<Button variant="secondary" onClick={() => { stop(); setOpened(false); setRecording(false); }}>カメラを閉じる</Button>
		</div>}
		{error && <p role="alert">{error}</p>}
	</div>;
}
