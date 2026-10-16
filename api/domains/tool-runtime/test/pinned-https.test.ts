import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The TLS server uses a throwaway certificate for a hostname that no resolver knows, so the
 * request can only succeed by connecting to the pinned address. Runs in a child process because
 * the extra CA is read at process start.
 */
test("the connection goes to the pinned address while TLS verifies the URL hostname", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pinned-"));
	try {
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		const made = Bun.spawnSync([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=pinned.invalid",
			"-addext",
			"subjectAltName=DNS:pinned.invalid",
		]);
		expect(made.exitCode).toBe(0);
		const script = join(dir, "child.ts");
		writeFileSync(
			script,
			`import { pinnedHttpsFetch } from ${JSON.stringify(resolve(import.meta.dir, "../service/pinned-https.ts"))};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	tls: { key: Bun.file(${JSON.stringify(key)}), cert: Bun.file(${JSON.stringify(cert)}) },
	fetch: (request) =>
		request.url.includes("redirect")
			? new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } })
			: Response.json({ host: new URL(request.url).hostname, body: request.method === "POST" ? "post" : "get" }),
});
const init = (method: string, body?: string) => ({ method, headers: { accept: "application/json" }, body, signal: AbortSignal.timeout(5000) });
const pinned = { address: "127.0.0.1", family: 4 as const };
const ok = await pinnedHttpsFetch(new URL("https://pinned.invalid:" + server.port + "/a"), init("POST", "{}"), pinned);
const redirect = await pinnedHttpsFetch(new URL("https://pinned.invalid:" + server.port + "/redirect"), init("GET"), pinned);
console.log(JSON.stringify({ status: ok.status, json: await ok.json(), redirect: redirect.status, location: redirect.headers.get("location") }));
server.stop(true);`,
		);
		const result = Bun.spawnSync([process.execPath, script], {
			env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
		});
		expect(result.stderr.toString()).toBe("");
		expect(JSON.parse(result.stdout.toString())).toEqual({
			status: 200,
			json: { host: "pinned.invalid", body: "post" },
			redirect: 302,
			location: "https://elsewhere.invalid/",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
