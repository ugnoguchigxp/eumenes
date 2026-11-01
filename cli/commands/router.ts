import type { CommandRun } from "./types";

const USAGE =
	"usage: router status | router set mode <off|shadow|on> | router set profile <profile> | router set timeoutMs <ms> | router set <accept|low|margin|approve|multi|feedbackNear> <0..1> | router set feedbackWeight <0..5> | router clear-profile";

const NUMBERS = [
	"timeoutMs",
	"accept",
	"low",
	"margin",
	"approve",
	"multi",
	"feedbackNear",
	"feedbackWeight",
] as const;

/**
 * The router's settings (spec toolchain-router-redesign §3.3): the mode, the saved LARM Agent Profile, the wait for
 * one call and the decision table's thresholds. The intent judge's and the speaking-attitude judge's are not touched.
 */
export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const [sub, field, value] = args.positional;
	if (!sub || sub === "status") {
		show(await client.routerSettings());
		return 0;
	}
	if (sub === "clear-profile") {
		show(await client.configureRouter({ profile: null }));
		return 0;
	}
	if (sub !== "set" || !field || value === undefined) throw new Error(USAGE);
	if (field === "mode") {
		if (value !== "off" && value !== "shadow" && value !== "on")
			throw new Error(USAGE);
		show(await client.configureRouter({ mode: value }));
		return 0;
	}
	if (field === "profile") {
		show(await client.configureRouter({ profile: value }));
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
