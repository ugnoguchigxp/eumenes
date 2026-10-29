import type { CommandRun } from "./types";

const USAGE =
	"usage: intent status | intent set mode <legacy|shadow|ruri> | intent set profile <profile> | intent set timeoutMs <ms> | intent set searchScore <0..1> | intent clear-profile";

/**
 * The user-intent judge's settings (the intent gate design, section 7): the mode, the saved LARM Agent Profile and
 * the routing policy. The speaking-attitude judge's settings are not touched.
 */
export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const [sub, field, value] = args.positional;
	if (!sub || sub === "status") {
		show(await client.intentSettings());
		return 0;
	}
	if (sub === "clear-profile") {
		show(await client.configureIntent({ profile: null }));
		return 0;
	}
	if (sub !== "set" || !field || value === undefined) throw new Error(USAGE);
	if (field === "mode") {
		if (value !== "legacy" && value !== "shadow" && value !== "ruri")
			throw new Error(USAGE);
		show(await client.configureIntent({ mode: value }));
		return 0;
	}
	if (field === "profile") {
		show(await client.configureIntent({ profile: value }));
		return 0;
	}
	if (field === "timeoutMs" || field === "searchScore") {
		const number = Number(value);
		if (!Number.isFinite(number)) throw new Error(USAGE);
		show(await client.configureIntent({ [field]: number }));
		return 0;
	}
	throw new Error(USAGE);
};
