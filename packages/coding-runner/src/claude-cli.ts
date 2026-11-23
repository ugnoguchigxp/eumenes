import { readPrivate } from "./storage";
import { claudeDaemonConfigSchema } from "./claude-contracts";
import { createDefaultClaudePrepare } from "./claude-policy";
import { serveClaudeRunner } from "./claude-server";

const [command, location] = process.argv.slice(2);
if (command !== "serve" || !location) throw new Error("claude_cli_arguments");

const config = claudeDaemonConfigSchema.parse(
	JSON.parse(readPrivate(location)),
);
const { workspace, prepare } = createDefaultClaudePrepare(config);
const host = await serveClaudeRunner(config.root, workspace, prepare);

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, async () => {
		if (closing) return;
		closing = true;
		await host.close();
		process.exit(0);
	});
}

console.log(
	JSON.stringify({
		protocol: "eumenes-claude-code/1",
		socket: host.socket,
		workspace,
	}),
);
