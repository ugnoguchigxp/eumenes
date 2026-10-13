import { useRef, useState } from "react";
import type { RecognitionItem } from "./types";
import { Button } from "../Button";
export function DetectionPreview({ item, url, onIncorporate }: { item: RecognitionItem; url: string; onIncorporate?: (frameIndex?: number) => void }) {
	const video = useRef<HTMLVideoElement>(null);
	const [index, setIndex] = useState(0);
	const [atFrame, setAtFrame] = useState(true);
	const result = item.result;
	if (!result) return null;
	const width = result.kind === "image" ? result.width : result.video.width;
	const height = result.kind === "image" ? result.height : result.video.height;
	const frame = result.kind === "video" ? result.frames[index] : undefined;
	const objects = result.kind === "image" ? result.objects : frame?.objects ?? [];
	function seek(i: number) { setIndex(i); setAtFrame(true); if (video.current && result?.kind === "video") { video.current.pause(); video.current.currentTime = result.frames[i]!.timestampSeconds; } }
	return <>
		<div className="recognition-results">
			<div className="recognition-media" style={{ aspectRatio: `${width}/${height}` }}>
				{result.kind === "image" ? <img src={url} alt={item.name} /> : <video ref={video} src={url} controls controlsList="nofullscreen noremoteplayback" disablePictureInPicture playsInline aria-label="解析した動画" onLoadedMetadata={() => seek(index)} onTimeUpdate={() => { const time = video.current?.currentTime ?? 0; const i = result.frames.findIndex(f => Math.abs(f.timestampSeconds - time) < 0.12); setAtFrame(i >= 0); if (i >= 0) setIndex(i); }} />}
				{atFrame && <svg className="recognition-boxes" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-label="検出枠">
					{objects.map((o, i) => <g key={i}><rect x={o.box[0]} y={o.box[1]} width={o.box[2] - o.box[0]} height={o.box[3] - o.box[1]} fill="none" stroke="var(--recognition-accent, #087f8c)" strokeWidth={Math.max(width / 350, 2)} /><text x={o.box[0] + 3} y={Math.max(o.box[1] + width / 40, width / 40)} fontSize={width / 40} fill="#fff" stroke="#065663" strokeWidth={width / 800} paintOrder="stroke">{o.label}</text></g>)}
				</svg>}
			</div>
			<section className="recognition-list" aria-label="検出された物の一覧"><h3>検出された物の一覧{frame ? `（${frame.timestampSeconds}秒）` : ""}</h3>
				{!objects.length && <p>検出対象は見つかりませんでした。</p>}
				{objects.length > 0 && <table><thead><tr><th>物体名</th><th>元画像の座標（pixel）・score</th></tr></thead><tbody>{objects.map((o, i) => <tr key={i}><td>{o.label}</td><td>[{o.box.join(", ")}]<br /><small>score {o.confidence.toFixed(3)}</small></td></tr>)}</tbody></table>}
			</section>
		</div>
		{result.kind === "video" && <div className="recognition-times" aria-label="動画の検出時刻">{result.frames.map((f, i) => <Button key={i} variant="secondary" aria-pressed={i === index} onClick={() => seek(i)}>{f.timestampSeconds.toFixed(1)}秒 · {f.objects.length}件</Button>)}</div>}
		{result.kind === "video" && !atFrame && <p>この再生時刻の検出枠はありません。時刻ボタンで観測したフレームへ移動できます。</p>}
		<Button onClick={() => onIncorporate?.(result.kind === "video" ? index : undefined)} disabled={!onIncorporate}>表示中の結果を会話に追加</Button>
	</>;
}
