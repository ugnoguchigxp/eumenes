import type { Object3D } from "three";
import type { SpatialOptions } from "./options";

/** Measurements and health are supplied by their owner, never inferred by a model. */
export type SpatialState = {
	health: "healthy" | "pressure" | "fault" | "disconnected" | "unknown";
	activity: "idle" | "starting" | "working";
	stale: boolean;
	/** Optional observations: absence means unavailable, not zero. */
	utilization?: number;
	strength?: number;
	source?: "unconfirmed" | "demo" | "measurement";
	observedAt?: number;
};
export type SpatialItem = {
	id: string;
	label: string;
	model: string;
	position: readonly [number, number, number];
	state: SpatialState;
	/** Layout motion around the invisible origin, independent from activity. */
	orbit?: { radius: number; phase: number; speed?: number };
};
export type SpatialModel = {
	/** Local origin, approximately one unit wide; the scene owns placement. */
	object: Object3D;
	update(state: SpatialState, selected: boolean): void;
	configure?(
		options: SpatialOptions,
		corePercent: number,
		motionEnabled: boolean,
		visibility?: number,
	): void;
	/** Rotation-invariant extent including local scale and shader displacement. */
	bounds?(
		scatterPercent: number,
		corePercent: number,
	): { radius: number; depth: number };
	/** Self-spin and activity motion; the scene independently owns orbital placement. */
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
