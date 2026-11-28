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
let closing = false;
async function stop() {
	if (closing) return;
	closing = true;
	await host.close();
	process.exit(0);
}
const host = await serveClaudeRunner(
	config.root,
	workspace,
	prepare,
	config.idleMs ? { ms: config.idleMs, exit: () => void stop() } : undefined,
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, stop);
}

console.log(
	JSON.stringify({
		protocol: "eumenes-claude-code/1",
		socket: host.socket,
		workspace,
	}),
);
