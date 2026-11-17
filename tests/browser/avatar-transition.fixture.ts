import type { Id, Model } from "../../vendor/live2d/framework.js";
import type { AvatarCue } from "../../web/src/domains/avatar";
import { loadCubismCore } from "../../web/src/domains/avatar/live2d/load";
import { createHiyori } from "../../web/src/domains/avatar/live2d/model";

const poseParameters = [
	"ParamAngleX",
	"ParamAngleY",
	"ParamAngleZ",
	"ParamBodyAngleX",
	"ParamBodyAngleY",
	"ParamBodyAngleZ",
	"ParamEyeBallX",
	"ParamEyeBallY",
];

declare global {
	interface Window {
		hiyoriTransitionTest: Awaited<ReturnType<typeof setup>>;
	}
}

async function setup() {
	await loadCubismCore();
	const sdk = await import("../../vendor/live2d/framework.js");
	let loaded = 0;
	const createMotion = sdk.CubismMotion.create;
	sdk.CubismMotion.create = (...args) => {
		const motion = createMotion(...args);
		if (motion) loaded++;
		return motion;
	};
	type DrawnModel = Model & { getPartOpacityById(id: Id): number };
	let drawn!: DrawnModel;
	const draw = sdk.CubismRenderer_WebGL.prototype.drawModel;
	sdk.CubismRenderer_WebGL.prototype.drawModel = function (...args) {
		drawn = (this as unknown as { _model: DrawnModel })._model;
		return draw.apply(this, args);
	};
	const avatar = await createHiyori(
		document.getElementById("avatar")!,
		new AbortController().signal,
	);
	const id = (name: string) => sdk.CubismFramework.getIdManager().getId(name);
	const read = (name: string) => drawn.getParameterValueById(id(name));
	return {
		loaded: () => loaded,
		render(time: number, cue: AvatarCue | null, mouth = 0) {
			avatar.render(
				time,
				cue?.motion ?? "neutral",
				mouth,
				undefined,
				undefined,
				cue,
			);
			return {
				pose: poseParameters.map(read),
				arms: ["PartArmA", "PartArmB"].map((name) =>
					drawn.getPartOpacityById(id(name)),
				),
				eye: read("ParamEyeLOpen"),
				smile: read("ParamEyeLSmile"),
				mouth: read("ParamMouthOpenY"),
			};
		},
	};
}

void setup().then((test) => {
	window.hiyoriTransitionTest = test;
});
