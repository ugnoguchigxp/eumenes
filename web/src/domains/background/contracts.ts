import type { Object3D } from "three";

/** Measurements and health are supplied by their owner, never inferred by a model. */
export type SpatialState = {
	health: "healthy" | "pressure" | "fault" | "disconnected" | "unknown";
	activity: "idle" | "starting" | "working";
	stale: boolean;
};
export type SpatialItem = {
	id: string;
	label: string;
	model: string;
	position: readonly [number, number, number];
	state: SpatialState;
};
export type SpatialModel = {
	/** Local origin, approximately one unit wide; the scene owns placement. */
	object: Object3D;
	update(state: SpatialState, selected: boolean): void;
	/** Optional motion. Called only for active items while motion is enabled. */
	animate?(seconds: number, deltaSeconds: number): void;
	/** Owns all geometry, materials and textures created by this model. */
	dispose(): void;
};
export type SpatialModelFactory = () => SpatialModel;
export type SpatialModels = Readonly<Record<string, SpatialModelFactory>>;
export type SceneStatus = "ready" | "paused" | "failed";

export const healthLabels: Record<SpatialState["health"], string> = {
	healthy: "正常",
	pressure: "圧迫・応答悪化",
	fault: "問題あり",
	disconnected: "接続断",
	unknown: "未確認",
};
