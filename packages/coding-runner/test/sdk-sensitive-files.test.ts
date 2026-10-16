import { expect, test } from "bun:test";
import { SENSITIVE_FILE_GLOBS } from "../src/sdk-sensitive-files";

const denied = (path: string) =>
	SENSITIVE_FILE_GLOBS.some((glob) => new Bun.Glob(glob).match(path));

test("dotenv files, keys, certificates and credential stores are denied at any depth", () => {
	for (const path of [
		".env",
		"app/.env",
		".env.local",
		"a/b/.env.production",
		"prod.env",
		"certs/server.pem",
		"server.key",
		"deploy/store.p12",
		"store.pfx",
		"android/release.jks",
		"app.keystore",
		".ssh/id_rsa",
		"keys/id_rsa.pub",
		"id_ed25519",
		"home/id_ecdsa",
		"home/.netrc",
		".pgpass",
	])
		expect(denied(path)).toBe(true);
});

test("ordinary source files are not denied", () => {
	for (const path of [
		"src/index.ts",
		"README.md",
		"environment.ts",
		"src/keyboard.ts",
		"docs/pem-format.md",
		"package.json",
	])
		expect(denied(path)).toBe(false);
});
