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
