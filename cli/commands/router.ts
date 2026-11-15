import type { CommandRun } from "./types";

const USAGE =
	"usage: router status | router set structureResource <resource id|none> | router set <structureTimeoutMs|feedbackNear|feedbackWeight> <number>";
const NUMBERS = [
	"structureTimeoutMs",
	"feedbackNear",
	"feedbackWeight",
] as const;

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const [sub, field, value] = args.positional;
	if (!sub || sub === "status") {
		show(await client.routerSettings());
		return 0;
	}
	if (sub !== "set" || !field || value === undefined) throw new Error(USAGE);
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
