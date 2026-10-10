import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeFs from "node:fs";
import {
	readApiToken,
	resolveApiToken,
	resolveLarmToken,
	type TokenFs,
} from "./auth-config";

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

const keysFile = (dir: string, content: string, mode = 0o600) => {
	const keys = join(dir, "keys");
	mkdirSync(keys, { recursive: true });
	const path = join(keys, "api.token");
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
};
const age = (path: string, ms: number) => {
	const t = (Date.now() - ms) / 1000;
	utimesSync(path, t, t);
};

test("readApiToken never creates the token file or directory", () => {
	const { dir, env } = dbEnv();
	expect(() => readApiToken(env)).toThrow("api_token_not_found:");
	expect(existsSync(join(dir, "keys"))).toBe(false);
});

test("readApiToken reads an existing file and follows EUMENES_KEY_DIR", () => {
	const { dir, env } = dbEnv();
	const stored = "cd".repeat(32);
	keysFile(dir, stored);
	expect(readApiToken(env)).toBe(stored);
	const other = mkdtempSync(join(tmpdir(), "eumenes-auth-key-"));
	dirs.push(other);
	writeFileSync(join(other, "api.token"), "ef".repeat(32));
	expect(readApiToken({ ...env, EUMENES_KEY_DIR: other })).toBe(
		"ef".repeat(32),
	);
});

test("a loose keys directory is tightened to 0700", () => {
	const { dir, env } = dbEnv();
	mkdirSync(join(dir, "keys"), { mode: 0o755 });
	chmodSync(join(dir, "keys"), 0o755);
	resolveApiToken(env);
	expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
});

test("a loose token file is tightened to 0600 and keeps its value", () => {
	const { dir, env } = dbEnv();
	const stored = "ab".repeat(32);
	const path = keysFile(dir, stored, 0o644);
	expect(resolveApiToken(env)).toBe(stored);
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a stale empty token file is recreated", () => {
	const { dir, env } = dbEnv();
	const path = keysFile(dir, "");
	age(path, 60_000);
	const token = resolveApiToken(env);
	expect(token).toMatch(/^[0-9a-f]{64}$/);
	expect(readFileSync(path, "utf8").trim()).toBe(token);
});

test("a fresh empty token file is not recovered", () => {
	const { dir, env } = dbEnv();
	keysFile(dir, "");
	expect(() => resolveApiToken(env)).toThrow("api_token_file_invalid");
});

test("a non-hex token file is never deleted even when old", () => {
	const { dir, env } = dbEnv();
	const path = keysFile(dir, "not-a-token");
	age(path, 60_000);
	expect(() => resolveApiToken(env)).toThrow("api_token_file_invalid");
	expect(readFileSync(path, "utf8")).toBe("not-a-token");
});

test("readApiToken has no side effects on loose or partial files", () => {
	const loose = dbEnv();
	const stored = "ab".repeat(32);
	const looseFile = keysFile(loose.dir, stored, 0o644);
	expect(readApiToken(loose.env)).toBe(stored);
	expect(statSync(looseFile).mode & 0o777).toBe(0o644);
	expect(readFileSync(looseFile, "utf8")).toBe(stored);

	const partial = dbEnv();
	const partialFile = keysFile(partial.dir, "", 0o644);
	age(partialFile, 60_000);
	expect(() => readApiToken(partial.env)).toThrow("api_token_file_invalid");
	expect(existsSync(partialFile)).toBe(true);
	expect(statSync(partialFile).mode & 0o777).toBe(0o644);
	expect(readFileSync(partialFile, "utf8")).toBe("");
});

const realFs: TokenFs = nodeFs;

test("a valid token that replaced a stale partial file between inspection and deletion is kept", () => {
	const { dir, env } = dbEnv();
	const path = keysFile(dir, "");
	age(path, 60_000);
	const winner = "ab".repeat(32);
	let stats = 0;
	const token = resolveApiToken(env, {
		...realFs,
		statSync: ((p: string, ...rest: never[]) => {
			// 1st call is the recovery's inspection; swap the file in before the re-check.
			if (p === path && ++stats === 1) {
				const result = realFs.statSync(p, ...rest);
				writeFileSync(`${path}.winner`, winner, { mode: 0o600 });
				renameSync(`${path}.winner`, path);
				return result;
			}
			return realFs.statSync(p, ...rest);
		}) as TokenFs["statSync"],
	});
	expect(token).toBe(winner);
	expect(readFileSync(path, "utf8").trim()).toBe(winner);
});

for (const [name, linkError] of [
	["hard link", undefined],
	["exclusive create fallback", "EPERM"],
] as const)
	test(`a stale partial file that appears before the ${name} is recovered, not thrown`, () => {
		const { dir, env } = dbEnv();
		let planted = false;
		const plant = () => {
			if (planted) return;
			planted = true;
			const path = keysFile(dir, "");
			age(path, 60_000);
		};
		const token = resolveApiToken(env, {
			...realFs,
			linkSync: ((from: string, to: string) => {
				plant();
				if (linkError)
					throw Object.assign(new Error(linkError), { code: linkError });
				return realFs.linkSync(from, to);
			}) as TokenFs["linkSync"],
		});
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		const path = join(dir, "keys", "api.token");
		expect(readFileSync(path, "utf8").trim()).toBe(token);
		expect(readdirSync(join(dir, "keys"))).toEqual(["api.token"]);
	});
