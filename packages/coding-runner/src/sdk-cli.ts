import { readPrivate } from "./storage";
import { sdkConfigSchema, sdkSpecSchema } from "./sdk-contracts";
import { sdkRunnerClient } from "./sdk-client";
import { SdkService } from "./sdk-service";
import { serveSdk } from "./sdk-server";

const [command, location, ...args] = process.argv.slice(2);
if (!location) throw new Error("sdk_cli_arguments");
if (command === "serve") {
	const service = new SdkService(
		sdkConfigSchema.parse(JSON.parse(readPrivate(location))),
	);
	const host = await serveSdk(service);
	let closing = false;
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, async () => {
			if (closing) return;
			closing = true;
			await host.close();
			process.exit(0);
		});
	console.log(
		JSON.stringify({
			protocol: "eumenes-codex-sdk/1",
			socket: host.socket,
			epoch: service.epoch,
		}),
	);
} else {
	const client = sdkRunnerClient(location);
	const id = args[0];
	if (!id && command !== "list") throw new Error("sdk_cli_arguments");
	const result =
		command === "list"
			? await client.list()
			: command === "start"
				? await client.start(sdkSpecSchema.parse(JSON.parse(readPrivate(id!))))
				: command === "inspect"
					? await client.inspect(id!)
					: command === "recover"
						? await client.recover(id!)
						: command === "events"
							? await client.events(id!, Number(args[1] ?? 0))
							: command === "stop" && args[1]
								? await client.stop(id!, args[1])
								: command === "release" && args[1]
									? await client.release(id!, args[1])
									: (() => {
											throw new Error("sdk_cli_arguments");
										})();
	console.log(JSON.stringify(result));
}
