import { readPrivate } from "../../packages/coding-runner/src/storage";
import { sdkRunnerClient } from "../../packages/coding-runner/src/sdk-client";
import { sdkSpecSchema } from "../../packages/coding-runner/src/sdk-contracts";

const [socket, input] = process.argv.slice(2);
if (!socket || !input) throw new Error("fixture_arguments");
const receipt = await sdkRunnerClient(socket).start(
	sdkSpecSchema.parse(JSON.parse(readPrivate(input))),
);
console.log(
	JSON.stringify({ executionId: receipt.executionId, epoch: receipt.epoch }),
);
// The acceptance client stands in for the backend port; it owns no SDK iterator.
await Bun.sleep(60_000);
