import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SpatialDetail } from "./SpatialDetail";
import type { SpatialItem } from "./contracts";

afterEach(cleanup);
const sample: SpatialItem = {
	id: "larm-gpu",
	label: "LARM GPU",
	model: "larm-gpu",
	position: [0, 0, 0],
	state: {
		health: "healthy",
		activity: "idle",
		stale: false,
		utilization: 1,
		source: "measurement",
		observedAt: Date.now() - 47000,
		details: ["履歴確認: 20:00:00まで"],
	},
};

test("a normal minute sample shows its time once without an expiry warning", () => {
	render(<SpatialDetail item={sample} />);
	expect(screen.getAllByText("最終確認")).toHaveLength(1);
	expect(screen.getByText("100%")).toBeTruthy();
	expect(screen.queryByText("待機中")).toBeNull();
	expect(
		screen.queryByText(/有効期限|情報が古い|更新を確認できません|取得済み/),
	).toBeNull();
});

test("service records and missing utilization are distinct from physical measurements", () => {
	render(
		<SpatialDetail
			item={{
				...sample,
				model: "llm",
				state: {
					health: "unknown",
					activity: "idle",
					stale: false,
					source: "activity",
					checkedAt: Date.now(),
					details: ["直近10分の実行結果はありません"],
				},
			}}
		/>,
	);
	expect(screen.getByText("実行記録")).toBeTruthy();
	expect(screen.getByText("直近10分の実行結果はありません")).toBeTruthy();
	expect(screen.queryByText("利用率")).toBeNull();
	expect(screen.getAllByText("最終確認")).toHaveLength(1);
});

test("known preparation shows standby and actual warm runtime counts instead of an unknown headline", () => {
	render(
		<SpatialDetail
			item={{
				...sample,
				model: "larm-core",
				state: {
					health: "healthy",
					activity: "idle",
					stale: false,
					readiness: "ready",
					source: "measurement",
					observedAt: Date.now(),
					runtimeStates: [
						{ readiness: "warm_ready", count: 1 },
						{ readiness: "cold", count: 4 },
					],
				},
			}}
		/>,
	);
	expect(screen.getAllByText("待機中")).toHaveLength(1);
	expect(screen.getByText("Ready")).toBeTruthy();
	expect(screen.getByText("Warm ready")).toBeTruthy();
	expect(screen.getByText("1件")).toBeTruthy();
	expect(screen.getByText("Healthy（正常）")).toBeTruthy();
	expect(screen.queryByText("状態情報なし")).toBeNull();
});
