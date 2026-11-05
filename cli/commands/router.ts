import { readFile } from "node:fs/promises";
import type { CommandRun } from "./types";

const USAGE =
	"usage: router status | router import-memory <file> | router set entry <route|routeStructured> | router set profile <profile> | router set structureResource <resource id|none> | router set <timeoutMs|structureTimeoutMs> <ms> | router set <accept|low|margin|approve|multi|feedbackNear> <0..1> | router set feedbackWeight <0..5> | router clear-profile";

const NUMBERS = [
	"timeoutMs",
	"structureTimeoutMs",
	"accept",
	"low",
	"margin",
	"approve",
	"multi",
	"feedbackNear",
	"feedbackWeight",
] as const;

/**
 * The router's settings (spec router-package-integration 2026-11-04 §3): the package's entry, the saved
 * LARM Agent Profile of its context judgment, the structure model's resource, the waits and the decision table's
 * thresholds; and best-v2's memory, which the package needs and Git does not hold. The
 * speaking-attitude judge's settings are not touched.
 */
export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const [sub, field, value] = args.positional;
	if (!sub || sub === "status") {
		show(await client.routerSettings());
		return 0;
	}
	if (sub === "import-memory") {
		if (!field) throw new Error(USAGE);
		show(
			await client.importRouterMemory(
				JSON.parse(await readFile(field, "utf8")),
			),
		);
		return 0;
	}
	if (sub === "clear-profile") {
		show(await client.configureRouter({ profile: null }));
		return 0;
	}
	if (sub !== "set" || !field || value === undefined) throw new Error(USAGE);
	if (field === "entry") {
		if (value !== "route" && value !== "routeStructured")
			throw new Error(USAGE);
		show(await client.configureRouter({ entry: value }));
		return 0;
	}
	if (field === "profile") {
		show(await client.configureRouter({ profile: value }));
		return 0;
	}
	if (field === "structureResource") {
		show(
			await client.configureRouter({
				structureResourceId: value === "none" ? null : value,
			}),
		);
		return 0;
	}
	if ((NUMBERS as readonly string[]).includes(field)) {
		const number = Number(value);
		if (!value.trim() || !Number.isFinite(number)) throw new Error(USAGE);
		show(await client.configureRouter({ [field]: number }));
		return 0;
	}
	throw new Error(USAGE);
};
