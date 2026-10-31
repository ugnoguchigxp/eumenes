import { expect, test } from "bun:test";
import { settingsSchema } from "../contracts";
import { defaults } from "../service";

test("legacy documents remain valid and the presentation fields are accepted", () => {
	const old = defaults({});
	expect(settingsSchema.parse(old).general.spatialOrbitSpeed).toBeUndefined();
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
	expect(
		settingsSchema.safeParse({
			...old,
			general: { ...old.general, spatialDemoUtilization: 101 },
		}).success,
	).toBe(false);
});
