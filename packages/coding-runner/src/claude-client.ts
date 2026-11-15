import { request } from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
	claudeObservation,
	type ClaudeRequest,
	type ClaudeStart,
} from "./claude-contracts";

export function claudeRunnerClient(socketPath: string, workspace: string) {
	let available = false;
	function call(body: ClaudeRequest): Promise<unknown> {
		const parent = lstatSync(dirname(socketPath));
		const socket = lstatSync(socketPath);
		const uid = process.getuid?.();
		if (
			!parent.isDirectory() ||
			parent.uid !== uid ||
			(parent.mode & 0o077) !== 0 ||
			!socket.isSocket() ||
			socket.uid !== uid ||
			(socket.mode & 0o077) !== 0
		)
			return Promise.reject(new Error("claude_socket_unsafe"));
		return new Promise((resolve, reject) => {
			const req = request(
				{ socketPath, path: "/claude", method: "POST", timeout: 2000 },
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > 64 * 1024)
							req.destroy(new Error("claude_response_limit"));
						else chunks.push(chunk);
					});
					res.on("error", reject);
					res.on("end", () => {
						try {
							const value = JSON.parse(Buffer.concat(chunks).toString());
							if (res.statusCode === 200) resolve(value);
							else reject(new Error("claude_runner_rejected"));
						} catch {
							reject(new Error("claude_response_invalid"));
						}
					});
				},
			);
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("claude_runner_timeout")));
			req.end(JSON.stringify(body));
		});
	}
	async function probe() {
		try {
			const health = (await call({ operation: "health" })) as {
				ready?: boolean;
				workspace?: string;
			} | null;
			available =
				health?.ready === true && health.workspace === realpathSync(workspace);
		} catch {
			available = false;
		}
		return available;
	}
	return {
		ready: () => available,
		probe,
		async start(spec: ClaudeStart) {
			return claudeObservation.parse(await call({ operation: "start", spec }));
		},
		async inspect(id: string) {
			return claudeObservation
				.nullable()
				.parse(await call({ operation: "inspect", id }));
		},
		async stop(id: string, operationId: string) {
			return claudeObservation
				.nullable()
				.parse(await call({ operation: "stop", id, operationId }));
		},
		async reply(
			id: string,
			operationId: string,
			questionId: string,
			answer: string,
		) {
			return claudeObservation.parse(
				await call({ operation: "reply", id, operationId, questionId, answer }),
			);
		},
	};
}
