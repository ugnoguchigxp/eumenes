import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const generated = new Set([
	"data",
	"dist-web",
	"verification-reports",
	"test-results",
	"playwright-report",
	"spec/verification",
	"packages/design-system/dist",
]);
const sourceExtension =
	/\.(?:[cm]?[jt]sx?|css|jsonc?|md|mdx|html|ya?ml|toml|py|sh|svg|png|jpe?g|webp|gif|woff2?|ttf|glb|wav|tgz)$/;

/** Exclude another Eumenes checkout from the product's tests and input hash. */
export function isParkedCheckout(root: string, directory: string): boolean {
	if (
		!directory ||
		directory === "packages" ||
		directory.startsWith("packages/")
	)
		return false;
	const dir = join(root, directory);
	if (
		!statSync(join(dir, "api"), { throwIfNoEntry: false })?.isDirectory() ||
		!statSync(join(dir, "web"), { throwIfNoEntry: false })?.isDirectory()
	)
		return false;
	try {
		const manifest = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		);
		return manifest?.name === "eumenes";
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(error as NodeJS.ErrnoException).code === "ENOENT"
		)
			return false;
		throw error;
	}
}

/** Hash editable inputs and runtime assets, never reports or build outputs. */
export function verificationRevision(root: string) {
	const inputs: string[] = [];
	function walk(directory: string) {
		for (const entry of readdirSync(join(root, directory), {
			withFileTypes: true,
		})) {
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (
					!["node_modules", ".git", ".serena"].includes(entry.name) &&
					!generated.has(path) &&
					!isParkedCheckout(root, path)
				)
					walk(path);
			} else if (
				entry.isFile() &&
				(sourceExtension.test(path) ||
					path === "bun.lock" ||
					path === ".gitignore")
			)
				inputs.push(path);
		}
	}
	walk("");
	const hash = new Bun.CryptoHasher("sha256");
	for (const path of inputs.sort()) {
		const content = readFileSync(join(root, path));
		hash.update(`${Buffer.byteLength(path)}:${path}:${content.length}:`);
		hash.update(content);
	}
	return hash.digest("hex");
}
