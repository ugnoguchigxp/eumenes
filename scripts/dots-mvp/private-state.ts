import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	chmodSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function privateFile(path: string, make: () => Buffer): Buffer {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, make());
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	chmodSync(path, 0o600);
	return readFileSync(path);
}
export function privateDirectory(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}
export function stateSecrets(directory: string) {
	privateDirectory(directory);
	const key = privateFile(join(directory, "encryption.key"), () =>
		randomBytes(32),
	);
	const admin = privateFile(join(directory, "admin.token"), () =>
		Buffer.from(randomBytes(32).toString("base64url")),
	).toString();
	return {
		admin,
		encrypt(value: string) {
			const iv = randomBytes(12);
			const c = createCipheriv("aes-256-gcm", key, iv);
			return Buffer.concat([
				iv,
				c.update(value),
				c.final(),
				c.getAuthTag(),
			]).toString("base64");
		},
		decrypt(value: string) {
			const b = Buffer.from(value, "base64");
			const c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
			c.setAuthTag(b.subarray(-16));
			return Buffer.concat([
				c.update(b.subarray(12, -16)),
				c.final(),
			]).toString();
		},
	};
}
