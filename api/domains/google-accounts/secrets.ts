import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
export const random = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
	createHash("sha256").update(value).digest("base64url");
const aad = Buffer.from("eumenes.google-account.v1");
export function seal(value: unknown, key: Uint8Array): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(aad);
	const body = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf8"),
		cipher.final(),
	]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function unseal<T>(value: string, key: Uint8Array): T {
	const data = Buffer.from(value, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
	decipher.setAAD(aad);
	decipher.setAuthTag(data.subarray(12, 28));
	return JSON.parse(
		Buffer.concat([
			decipher.update(data.subarray(28)),
			decipher.final(),
		]).toString("utf8"),
	) as T;
}
