import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "eumenes-memory/package.json";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path));
const manifest = JSON.parse(
	read("vendor/eumenes-memory/manifest.json").toString(),
);

test("the vendored memory package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/eumenes-memory/${manifest.artifact}`);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		manifest.sha256,
	);
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		"eumenes-memory"
	];
	expect(dependency).toBe(`file:vendor/eumenes-memory/${manifest.artifact}`);
	expect(pkg.version).toBe(manifest.version);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`eumenes-memory@vendor/eumenes-memory/${manifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});
