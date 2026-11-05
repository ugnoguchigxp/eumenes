import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPursuitEngine } from "eumenes-pursuit";
import {
	migrations,
	forgetPursuit,
	findPursuitByOperation,
} from "eumenes-pursuit/sqlite";
const root = join(import.meta.dir, "../../..");
test("Pursuit package, manifest, lock and public lifecycle contracts agree", () => {
	const manifest = JSON.parse(
		readFileSync(join(root, "vendor/pursuit/manifest.json"), "utf8"),
	);
	const archive = readFileSync(
		join(root, `vendor/pursuit/${manifest.artifact}`),
	);
	expect(createHash("sha256").update(archive).digest("hex")).toBe(
		manifest.sha256,
	);
	expect(
		JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies[
			manifest.package
		],
	).toBe(`file:vendor/pursuit/${manifest.artifact}`);
	expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain(
		`eumenes-pursuit@vendor/pursuit/${manifest.artifact}`,
	);
	expect(migrations).toHaveLength(manifest.dbSchemaVersion);
	for (const m of migrations)
		expect(createHash("sha256").update(m.sql).digest("hex")).toBe(m.sha256);
	expect(typeof createPursuitEngine).toBe("function");
	expect(typeof forgetPursuit).toBe("function");
	expect(typeof findPursuitByOperation).toBe("function");
});
