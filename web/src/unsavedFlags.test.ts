import { expect, test } from "vitest";
import { createUnsavedFlags } from "./unsavedFlags";

test("each owner keeps its own flag: a settings save never clears unsent route edits", () => {
	const f = createUnsavedFlags();
	f.set("routes", true);
	f.set("settings", true);
	f.set("settings", false); // settings saved
	expect(f.any()).toBe(true);
	f.set("routes", false);
	expect(f.any()).toBe(false);
	f.set("settings", true);
	f.set("routes", false); // route panel unmounted
	expect(f.any()).toBe(true);
	f.reset();
	expect(f.any()).toBe(false);
});
