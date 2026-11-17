import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const id = args.positional[0];
	if (!id) throw new Error("run ID required");
	if (args.context) {
		const list = await io.client.runContext(id);
		const selected = list.captures.find((entry) =>
			args.contextCall === undefined
				? entry.id === list.preferredId
				: entry.number === args.contextCall,
		);
		if (args.contextCall !== undefined && !selected)
			throw new Error("run_context_call_unavailable");
		io.show({
			...list,
			capture: selected?.available
				? await io.client.contextCapture(id, selected.id)
				: null,
		});
		return 0;
	}
	if (args.errorReport) {
		// Plain text for pasting; `--json` quotes it like any other string result.
		io.show((await io.client.runErrorReport(id)).text);
		return 0;
	}
	io.show(await io.client.run(id));
	return 0;
};
