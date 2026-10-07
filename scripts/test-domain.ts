import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { domains, isDomain, ownedPaths } from "./domains";

const args = process.argv.slice(2).filter((x) => x !== "--");
const domain = args[0];
if (!domain || !isDomain(domain)) {
	console.error(`Domain required: ${Object.keys(domains).join(", ")}`);
	process.exit(2);
}
const sub = args[1];
function files(path: string): string[] {
	try {
		return readdirSync(path).flatMap((name) => {
			const file = join(path, name);
			return statSync(file).isDirectory()
				? files(file)
				: /\.(test|spec)\.[tj]sx?$/.test(file)
					? [file]
					: [];
		});
	} catch {
		return [];
	}
}
const paths = ownedPaths(domain).map((path) =>
	sub ? join(path, "subdomains", sub) : path,
);
const tests = paths.flatMap(files);
if (tests.length === 0) {
	console.error(`No tests selected for ${domain}${sub ? `/${sub}` : ""}`);
	process.exit(3);
}
const backend = tests.filter((path) => path.startsWith("api/"));
const web = tests.filter((path) => path.startsWith("web/"));
async function run(args: string[]) {
	const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) process.exit(code);
}
if (backend.length) await run([process.execPath, "test", ...backend]);
if (web.length) await run([process.execPath, "x", "vitest", "run", ...web]);
