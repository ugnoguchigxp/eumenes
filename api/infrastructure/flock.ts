import { dlopen, FFIType } from "bun:ffi";

export const LOCK_EX_NB = 2 | 4;
export const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;
let lib: { symbols: { flock: Flock } } | undefined;

export function flockLibraryPath(platform = process.platform): string | null {
	if (platform === "darwin") return "/usr/lib/libSystem.B.dylib";
	if (platform === "linux") return "libc.so.6";
	return null;
}

// Loaded on first use so importing this module never dlopens (or fails) on an unsupported host.
function load() {
	const path = flockLibraryPath();
	if (!path) throw new Error("flock_unsupported_platform");
	return (lib ??= dlopen(path, {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	}));
}

export function flock(fd: number, operation: number): number {
	return load().symbols.flock(fd, operation);
}
