import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MusicWorkspace } from "@eumenes/design-system";

// Silent PCM fixture: real media playback without a server or generation service.
const wav = new ArrayBuffer(44 + 16000 * 2 * 2);
const header = new DataView(wav);
for (const [offset, text] of [
	[0, "RIFF"],
	[8, "WAVE"],
	[12, "fmt "],
	[36, "data"],
] as const)
	for (let i = 0; i < text.length; i++)
		header.setUint8(offset + i, text.charCodeAt(i));
for (const [offset, value] of [
	[4, wav.byteLength - 8],
	[16, 16],
	[24, 16000],
	[28, 32000],
	[40, wav.byteLength - 44],
])
	header.setUint32(offset!, value!, true);
for (const [offset, value] of [
	[20, 1],
	[22, 1],
	[32, 2],
	[34, 16],
])
	header.setUint16(offset!, value!, true);
const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
const tracks = [
	{ id: "a", title: "曲A" },
	{ id: "b", title: "曲B" },
];

function Fixture() {
	const [id, setId] = useState("a");
	const [loading, setLoading] = useState(false);
	const creation = document.body.dataset.creation === "true";
	const current = tracks.find((track) => track.id === id)!;
	return (
		<MusicWorkspace
			tracks={tracks}
			currentTrackId={id}
			track={loading ? null : { ...current, src: url }}
			creation={creation ? { onGenerate: () => {} } : undefined}
			onSelect={(next) => {
				setId(next);
				setLoading(true);
				setTimeout(() => setLoading(false), 50);
			}}
		/>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
