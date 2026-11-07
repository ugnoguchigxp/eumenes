import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationBackground } from "../../web/src/components/ConversationBackground";
import { loadCubismCore } from "../../web/src/domains/avatar/live2d/load";
import "../../web/src/app.css";

declare global {
	interface Window {
		avatarViewMatrix: () => number[];
	}
}

function Shell() {
	const [hidden, setHidden] = useState(false);
	const [selected, setSelected] = useState(true);
	return (
		<main style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			<button type="button" onClick={() => setHidden((v) => !v)}>
				{hidden ? "チャットを表示" : "チャットを隠す"}
			</button>
			<button type="button" onClick={() => setSelected((v) => !v)}>
				背景を切り替える
			</button>
			<section
				className="chat-panel"
				data-chat-hidden={hidden || undefined}
				style={{ flex: 1 }}
			>
				{selected ? (
					<ConversationBackground
						kind="live2d-hiyori"
						active
						interactive={hidden}
					/>
				) : (
					<div>ほかの背景</div>
				)}
				<div className="chat-history">会話の履歴</div>
				<input aria-label="メッセージ" />
			</section>
		</main>
	);
}

async function mount() {
	await loadCubismCore();
	const sdk = await import("../../vendor/live2d/framework.js");
	let matrix: number[] = [];
	const set = sdk.CubismRenderer_WebGL.prototype.setMvpMatrix;
	sdk.CubismRenderer_WebGL.prototype.setMvpMatrix = function (value) {
		matrix = Array.from(
			(value as unknown as { getArray(): Float32Array }).getArray(),
		);
		return set.call(this, value);
	};
	window.avatarViewMatrix = () => matrix;
	createRoot(document.getElementById("root")!).render(<Shell />);
}
void mount();
