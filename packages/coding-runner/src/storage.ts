import { dlopen, FFIType } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { id, canonicalJSON } from "./contracts";

export const digest = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
export const canonical = canonicalJSON;
export function privateDirectory(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const s = lstatSync(path);
	if (
		!s.isDirectory() ||
		s.isSymbolicLink() ||
		(s.mode & 0o077) !== 0 ||
		s.uid !== process.getuid?.()
	)
		throw new Error("runner_directory_not_private");
	if (realpathSync(path) !== resolve(path))
		throw new Error("runner_path_not_canonical");
	return path;
}
export function readPrivate(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd);
		if (
			!s.isFile() ||
			(s.mode & 0o077) !== 0 ||
			s.uid !== process.getuid?.() ||
			s.size > 2 * 1024 * 1024
		)
			throw new Error("runner_file_not_private");
		const data = Buffer.alloc(s.size + 1);
		let size = 0;
		while (size < data.length) {
			const count = readSync(fd, data, size, data.length - size, size);
			if (count === 0) break;
			size += count;
		}
		const after = fstatSync(fd);
		if (size !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs)
			throw new Error("runner_file_changed");
		// Atomic replacement may unlink this opened inode and change ctime; its bytes remain a valid snapshot.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			data.subarray(0, size),
		);
	} finally {
		closeSync(fd);
	}
}
export function atomicWrite(path: string, value: unknown) {
	const temp = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(
		temp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		try {
			writeFileSync(fd, typeof value === "string" ? value : canonical(value));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
		const dir = openSync(dirname(path), constants.O_RDONLY);
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}
let flock: ((fd: number, operation: number) => number) | undefined;
export function lock(path: string): () => void {
	flock ??= dlopen(
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		},
	).symbols.flock;
	const fd = openSync(
		path,
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	fchmodSync(fd, 0o600);
	if (flock(fd, 6) !== 0) {
		closeSync(fd);
		throw new Error("runner_busy");
	}
	return () => {
		flock!(fd, 8);
		closeSync(fd);
	};
}
export function runPath(root: string, executionId: string) {
	return join(root, "runs", id.parse(executionId));
}
export function optionalJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readPrivate(path)) as T;
}
export function totalSize(root: string): number {
	if (!existsSync(root)) return 0;
	return readdirSync(root).reduce((sum, name) => {
		const path = join(root, name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("runner_spool_symlink");
		return sum + (stat.isDirectory() ? totalSize(path) : stat.size);
	}, 0);
}
/** Throws runner_spool_symlink if anything under root is a symlink. */
export function assertNoSymlinks(root: string): void {
	totalSize(root);
}
const sizes = new Map<string, { at: number; bytes: number }>();
/** Spool bytes, re-walked at most once per ttl; own writes are added incrementally. */
export function spoolSize(
	root: string,
	now = Date.now(),
	ttlMs = 60_000,
): number {
	const hit = sizes.get(root);
	if (hit && now - hit.at < ttlMs) return hit.bytes;
	const bytes = totalSize(root);
	sizes.set(root, { at: now, bytes });
	return bytes;
}
export function addSpoolBytes(root: string, bytes: number): void {
	const hit = sizes.get(root);
	if (hit) hit.bytes += bytes;
}
export function invalidateSpoolSize(root: string): void {
	sizes.delete(root);
}
