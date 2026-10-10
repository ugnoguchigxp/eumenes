import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolveApiToken } from "../../../infrastructure/auth-config";
import { join } from "node:path";
/** A dedicated private key, created atomically by the existing key-file mechanism. Never the product API token. */
export function createSecretBox(keyDir: string) {
	const key = Buffer.from(
		resolveApiToken({ EUMENES_KEY_DIR: join(keyDir, "dots") }),
		"hex",
	);
	return {
		seal(value: string, owner: string) {
			const iv = randomBytes(12),
				c = createCipheriv("aes-256-gcm", key, iv);
			c.setAAD(Buffer.from(owner));
			const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
			return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
		},
		unseal(value: string, owner: string) {
			const b = Buffer.from(value, "base64"),
				d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
			d.setAAD(Buffer.from(owner));
			d.setAuthTag(b.subarray(12, 28));
			return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(
				"utf8",
			);
		},
	};
}
