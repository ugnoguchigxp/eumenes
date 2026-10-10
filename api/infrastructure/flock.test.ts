import { expect, test } from "bun:test";
import { closeSync, constants, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flock, flockLibraryPath, LOCK_EX_NB, LOCK_UN } from "./flock";

test("the libc path is chosen per platform and unsupported hosts have none", () => {
	expect(flockLibraryPath("darwin")).toBe("/usr/lib/libSystem.B.dylib");
	expect(flockLibraryPath("linux")).toBe("libc.so.6");
	expect(flockLibraryPath("win32")).toBeNull();
});

test("an exclusive lock on one descriptor blocks a second descriptor until released", () => {
	const path = join(tmpdir(), `eumenes-flock-${process.pid}-${Date.now()}`);
	const a = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
	const b = openSync(path, constants.O_RDWR);
	try {
		expect(flock(a, LOCK_EX_NB)).toBe(0);
		expect(flock(b, LOCK_EX_NB)).not.toBe(0);
		expect(flock(a, LOCK_UN)).toBe(0);
		expect(flock(b, LOCK_EX_NB)).toBe(0);
		expect(flock(b, LOCK_UN)).toBe(0);
	} finally {
		closeSync(a);
		closeSync(b);
		rmSync(path, { force: true });
	}
});
