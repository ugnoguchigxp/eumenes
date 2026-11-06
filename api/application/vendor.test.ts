import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import agencyPkg from "eumenes-agency/package.json";
import { HOST_RULES_VERSION, INSTRUCTION_VERSION } from "eumenes-agency";
import pkg from "eumenes-memory/package.json";
import worldPkg from "eumenes-world-model/package.json";
import worldDistribution from "eumenes-world-model/distribution-manifest.json";
import routerPkg from "eumenes_router/package.json";
import { contractVersions, TURN_STRUCTURE_PROMPT } from "eumenes_router";
import { migrations as routerSql } from "eumenes_router/sqlite";

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

test("the memory distribution identifies its source and verifies the installed published files", () => {
	const packageUrl = import.meta.resolve("eumenes-memory/package.json");
	const release = JSON.parse(
		readFileSync(new URL("./dist/release-manifest.json", packageUrl), "utf8"),
	);
	expect(release.baseCommit).toBe(manifest.sourceGitCommit);
	expect(release.sourceHash).toBe(manifest.sourceHash);
	expect(release.packageVersion).toBe(pkg.version);
	for (const [path, expected] of Object.entries(release.files)) {
		if (typeof expected !== "string")
			throw new Error("Invalid release checksum");
		const bytes = readFileSync(new URL(path, packageUrl));
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
	}
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
	expect(HOST_RULES_VERSION).toBe(agencyManifest.HOST_RULES_VERSION);
	expect(INSTRUCTION_VERSION).toBe(agencyManifest.INSTRUCTION_VERSION);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${agencyManifest.package}@vendor/agency/${agencyManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});

const routerManifest = JSON.parse(
	read("vendor/router/manifest.json").toString(),
);

test("the vendored router package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/router/${routerManifest.artifact}`);
	expect(routerManifest.package).toBe("eumenes_router");
	expect(routerManifest.source.dirty).toBe(true);
	expect(routerManifest.source.patch.file).toBe("adoption-source.patch");
	expect(
		createHash("sha256")
			.update(read(`vendor/router/${routerManifest.source.patch.file}`))
			.digest("hex"),
	).toBe(routerManifest.source.patch.sha256);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		routerManifest.sha256,
	);
	expect(
		read(`vendor/router/${routerManifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(routerManifest.sha256);
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		routerManifest.package
	];
	expect(dependency).toBe(`file:vendor/router/${routerManifest.artifact}`);
	expect(routerPkg.version).toBe(routerManifest.version);
	expect(contractVersions).toEqual(routerManifest.contractVersions);
	expect(routerSql.length).toBe(routerManifest.dbSchemaVersion);
	expect(TURN_STRUCTURE_PROMPT.version).toBe(
		routerManifest.entries.routeStructured.structurePrompt,
	);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${routerManifest.package}@vendor/router/${routerManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});
