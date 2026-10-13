import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = new URL("../bundles/", import.meta.url);

/** The reviewed bundles shipped in the repository, as parsed JSON in file-name order. */
export function bundleFiles(): { name: string; raw: unknown }[] {
	return readdirSync(fileURLToPath(directory))
		.filter((name) => name.endsWith(".bundle.json"))
		.sort()
		.flatMap((name) => {
			try {
				return [
					{
						name,
						raw: JSON.parse(readFileSync(new URL(name, directory), "utf8")),
					},
				];
			} catch {
				return [{ name, raw: null }];
			}
		});
}

/** Function names of the toolchains shipped inside bundles. */
export function bundleToolchainFunctions(): string[] {
	return bundleFiles().flatMap(({ raw }) => {
		const definitions = (raw as { definitions?: unknown })?.definitions;
		return Array.isArray(definitions)
			? definitions.flatMap((d: { kind?: unknown; functionName?: unknown }) =>
					d?.kind === "toolchain" && typeof d.functionName === "string"
						? [d.functionName]
						: [],
				)
			: [];
	});
}
