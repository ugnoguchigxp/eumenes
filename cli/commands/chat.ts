import { createInterface } from "node:readline";
import { createChatSession } from "../chat-session";
import { cliFailure } from "../failure";
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	if (
		args.positional.length ||
		args.toolchainId ||
		args.explicitRequestId ||
		args.wait ||
		args.listCursor ||
		args.listLimit !== undefined ||
		args.historyBefore !== undefined ||
		args.historyAfter !== undefined ||
		Object.keys(args.historyOptions ?? {}).length
	)
		throw new Error("usage: chat [--conversation ID] [--json]");
	const lifetime = new AbortController();
	let exitCode = 0;
	let lines: ReturnType<typeof createInterface> | undefined;
	const terminal = !!process.stdin.isTTY && !args.json;
	const session = createChatSession({
		client: io.client,
		conversationId: args.conversationId,
		signal: lifetime.signal,
		message(message, updated) {
			const { kind, ...record } = message;
			if (terminal && lines) process.stdout.write("\r\x1b[2K");
			io.show(
				args.json
					? { type: kind ?? "message", updated, ...record }
					: `${message.role === "user" ? "あなた" : (message.attribution?.displayName ?? "Eumenes")}${updated ? "（更新）" : ""}: ${message.text}\n`,
			);
			if (terminal && lines) lines.prompt(true);
		},
		error: io.error,
	});
	const stop = () => {
		lifetime.abort();
		lines?.close();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await session.start();
		if (lifetime.signal.aborted) return 0;
		lines = createInterface({
			input: process.stdin,
			output: terminal ? process.stdout : undefined,
			terminal,
			prompt: "> ",
		});
		lines.on("SIGINT", stop);
		if (terminal) {
			io.error(
				`会話: ${args.conversationId} / /exit で終了。Ctrl+Cで閉じても受付済みの仕事は続きます。`,
			);
			lines.prompt();
		}
		for await (const line of lines) {
			if (lifetime.signal.aborted) break;
			const text = line.trim();
			if (text === "/exit" || text === "/quit") break;
			if (text) {
				try {
					const status = await session.send(text);
					if (status !== "completed") {
						exitCode = status === "cancelled" ? 4 : 3;
						if (!terminal) break;
					}
				} catch (error) {
					if (lifetime.signal.aborted) break;
					const failure = cliFailure(error, 3);
					exitCode = failure.exitCode;
					for (const line of failure.lines) io.error(line);
					if (!terminal) break;
				}
			}
			if (terminal && !lifetime.signal.aborted) lines.prompt();
		}
		return exitCode;
	} catch (error) {
		if (!lifetime.signal.aborted) throw error;
		return 0;
	} finally {
		stop();
		session.stop();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
};
