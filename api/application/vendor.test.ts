import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import agencyPkg from "eumenes-agency/package.json";
import pkg from "eumenes-memory/package.json";
import worldPkg from "eumenes-world-model/package.json";
import worldDistribution from "eumenes-world-model/distribution-manifest.json";

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

const worldManifest = JSON.parse(read("vendor/world/manifest.json").toString());

test("the vendored world-model package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/world/${worldManifest.artifact}`);
	expect(worldManifest.package).toBe("eumenes-world-model");
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		worldManifest.sha256,
	);
	expect(
		read(`vendor/world/${worldManifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(worldManifest.sha256);
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		worldManifest.package
	];
	expect(dependency).toBe(`file:vendor/world/${worldManifest.artifact}`);
	expect(worldPkg.version).toBe(worldManifest.version);
	expect(worldDistribution.source.sourceDigest).toBe(
		worldManifest.sourceDigest,
	);
	expect(worldDistribution.source.gitCommit).toBe(
		worldManifest.sourceGitCommit,
	);
	expect(worldDistribution.source.srcDirtyFiles).toBe(
		worldManifest.srcDirtyFiles,
	);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${worldManifest.package}@vendor/world/${worldManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});

const agencyManifest = JSON.parse(
	read("vendor/agency/manifest.json").toString(),
);

test("the vendored agency package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/agency/${agencyManifest.artifact}`);
	expect(agencyManifest.package).toBe("eumenes-agency");
	expect(agencyManifest.dirty).toBe(false);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		agencyManifest.sha256,
	);
	expect(
		read(`vendor/agency/${agencyManifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(agencyManifest.sha256);
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		agencyManifest.package
	];
	expect(dependency).toBe(`file:vendor/agency/${agencyManifest.artifact}`);
	expect(agencyPkg.version).toBe(agencyManifest.version);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${agencyManifest.package}@vendor/agency/${agencyManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});
