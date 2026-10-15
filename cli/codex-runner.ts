import { resolve } from "node:path";
import { sdkRunnerClient } from "../packages/coding-runner/src/sdk-client";
/** Recovery control calls the independent runner API; it never opens Eumenes' database. */
export async function codexRunnerCli(args: string[]) {
	const socketIndex = args.indexOf("--socket");
	const socket =
		socketIndex < 0
			? resolve(import.meta.dir, "../data/codex-sdk-runner/sdk.sock")
			: args[socketIndex + 1];
	if (!socket) throw new Error("--socket requires a path");
	const positional =
		socketIndex < 0
			? args
			: args.filter((_, i) => i !== socketIndex && i !== socketIndex + 1);
	const [command, id, cursorOrOperationId] = positional;
	const client = sdkRunnerClient(socket);
	if (!id && command !== "list")
		throw new Error(
			"usage: codex-runner list|inspect <executionId>|events <executionId> [afterSeq]|stop <executionId> [operationId]|recover <executionId> [--socket path]",
		);
	const result =
		command === "list"
			? await client.list()
			: command === "inspect"
				? await client.inspect(id!)
				: command === "events"
					? await client.events(id!, Number(cursorOrOperationId ?? 0))
					: command === "stop"
						? await client.stop(id!, cursorOrOperationId ?? crypto.randomUUID())
						: command === "recover"
							? await client.recover(id!)
							: (() => {
									throw new Error("Unknown codex-runner command");
								})();
	console.log(JSON.stringify(result, null, 2));
}
