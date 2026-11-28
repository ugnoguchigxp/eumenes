import { createHash } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { versionPattern } from "./project";

export const releaseFiles = [
	"package.json",
	"bun.lock",
	"bunfig.toml",
	"resolution.json",
	"worker.js",
	"host-adapter.tsx",
	"standalone-adapter.tsx",
	"styles.d.ts",
	"project.ts",
	"build.ts",
	"preview.ts",
	"release.ts",
	"standalone.ts",
	"prepare.ts",
	"check.ts",
] as const;
export const releaseSupportsChecks = (version: string) =>
	!version.startsWith("1.");
export const filesForRelease = (version: string) =>
	releaseSupportsChecks(version)
		? releaseFiles
		: releaseFiles.filter((file) => file !== "check.ts");
export type Pin = { commit: string; digest: string };
export function releaseDigest(
	version: string,
	read: (name: string) => Uint8Array,
) {
	const hash = createHash("sha256");
	for (const name of filesForRelease(version)) {
		const body = read(name);
		hash
			.update(name)
			.update(String(body.byteLength) + ":")
			.update(body);
	}
	return hash.digest("hex");
}

let lib:
	| ReturnType<
			typeof dlopen<{
				flock: {
					args: [typeof FFIType.i32, typeof FFIType.i32];
					returns: typeof FFIType.i32;
				};
			}>
	  >
	| undefined;
export function lockFile(path: string, exclusive: boolean) {
	if (process.platform !== "darwin")
		throw new Error("prototype_platform_unsupported");
	lib ??= dlopen("/usr/lib/libSystem.B.dylib", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	const fd = openSync(path, "a+", 0o600);
	if (lib.symbols.flock(fd, (exclusive ? 2 : 1) | 4) !== 0) {
		closeSync(fd);
		throw new Error("prototype_release_busy");
	}
	let open = true;
	return () => {
		if (open) {
			closeSync(fd);
			open = false;
		}
	};
}

export function openRelease(root: string, version: string) {
	if (!versionPattern.test(version))
		throw new Error("prototype_environment_invalid");
	const directory = join(root, "releases", version);
	const setupHelp =
		"prototype_environment_missing: prepare Works release " + version;
	let unlock: (() => void) | undefined;
	try {
		const actual = realpathSync(root);
		const path = realpathSync(directory);
		if (actual !== root || path !== directory)
			throw new Error("prototype_environment_invalid");
		unlock = lockFile(join(root, "locks", version), false);
		const pin = JSON.parse(
			readFileSync(join(root, "pins", version + ".json"), "utf8"),
		) as Pin;
		const digest = releaseDigest(version, (file) => {
			const target = join(path, file);
			if (!lstatSync(target).isFile())
				throw new Error("prototype_environment_invalid");
			return readFileSync(target);
		});
		if (pin.digest !== digest || !/^[0-9a-f]{40,64}$/.test(pin.commit))
			throw new Error("prototype_environment_invalid");
		utimesSync(path, new Date(), new Date());
		return { path, close: unlock };
	} catch (error) {
		unlock?.();
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(setupHelp);
		throw error;
	}
}
