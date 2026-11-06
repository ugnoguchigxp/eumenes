import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	bindSourceRequest,
	CONTRACT_VERSION,
	createCatalogView,
	checkDefinition,
	isRunnable,
	parseJsonStrict,
} from "eumenes-pipeline";
const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p));
test("pipeline archive, manifest, lock and installed runtime agree", () => {
	const manifest = JSON.parse(read("vendor/pipeline/manifest.json").toString());
	const artifact = read(`vendor/pipeline/${manifest.artifact}`);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		manifest.sha256,
	);
	expect(artifact.length).toBe(manifest.sizeBytes);
	expect(
		read(`vendor/pipeline/${manifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(manifest.sha256);
	expect(
		JSON.parse(read("package.json").toString()).dependencies[manifest.package],
	).toBe(`file:vendor/pipeline/${manifest.artifact}`);
	const lock = read("bun.lock").toString();
	expect(lock).toContain(
		`eumenes-pipeline@vendor/pipeline/${manifest.artifact}`,
	);
	expect(lock).toContain(
		`sha512-${createHash("sha512").update(artifact).digest("base64")}`,
	);
	expect(CONTRACT_VERSION).toBe("p0-3");
	const catalog = createCatalogView([], {
		version: CONTRACT_VERSION,
		offer: () => true,
	});
	expect(
		checkDefinition({ formatVersion: 1, inputs: [], steps: [] }, catalog).ok,
	).toBe(false);
	// 0.1.0 host hardening is present in the installed runtime.
	expect(manifest.version).toBe("0.1.0");
	expect(parseJsonStrict('{"a":1,"a":2}').ok).toBe(false);
	expect(typeof bindSourceRequest).toBe("function");
	expect(typeof isRunnable).toBe("function");
});
