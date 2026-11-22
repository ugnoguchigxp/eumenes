import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import agencyPkg from "eumenes-agency/package.json";
import { HOST_RULES_VERSION, INSTRUCTION_VERSION } from "eumenes-agency";
import pkg from "eumenes-memory/package.json";
import worldPkg from "eumenes-world-model/package.json";
import worldDistribution from "eumenes-world-model/distribution-manifest.json";
import routerPkg from "eumenes_router/package.json";
import { contractVersions, TURN_STRUCTURE_PROMPT } from "eumenes_router";
import {
	dbSchemaVersion as routerDbSchemaVersion,
	insertFeedbackInTransaction,
	migrations as routerSql,
	searchFeedback,
	updateFeedbackStateInTransaction,
} from "eumenes_router/sqlite";

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
	expect(agencyManifest.gitSha).toMatch(/^[a-f0-9]{40}$/);
	if (agencyManifest.dirty) {
		// A candidate with uncommitted core fixes: bind that exact diff as well as the artifact.
		expect(agencyManifest.adoptionSource.baseCommit).toBe(
			agencyManifest.gitSha,
		);
		expect(
			createHash("sha256")
				.update(
					read(`vendor/agency/${agencyManifest.adoptionSource.patchFile}`),
				)
				.digest("hex"),
		).toBe(agencyManifest.adoptionSource.patchSha256);
		expect(agencyManifest.adoptionSource.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(
			Object.keys(agencyManifest.adoptionSource.sourceFiles).length,
		).toBeGreaterThan(0);
	} else {
		// Built from a committed source (0.1.6: the agenda agent at 1575c3a): the commit is the source.
		expect(agencyManifest.dirty).toBe(false);
		expect(agencyManifest.adoptionSource).toBeUndefined();
	}
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

const steerManifest = JSON.parse(read("vendor/steer/manifest.json").toString());

test("the vendored steer package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/steer/${steerManifest.artifact}`);
	expect(steerManifest.package).toBe("eumenes-steer");
	expect(steerManifest.sourceGitCommit).toMatch(/^[a-f0-9]{40}$/);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		steerManifest.sha256,
	);
	expect(steerManifest.artifact).toContain(steerManifest.sha256.slice(0, 12));
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		steerManifest.package
	];
	expect(dependency).toBe(`file:vendor/steer/${steerManifest.artifact}`);
	// Its exports name only the source entry: the installed copy is read where it lies.
	const steerPkg = JSON.parse(
		read("node_modules/eumenes-steer/package.json").toString(),
	);
	expect(steerPkg.version).toBe(steerManifest.version);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${steerManifest.package}@vendor/steer/${steerManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});

const consolidationManifest = JSON.parse(
	read("vendor/eumenes-consolidation/manifest.json").toString(),
);

test("the vendored consolidation package matches its manifest, package.json, the lockfile and the installed copy, and the folder holds only that tarball", () => {
	const dir = "vendor/eumenes-consolidation";
	const artifact = read(`${dir}/${consolidationManifest.artifact}`);
	expect(consolidationManifest.package).toBe("eumenes-consolidation");
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		consolidationManifest.sha256,
	);
	expect(artifact.length).toBe(consolidationManifest.size);
	expect(
		read(`${dir}/${consolidationManifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(consolidationManifest.sha256);
	const dependency = JSON.parse(read("package.json").toString()).dependencies[
		consolidationManifest.package
	];
	expect(dependency).toBe(`file:${dir}/${consolidationManifest.artifact}`);
	const installed = JSON.parse(
		read("node_modules/eumenes-consolidation/package.json").toString(),
	);
	expect(installed.version).toBe(consolidationManifest.version);
	// Its peer is the memory package this repository vendors.
	expect(installed.peerDependencies["eumenes-memory"]).toBe(pkg.version);
	// Every file the manifest lists is what is installed.
	for (const [path, expected] of Object.entries(
		consolidationManifest.files as Record<string, string>,
	)) {
		const inner = path.replace(/^package\//, "");
		expect(
			createHash("sha256")
				.update(read(`node_modules/eumenes-consolidation/${inner}`))
				.digest("hex"),
		).toBe(expected);
	}
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${consolidationManifest.package}@${dir}/${consolidationManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
	// No other tarball waits in the folder (the general check below covers the rest of vendor/).
	expect(
		readdirSync(join(root, dir)).filter((file) => file.endsWith(".tgz")),
	).toEqual([consolidationManifest.artifact]);
});

const routerManifest = JSON.parse(
	read("vendor/router/manifest.json").toString(),
);

test("the vendored router package matches its manifest, package.json, the lockfile and the installed copy", () => {
	const artifact = read(`vendor/router/${routerManifest.artifact}`);
	expect(routerManifest.package).toBe("eumenes_router");
	expect(routerManifest.source.dirty).toBe(false);
	expect(routerManifest.source.commit).toBe(
		"40b9fa0de2ef8e7cb7d1d3bf4a4d1cec0990a592",
	);
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
	expect(contractVersions.feedback).toBe(2);
	expect(routerDbSchemaVersion).toBe(1);
	expect(routerSql.length).toBe(routerManifest.dbSchemaVersion);
	expect(typeof insertFeedbackInTransaction).toBe("function");
	expect(typeof searchFeedback).toBe("function");
	expect(typeof updateFeedbackStateInTransaction).toBe("function");
	expect(TURN_STRUCTURE_PROMPT.version).toBe(
		routerManifest.entries.routeWithSelection.structurePrompt,
	);
	expect(routerManifest.entries.routeWithSelection.modes).toEqual([
		"conversation",
		"tools-only",
	]);
	const lock = read("bun.lock").toString();
	const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
	expect(lock).toContain(
		`${routerManifest.package}@vendor/router/${routerManifest.artifact}`,
	);
	expect(lock).toContain(integrity);
});

test("the installed memory host matches its vendored artifact and the adopted core runtime", () => {
	const manifest = JSON.parse(
		read("vendor/eumenes-memory-host/manifest.json").toString(),
	);
	const artifact = read(`vendor/eumenes-memory-host/${manifest.artifact}`);
	expect(createHash("sha256").update(artifact).digest("hex")).toBe(
		manifest.sha256,
	);
	expect(
		read(`vendor/eumenes-memory-host/${manifest.artifact}.sha256`)
			.toString()
			.split(/\s+/)[0],
	).toBe(manifest.sha256);
	expect(
		JSON.parse(read("package.json").toString()).dependencies[manifest.package],
	).toBe(`file:vendor/eumenes-memory-host/${manifest.artifact}`);
	const lock = read("bun.lock").toString();
	expect(lock).toContain(
		`${manifest.package}@vendor/eumenes-memory-host/${manifest.artifact}`,
	);
	expect(lock).toContain(
		`sha512-${createHash("sha512").update(artifact).digest("base64")}`,
	);
	const hostUrl = new URL("../", import.meta.resolve("eumenes-memory-host"));
	const installed = JSON.parse(
		readFileSync(new URL("package.json", hostUrl), "utf8"),
	);
	expect(installed.version).toBe(manifest.version);
	const release = JSON.parse(
		readFileSync(new URL("dist/release-manifest.json", hostUrl), "utf8"),
	);
	expect(release.sourceHash).toBe(manifest.sourceHash);
	const coreUrl = import.meta.resolve("eumenes-memory/package.json");
	const coreRelease = JSON.parse(
		readFileSync(new URL("./dist/release-manifest.json", coreUrl), "utf8"),
	);
	expect(release.sourceHash).toBe(coreRelease.sourceHash);
	expect(coreRelease.baseCommit).toBe(manifest.sourceGitCommit);
	for (const [path, sha] of Object.entries(release.files)) {
		if (typeof path !== "string" || typeof sha !== "string")
			throw new Error("Invalid host release checksum");
		// Distribution paths are literal filenames, including "%2F" in scoped package notices.
		const bytes = readFileSync(join(fileURLToPath(hostUrl), path));
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
		if (path.startsWith("dist/core/") && path.endsWith(".js"))
			expect(bytes).toEqual(
				readFileSync(new URL(path.replace("dist/core/", "./dist/"), coreUrl)),
			);
	}
});

const additionalTarballVendors = [
	{
		dir: "canvas",
		metaFile: "provenance.json",
		artifactKey: "archive",
		shaKey: "archiveSha256",
	},
	{
		dir: "collaboration",
		metaFile: "provenance.json",
		artifactKey: "archive",
		shaKey: "archiveSha256",
	},
	{
		dir: "interact",
		metaFile: "provenance.json",
		artifactKey: "archive",
		shaKey: "archiveSha256",
	},
	{
		dir: "llm-fetch",
		metaFile: "manifest.json",
		artifactKey: "artifact",
		shaKey: "sha256",
	},
	{
		dir: "pipeline",
		metaFile: "manifest.json",
		artifactKey: "artifact",
		shaKey: "sha256",
	},
	{
		dir: "skill-smith",
		metaFile: "manifest.json",
		artifactKey: "artifact",
		shaKey: "sha256",
	},
] as const;

test("all additional vendored npm tarballs match their metadata, package.json, lockfile and installed version", () => {
	const rootPkg = JSON.parse(read("package.json").toString()) as {
		dependencies: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const lock = read("bun.lock").toString();
	for (const entry of additionalTarballVendors) {
		const meta = JSON.parse(
			read(`vendor/${entry.dir}/${entry.metaFile}`).toString(),
		) as Record<string, unknown>;
		const pkgName = meta.package as string;
		const version = meta.version as string;
		const artifactName = meta[entry.artifactKey] as string;
		const expectedSha = meta[entry.shaKey] as string;
		const relPath = `vendor/${entry.dir}/${artifactName}`;
		const bytes = read(relPath);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha);
		const shaFile = join(root, `${relPath}.sha256`);
		if (existsSync(shaFile)) {
			expect(readFileSync(shaFile, "utf8").split(/\s+/)[0]).toBe(expectedSha);
		}
		const depSpec =
			rootPkg.dependencies[pkgName] ?? rootPkg.devDependencies?.[pkgName];
		expect(depSpec === `file:${relPath}` || depSpec === `./${relPath}`).toBe(
			true,
		);
		const installed = JSON.parse(
			read(`node_modules/${pkgName}/package.json`).toString(),
		) as { version: string };
		expect(installed.version).toBe(version);
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		expect(
			lock.includes(`${pkgName}@${relPath}`) ||
				lock.includes(`${pkgName}@./${relPath}`),
		).toBe(true);
		expect(lock).toContain(integrity);
	}
});

test("live2d vendor assets match assets.json sha256 (tracked files required, gitignored model optional)", () => {
	const assets = JSON.parse(read("vendor/live2d/assets.json").toString()) as {
		sdk: string;
		sha256: Record<string, string>;
	};
	expect(assets.sdk).toBeTruthy();
	for (const [relPath, expectedSha] of Object.entries(assets.sha256)) {
		const full = join(root, relPath);
		const isGitignoredModel = relPath.startsWith("web/public/live2d/hiyori/");
		if (isGitignoredModel && !existsSync(full)) continue;
		expect(existsSync(full)).toBe(true);
		const actual = createHash("sha256")
			.update(readFileSync(full))
			.digest("hex");
		expect(actual).toBe(expectedSha);
	}
});

test("vendor/ contains no unreferenced tarballs outside package.json and manifest derivedFrom provenance", () => {
	const rootPkg = JSON.parse(read("package.json").toString()) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const allowed = new Set<string>();
	for (const section of [rootPkg.dependencies, rootPkg.devDependencies]) {
		for (const spec of Object.values(section ?? {})) {
			if (spec.includes("vendor/")) {
				allowed.add(spec.replace(/^file:/, "").replace(/^\.\//, ""));
			}
		}
	}
	const vendorRoot = join(root, "vendor");
	const unreferenced: string[] = [];
	for (const dir of readdirSync(vendorRoot, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const sub = join(vendorRoot, dir.name);
		const manifestPath = join(sub, "manifest.json");
		if (existsSync(manifestPath)) {
			const meta = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				derivedFrom?: unknown;
			};
			if (typeof meta.derivedFrom === "string" && meta.derivedFrom) {
				allowed.add(`vendor/${dir.name}/${meta.derivedFrom}`);
			}
		}
		for (const file of readdirSync(sub)) {
			if (!file.endsWith(".tgz")) continue;
			const rel = `vendor/${dir.name}/${file}`;
			if (!allowed.has(rel)) unreferenced.push(rel);
		}
	}
	expect(unreferenced).toEqual([]);
});
