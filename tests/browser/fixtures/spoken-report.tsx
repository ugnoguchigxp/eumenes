import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "../../../client";
import { useReplay } from "../../../web/src/domains/voice-dialogue/hooks/replay";

const client = createClient(window.location.origin);
function SpokenReport() {
	const [outputVolume, setVolume] = useState(1);
	const player = useReplay(client, { outputVolume });
	return (
		<main>
			<button onClick={() => void player.play("report", "一。二。")}>
				報告を再生
			</button>
			<button onClick={() => player.stop()}>停止</button>
			<button onClick={() => setVolume(0)}>音量0</button>
			<output>{player.playingId ? "再生中" : "待機"}</output>
			{player.error && <p role="alert">{player.error}</p>}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<SpokenReport />);
