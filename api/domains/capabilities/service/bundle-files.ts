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

/**
 * A suspended bundle kept beside the shipped ones (`<name>.bundle.dormant.json`): never seeded, so its
 * toolchain is offered nowhere. Only the fixtures of the suspended implementation register it explicitly.
 */
/** @public */
export function dormantBundleFile(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`${name}.bundle.dormant.json`, directory), "utf8"),
	);
}
