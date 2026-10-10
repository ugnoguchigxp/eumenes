import { readFile } from "node:fs/promises";
import { requirementProfileData } from "../../api/domains/capabilities/contracts";
import type { CommandRun } from "./types";
export const run: CommandRun = async (args, { client, show }) => {
	const [sub, id, fileOrToken, token] = args.positional;
	if (sub === "list")
		show(
			await client.requirementProfiles({
				cursor: args.listCursor,
				limit: args.listLimit,
			}),
		);
	else if (sub === "show" && id) show(await client.requirementProfile(id));
	else if (sub === "import" && id && fileOrToken && token) {
		const text = await readFile(fileOrToken, "utf8");
		if (Buffer.byteLength(text) > 16384)
			throw new Error("invalid_requirement_profile");
		const data = requirementProfileData.safeParse(JSON.parse(text));
		if (!data.success) throw new Error("invalid_requirement_profile");
		show(
			await client.putRequirementProfile(id, {
				expectedStateToken: token === "new" ? null : token,
				data: data.data,
			}),
		);
	} else if ((sub === "enable" || sub === "disable") && id && fileOrToken)
		show(
			await client.setRequirementProfileState(id, {
				expectedStateToken: fileOrToken,
				enabled: sub === "enable",
			}),
		);
	else
		throw new Error(
			"usage: requirements list|show <id>|import <id> <file.json> <state-token-or-new>|disable <id> <state-token>|enable <id> <state-token>",
		);
	return 0;
};
