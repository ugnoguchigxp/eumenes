import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HiyoriAvatarBackground } from "../../web/src/components/domains/conversation/HiyoriAvatarBackground";
function Shell() {
	const [selected, select] = useState(true);
	const [count, setCount] = useState(0);
	return (
		<main>
			<button onClick={() => select((v) => !v)}>背景を切り替える</button>
			<button onClick={() => setCount((v) => v + 1)}>会話を続ける</button>
			<output aria-label="会話の操作回数">{count}</output>
			<input aria-label="メッセージ" />
			<div style={{ position: "relative", isolation: "isolate", height: 500 }}>
				{selected ? <HiyoriAvatarBackground active /> : <div>ほかの背景</div>}
			</div>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Shell />);
