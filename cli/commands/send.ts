import type { Run } from "../../api/domains/dialogue/contracts";
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client } = io;
	const content = args.positional.join(" ") || (await Bun.stdin.text());
	if (!content.trim()) throw new Error("message required");
	const requestId = args.explicitRequestId ?? crypto.randomUUID();
	let submitted: Run;
	try {
		submitted = await client.submit({
			requestId,
			conversationId: args.conversationId,
			text: content.trim(),
		});
	} catch (error) {
		io.error(`Request ID: ${requestId}. Check status before retrying.`);
		throw error;
	}
	if (!args.wait) {
		io.show(submitted);
		return 0;
	}
	let cancelled = false;
	const onSignal = () => {
		cancelled = true;
		void client.cancel(submitted.id).catch(() => {});
	};
	process.once("SIGINT", onSignal);
	try {
		// Wait until the run's own deadline (queue wait + inference) plus a short margin.
		const waitUntil =
			(submitted.deadlineAt
				? Date.parse(submitted.deadlineAt)
				: Date.now() + 180_000) + 10_000;
		while (Date.now() < waitUntil) {
			const current = await client.run(submitted.id);
			if (!["queued", "running"].includes(current.status)) {
				io.show(current);
				return current.status === "completed"
					? 0
					: current.status === "cancelled"
						? 4
						: 3;
			}
			if (cancelled) {
				io.error(
					`run ${submitted.id}: cancellation requested; outcome unconfirmed`,
				);
				return 4;
			}
			await Bun.sleep(500);
		}
		await client.cancel(submitted.id).catch(() => {});
		io.error(
			`run ${submitted.id}: timeout; cancellation requested, outcome unconfirmed`,
		);
		return 4;
	} finally {
		process.removeListener("SIGINT", onSignal);
	}
};
