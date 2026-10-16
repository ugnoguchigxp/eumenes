import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretBox } from "..";

const dirs: string[] = [];
const keyDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-secret-box-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a sealed value unseals for its owner and is not stored in clear text", () => {
	const box = createSecretBox(keyDir());
	const secret = "whsec_" + "A".repeat(40);
	const sealed = box.seal(secret, "owner-a");
	expect(sealed).not.toContain(secret);
	expect(Buffer.from(sealed, "base64").toString("utf8")).not.toContain(
		"whsec_",
	);
	expect(box.unseal(sealed, "owner-a")).toBe(secret);
	expect(box.unseal(box.seal("", "owner-a"), "owner-a")).toBe("");
	expect(box.unseal(box.seal("日本語の秘密", "o"), "o")).toBe("日本語の秘密");
});

test("every seal uses a fresh nonce so equal values differ", () => {
	const box = createSecretBox(keyDir());
	const a = box.seal("same", "owner");
	const b = box.seal("same", "owner");
	expect(a).not.toBe(b);
	expect(box.unseal(a, "owner")).toBe(box.unseal(b, "owner"));
});

test("a value sealed for one owner cannot be unsealed for another", () => {
	const box = createSecretBox(keyDir());
	const sealed = box.seal("secret", "owner-a");
	expect(() => box.unseal(sealed, "owner-b")).toThrow();
	expect(() => box.unseal(sealed, "")).toThrow();
});

test("any tampering with the nonce, tag or body is rejected", () => {
	const box = createSecretBox(keyDir());
	const sealed = Buffer.from(
		box.seal("a longer secret value", "owner"),
		"base64",
	);
	// Nonce (0-11), tag (12-27) and body (28-).
	for (const index of [0, 11, 12, 27, 28, sealed.length - 1]) {
		const copy = Buffer.from(sealed);
		copy[index] = copy[index]! ^ 0x01;
		expect(() => box.unseal(copy.toString("base64"), "owner")).toThrow();
	}
	expect(() =>
		box.unseal(
			sealed.subarray(0, sealed.length - 1).toString("base64"),
			"owner",
		),
	).toThrow();
	// A value too short to hold a full tag is never authenticated.
	expect(() =>
		box.unseal(Buffer.alloc(12 + 4).toString("base64"), "owner"),
	).toThrow("invalid_sealed_value");
	expect(() => box.unseal("", "owner")).toThrow("invalid_sealed_value");
	expect(() => box.unseal("AAAA", "owner")).toThrow();
});

test("the key persists in the key directory and differs between directories", () => {
	const dir = keyDir();
	const first = createSecretBox(dir);
	const sealed = first.seal("secret", "owner");
	const reopened = createSecretBox(dir);
	expect(reopened.unseal(sealed, "owner")).toBe("secret");
	expect(() => createSecretBox(keyDir()).unseal(sealed, "owner")).toThrow();
	const file = join(dir, "dots", "api.token");
	expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
	expect(statSync(file).mode & 0o077).toBe(0);
});
