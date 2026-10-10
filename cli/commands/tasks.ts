import {
	createTaskSchema,
	amendTaskSchema,
	answerTaskSchema,
} from "../../api/domains/tasks/contracts";
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional, explicitRequestId } = args;
	async function submitTaskCommand<T>(
		requestId: string,
		operation: () => Promise<T>,
	) {
		try {
			return await operation();
		} catch (error) {
			io.error(`Request ID: ${requestId}. Check task status before retrying.`);
			throw error;
		}
	}
	if (args.wait)
		throw new Error(
			"tasks commands return saved state; --wait is not supported",
		);
	const sub = positional.shift() ?? "list";
	if (sub === "list") {
		show(await client.workTasks(positional[0] ? { state: positional[0] } : {}));
		return 0;
	}
	if (sub === "show" && positional[0]) {
		show(await client.workTask(positional[0]));
		return 0;
	}
	if (sub === "events" && positional[0]) {
		show(await client.workTaskEvents(positional[0], positional[1] ?? "0"));
		return 0;
	}
	const requestId = explicitRequestId ?? crypto.randomUUID();
	if (sub === "create" && positional[0]) {
		const body: unknown = await Bun.file(positional[0]).json();
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new Error("invalid_task_input");
		const parsed = createTaskSchema.safeParse({
			...body,
			requestId:
				explicitRequestId ?? ("requestId" in body ? body.requestId : requestId),
		});
		if (!parsed.success) throw new Error("invalid_task_input");
		show(
			await submitTaskCommand(parsed.data.requestId, () =>
				client.createTask(parsed.data),
			),
		);
		return 0;
	}
	const [taskId, revisionText] = positional;
	const expectedRevision = Number(revisionText);
	if (
		!taskId ||
		revisionText === undefined ||
		!Number.isSafeInteger(expectedRevision) ||
		expectedRevision < 0
	)
		throw new Error(
			"usage: tasks list [state]|show <id>|events <id> [cursor]|create <json>|start <id> <revision>|stop <id> <revision> <pause|cancel>|answer <id> <revision> <questionId> <answer>|amend <id> <revision> <grant-json>|forget <id> <revision>",
		);
	if (sub === "forget") {
		show(
			await submitTaskCommand(requestId, () =>
				client.forgetTask(taskId, requestId, expectedRevision),
			),
		);
		return 0;
	}
	if (sub === "start") {
		show(
			await submitTaskCommand(requestId, () =>
				client.startTask(taskId, requestId, expectedRevision),
			),
		);
		return 0;
	}
	if (
		sub === "stop" &&
		(positional[2] === "pause" || positional[2] === "cancel")
	) {
		show(
			await submitTaskCommand(requestId, () =>
				client.stopTask(
					taskId,
					requestId,
					expectedRevision,
					positional[2] as "pause" | "cancel",
				),
			),
		);
		return 0;
	}
	if (sub === "answer") {
		const parsed = answerTaskSchema.safeParse({
			requestId,
			expectedRevision,
			questionId: positional[2],
			answer: positional.slice(3).join(" "),
		});
		if (!parsed.success) throw new Error("invalid_task_input");
		show(
			await submitTaskCommand(requestId, () =>
				client.answerTask(taskId, parsed.data),
			),
		);
		return 0;
	}
	if (sub === "amend" && positional[2]) {
		const parsed = amendTaskSchema.safeParse({
			requestId,
			expectedRevision,
			grant: await Bun.file(positional[2]).json(),
		});
		if (!parsed.success) throw new Error("invalid_task_input");
		show(
			await submitTaskCommand(requestId, () =>
				client.amendTask(taskId, parsed.data),
			),
		);
		return 0;
	}
	throw new Error("invalid_tasks_command");
};
