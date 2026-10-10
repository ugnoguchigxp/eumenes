import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiToken, resolveLarmToken } from "./auth-config";

const dirs: string[] = [];
const dbEnv = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-auth-"));
	dirs.push(dir);
	return { dir, env: { EUMENES_DB: join(dir, "eumenes.sqlite3") } };
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("empty optional settings do not mask the exported LARM token", () => {
	const env = {
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
		EUMENES_API_TOKEN: "",
	};
	expect(resolveLarmToken(env)).toBe("fixture-control");
	expect(resolveLarmToken({ ...env, LARM_CONTROL_TOKEN: "old-control" })).toBe(
		"fixture-control",
	);
});

test("an explicit API token is used as is", () => {
	const explicit = "local-api-token-with-24-characters";
	expect(
		resolveApiToken({
			EUMENES_API_TOKEN: ` ${explicit} `,
			LARM_API_TOKEN: "c",
		}),
	).toBe(explicit);
});

test("an explicit API token under 24 characters is rejected", () => {
	expect(() =>
		resolveApiToken({ EUMENES_API_TOKEN: "short", LARM_API_TOKEN: "control" }),
	).toThrow("at least 24");
});

test("a missing token file is generated with mode 0600", () => {
	const { dir, env } = dbEnv();
	const token = resolveApiToken(env);
	expect(token).toMatch(/^[0-9a-f]{64}$/);
	const path = join(dir, "keys", "api.token");
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
	expect(resolveApiToken(env)).toBe(token);
});

test("an existing token file is read", () => {
	const { dir, env } = dbEnv();
	mkdirSync(join(dir, "keys"));
	const stored = "ab".repeat(32);
	writeFileSync(join(dir, "keys", "api.token"), `${stored}\n`);
	expect(resolveApiToken(env)).toBe(stored);
});

test("an invalid token file is rejected", () => {
	const { dir, env } = dbEnv();
	mkdirSync(join(dir, "keys"));
	writeFileSync(join(dir, "keys", "api.token"), "not-a-token");
	expect(() => resolveApiToken(env)).toThrow("api_token_file_invalid");
});

test("the LARM token never determines the API token", () => {
	const a = dbEnv();
	const b = dbEnv();
	const first = resolveApiToken({
		...a.env,
		LARM_API_TOKEN: "fixture-control",
	});
	const second = resolveApiToken({
		...b.env,
		LARM_API_TOKEN: "fixture-control",
	});
	expect(first).toMatch(/^[0-9a-f]{64}$/);
	expect(first).not.toBe(second);
	expect(resolveApiToken({ ...a.env, LARM_API_TOKEN: "other-control" })).toBe(
		first,
	);
});

test("an empty EUMENES_DB is treated as unset", () => {
	const cwd = mkdtempSync(join(tmpdir(), "eumenes-auth-cwd-"));
	dirs.push(cwd);
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		const token = resolveApiToken({ EUMENES_DB: "  " });
		expect(readFileSync(join(cwd, "data", "keys", "api.token"), "utf8")).toBe(
			token,
		);
	} finally {
		process.chdir(previous);
	}
});

test("EUMENES_KEY_DIR relocates the token file like the settings key", () => {
	const { dir, env } = dbEnv();
	const keyDir = join(dir, "elsewhere");
	const token = resolveApiToken({ ...env, EUMENES_KEY_DIR: keyDir });
	expect(readFileSync(join(keyDir, "api.token"), "utf8")).toBe(token);
	expect(existsSync(join(dir, "keys"))).toBe(false);
	expect(resolveApiToken({ ...env, EUMENES_KEY_DIR: keyDir })).toBe(token);
});

test("token creation leaves no temp files and keeps an existing target", () => {
	const { dir, env } = dbEnv();
	const token = resolveApiToken(env);
	expect(readdirSync(join(dir, "keys"))).toEqual(["api.token"]);
	expect(resolveApiToken(env)).toBe(token);
});

test("concurrent starters all observe one complete token", async () => {
	const { dir } = dbEnv();
	const script = `import { resolveApiToken } from ${JSON.stringify(join(import.meta.dir, "auth-config.ts"))};
process.stdout.write(resolveApiToken({ EUMENES_DB: ${JSON.stringify(join(dir, "db.sqlite3"))} }));`;
	const file = join(dir, "start.ts");
	writeFileSync(file, script);
	const runs = await Promise.all(
		Array.from({ length: 8 }, async () => {
			const proc = Bun.spawn([process.execPath, file], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			return { out, err };
		}),
	);
	for (const run of runs) expect(run.err).toBe("");
	expect(new Set(runs.map((r) => r.out)).size).toBe(1);
	expect(runs[0]!.out).toMatch(/^[0-9a-f]{64}$/);
	expect(readdirSync(join(dir, "keys"))).toEqual(["api.token"]);
});
