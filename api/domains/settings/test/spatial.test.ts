import { expect, test } from "bun:test";
import { settingsSchema, spatialControls } from "../contracts";
import { defaults } from "../service";

test("legacy documents remain valid; presentation bounds and enums reject invalid settings", () => {
	const old = defaults({});
	expect(settingsSchema.parse(old).general.spatialOrbitSpeed).toBeUndefined();
	for (const control of spatialControls) {
		const key = control.path.split(".").at(-1)!;
		const value =
			control.control === "range"
				? Number(control.defaultValue)
				: control.control === "toggle"
					? String(control.defaultValue) === "true"
					: control.defaultValue;
		const input = { ...old, general: { ...old.general, [key]: value } };
		expect(settingsSchema.safeParse(input).success).toBe(true);
		if ("min" in control) {
			for (const invalid of [control.min - 1, control.max + 1, Infinity, NaN])
				expect(
					settingsSchema.safeParse({
						...old,
						general: { ...old.general, [key]: invalid },
					}).success,
				).toBe(false);
		}
	}
	expect(
		settingsSchema.safeParse({
			...old,
			general: {
				...old.general,
				spatialOrbitSpeed: 0,
				spatialDemoUtilization: 100,
				spatialDemoHealth: "healthy",
			},
		}).success,
	).toBe(true);
});
