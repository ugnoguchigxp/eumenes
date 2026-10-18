import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: false })));
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
test("the actual Spatial registration exposes 350 to 500 and saves through shared settings", async () => {
	const bundle = JSON.parse(
			readFileSync(
				"api/domains/capabilities/bundles/settings.spatial.bundle.json",
				"utf8",
			),
		),
		display = bundle.artifacts.at(-1);
	const backend = createSettingsBackend({ artifacts: { display } });
	render(
		<Screens backend={backend} start="display" cache={newCache(backend)} />,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Spatial" }));
	fireEvent.click(await screen.findByRole("button", { name: "粒子" }));
	const scatter = await screen.findByLabelText(/粒子の拡散（%）/);
	expect(scatter).toHaveProperty("value", "350");
	expect(scatter.getAttribute("max")).toBe("500");
	fireEvent.change(scatter, { target: { value: "500" } });
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findAllByText("変更を適用しました");
	expect(backend.saved().general.spatialScatter).toBe(500);
});
