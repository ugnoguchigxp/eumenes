import { expect, test } from "bun:test";
import bundle from "../bundles/settings-google.bundle.json";

test("Google settings bundle exposes no AI definitions or bindings", () => {
	expect(bundle.definitions).toHaveLength(0);
	expect(bundle.bindings).toHaveLength(0);
});
