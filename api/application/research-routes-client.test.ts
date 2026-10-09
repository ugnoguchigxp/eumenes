import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError, createClient } from "../../client";

const root = resolve(import.meta.dir, "../..");
type Seen = { method: string; path: string; body: unknown };
function fake(handler: (seen: Seen) => Response) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? await req.json() : null;
			const entry = {
				method: req.method,
				path: url.pathname + url.search,
				body,
			};
			seen.push(entry);
			return handler(entry);
		},
	});
	return { seen, server, url: `http://127.0.0.1:${server.port}` };
}
const key = "a".repeat(64);
const token = "b".repeat(64);
const dto = { key, state: "expired", stateToken: token };

test("H02 client uses the documented method/path/body and surfaces 409", async () => {
	const f = fake((s) =>
		s.path.endsWith("/disable")
			? Response.json({ error: "stale_state_token" }, { status: 409 })
			: Response.json(dto),
	);
	try {
		const client = createClient(f.url, "fixture-api-token-long-enough");
		await client.researchRoutes({ cursor: "c", limit: 5 });
		await client.researchRoute(key);
		await client.editResearchRoute(key, {
			requestId: crypto.randomUUID(),
			expectedStateToken: token,
			instruction: "説明を直す",
		});
		await client.rediscoverResearchRoute(key, {
			requestId: crypto.randomUUID(),
			expectedStateToken: token,
		});
		await client.clearResearchRoutes({
			requestId: crypto.randomUUID(),
			expectedEpoch: 3,
		});
		await expect(
			client.disableResearchRoute(key, {
				requestId: crypto.randomUUID(),
				expectedStateToken: token,
			}),
		).rejects.toMatchObject({ status: 409 });
		expect(f.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"GET /api/research-routes?cursor=c&limit=5",
			`GET /api/research-routes/${key}`,
			`POST /api/research-routes/${key}/edits`,
			`POST /api/research-routes/${key}/rediscover`,
			"POST /api/research-routes/clear",
			`POST /api/research-routes/${key}/disable`,
		]);
		expect(f.seen[4]?.body).toMatchObject({ expectedEpoch: 3 });
		expect(ApiError).toBeDefined();
	} finally {
		await f.server.stop(true);
	}
});

async function cli(args: string[], url: string) {
	const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			EUMENES_API_TOKEN: "fixture-api-token-long-enough",
			EUMENES_URL: url,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test("H02 CLI drives list/show/edit/disable/rediscover/clear through the API only", async () => {
	const f = fake(() => Response.json({ ...dto, epoch: 2, draftId: "d" }));
	const dir = mkdtempSync(join(tmpdir(), "routes-cli-"));
	const file = join(dir, "edit.txt");
	writeFileSync(file, "  説明を丁寧にする\n");
	const id = crypto.randomUUID();
	try {
		expect((await cli(["research-routes", "list"], f.url)).code).toBe(0);
		expect((await cli(["research-routes", "show", key], f.url)).code).toBe(0);
		expect(
			(
				await cli(
					["research-routes", "edit", key, token, file, "--request-id", id],
					f.url,
				)
			).code,
		).toBe(0);
		expect(
			(await cli(["research-routes", "disable", key, token], f.url)).code,
		).toBe(0);
		expect(
			(await cli(["research-routes", "rediscover", key, token], f.url)).code,
		).toBe(0);
		expect((await cli(["research-routes", "clear", "2"], f.url)).code).toBe(0);
		expect(f.seen[2]?.body).toEqual({
			requestId: id,
			expectedStateToken: token,
			instruction: "説明を丁寧にする",
		});
		expect(f.seen[5]?.body).toMatchObject({ expectedEpoch: 2 });
		const bad = await cli(["research-routes", "clear", "x"], f.url);
		expect(bad.code).not.toBe(0);
		expect(bad.stderr).toContain("usage: research-routes");
		expect(f.seen).toHaveLength(6);
	} finally {
		await f.server.stop(true);
	}
});
