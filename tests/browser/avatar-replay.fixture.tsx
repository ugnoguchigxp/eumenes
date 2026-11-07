import { useState } from "react";
import { createRoot } from "react-dom/client";
import { voiceDialogueClient } from "../../client/voice-dialogue";
import { createTransport } from "../../client/transport";
import { useReplay } from "../../web/src/domains/voice-dialogue/hooks/replay";
import { HiyoriAvatarBackground } from "../../web/src/components/domains/conversation/HiyoriAvatarBackground";
import type { Model } from "../../vendor/live2d/framework.js";
import { loadCubismCore } from "../../web/src/domains/avatar/live2d/load";

declare global {
	interface Window {
		avatarReplayStats: () => Record<string, number> | null;
		avatarReplayMatrix: () => number[];
	}
}
const client = voiceDialogueClient(createTransport(location.origin));
function Shell() {
	const replay = useReplay(client);
	const [phase, setPhase] = useState<"thinking" | "neutral">("thinking");
	return (
		<main>
			<button
				onClick={() =>
					void replay.play("fixture-message", "確認用の発話です。")
				}
			>
				読み上げる
			</button>
			<button onClick={replay.stop}>読み上げを止める</button>
			<button onClick={() => setPhase("neutral")}>待機する</button>
			<output aria-label="発話の状態">
				{replay.avatarCue?.motion ?? "idle"}
			</output>
			<div style={{ position: "relative", isolation: "isolate", height: 600 }}>
				<HiyoriAvatarBackground active cue={replay.avatarCue} phase={phase} />
			</div>
		</main>
	);
}
async function mount() {
	// The Framework evaluates constants from Core, as in the product loader.
	await loadCubismCore();
	const sdk = await import("../../vendor/live2d/framework.js");
	let model: Model | undefined;
	let matrix: number[] = [];
	const setMatrix = sdk.CubismRenderer_WebGL.prototype.setMvpMatrix;
	sdk.CubismRenderer_WebGL.prototype.setMvpMatrix = function (value) {
		matrix = Array.from(
			(value as unknown as { getArray(): Float32Array }).getArray(),
		);
		return setMatrix.call(this, value);
	};
	window.avatarReplayMatrix = () => matrix;
	const draw = sdk.CubismRenderer_WebGL.prototype.drawModel;
	sdk.CubismRenderer_WebGL.prototype.drawModel = function (...args) {
		model = (this as unknown as { _model: Model })._model;
		return draw.apply(this, args);
	};
	window.avatarReplayStats = () => {
		if (!model) return null;
		return Object.fromEntries(
			[
				"ParamMouthOpenY",
				"ParamMouthForm",
				"ParamEyeLSmile",
				"ParamBrowLY",
				"ParamAngleX",
				"ParamBodyAngleX",
				"ParamBodyAngleZ",
			].map((key) => [
				key,
				model!.getParameterValueById(
					sdk.CubismFramework.getIdManager().getId(key),
				),
			]),
		);
	};

	createRoot(document.getElementById("root")!).render(<Shell />);
}
void mount();
