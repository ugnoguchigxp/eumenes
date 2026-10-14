import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SpatialSettingsSection } from "./spatial";
import { settingsFixture } from "./fixture";
import { spatialPreferences } from "../../../components/SpatialPreferences";
vi.mock("../../background", () => ({
	SpatialBackground: () => <div>Spatial見本</div>,
}));
afterEach(cleanup);

test("settings groups edit independent preferences and permit zero/5% orbital speed", () => {
	let saved = settingsFixture();
	function Harness() {
		const [value, setValue] = useState(saved);
		return (
			<SpatialSettingsSection
				value={value}
				change={(edit) => {
					const next = structuredClone(value);
					edit(next);
					saved = next;
					setValue(next);
				}}
			/>
		);
	}
	render(<Harness />);
	expect(
		screen.getByLabelText("元の形を残す割合（%）", { exact: false }),
	).toHaveProperty("value", "40");
	expect(
		screen.getByLabelText("フォーカス時に形を残す割合（%）", { exact: false }),
	).toHaveProperty("value", "60");
	fireEvent.click(screen.getByRole("button", { name: "動き" }));
	fireEvent.change(screen.getByLabelText("公転速度（%）", { exact: false }), {
		target: { value: "0" },
	});
	expect(saved.general.spatialOrbitSpeed).toBe(0);
	fireEvent.change(screen.getByLabelText("公転速度（%）", { exact: false }), {
		target: { value: "5" },
	});
	expect(spatialPreferences(saved.general).orbitSpeed).toBe(5);
	fireEvent.click(screen.getByRole("button", { name: "状態プレビュー" }));
	fireEvent.change(
		screen.getByLabelText("プレビューの利用率（%）", { exact: false }),
		{
			target: { value: "100" },
		},
	);
	fireEvent.change(screen.getByLabelText("プレビューのhealth"), {
		target: { value: "pressure" },
	});
	expect(saved.general.spatialDemoUtilization).toBe(100);
	expect(saved.general.spatialDemoHealth).toBe("pressure");
	expect(spatialPreferences(saved.general).demoEnabled).toBe(false);
});
