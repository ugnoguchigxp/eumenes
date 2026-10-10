import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional, explicitRequestId } = args;
	const sub = positional.shift();
	const issuedAt = new Date().toISOString();
	if (!sub || sub === "list") {
		show(await client.timers());
		return 0;
	}
	if (sub === "show") {
		const id = positional[0];
		if (!id) throw new Error("usage: timer show <id>");
		show(await client.timer(id));
		return 0;
	}
	if (!explicitRequestId)
		throw new Error("timer start and cancel require --request-id <UUID>");
	if (sub === "start") {
		const durationSeconds = Number(positional[0]);
		if (!Number.isInteger(durationSeconds))
			throw new Error("usage: timer start <seconds> --request-id <UUID>");
		show(
			await client.startTimer({
				requestId: explicitRequestId,
				issuedAt,
				durationSeconds,
				label: positional[1],
			}),
		);
		return 0;
	}
	if (sub === "cancel") {
		const id = positional[0];
		const expectedRevision = Number(positional[1]);
		if (!id || !Number.isInteger(expectedRevision))
			throw new Error(
				"usage: timer cancel <id> <revision> --request-id <UUID>",
			);
		show(
			await client.cancelTimer(id, {
				requestId: explicitRequestId,
				issuedAt,
				expectedRevision,
			}),
		);
		return 0;
	}
	throw new Error(
		"usage: timer start <seconds> | list | show <id> | cancel <id> <revision>",
	);
};
