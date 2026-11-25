import { request } from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { RUNNER_FILE_MAX_BYTES } from "./contracts";
import {
	claudeEventsResponse,
	claudeNarrationResponse,
	claudeObservation,
	type ClaudeLease,
	type ClaudeRequest,
	type ClaudeStart,
} from "./claude-contracts";

export function claudeRunnerClient(socketPath: string, workspace: string) {
	let available = false;
	let supervised = false;
	let matchedWorkspace: boolean | null = null;
	function call(body: ClaudeRequest): Promise<unknown> {
		if (body.operation !== "health" && matchedWorkspace === false)
			return Promise.reject(new Error("claude_workspace_mismatch"));
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
						if (size > RUNNER_FILE_MAX_BYTES)
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
				supervised?: boolean;
			} | null;
			const matches = health?.workspace === realpathSync(workspace);
			matchedWorkspace = matches;
			available = matches && health?.ready === true;
			supervised = matches && health?.supervised === true;
		} catch {
			available = false;
			supervised = false;
		}
		return available;
	}
	return {
		ready: () => available,
		supportsSupervised: () => supervised,
		probe,
		async start(spec: ClaudeStart) {
			return claudeObservation.parse(await call({ operation: "start", spec }));
		},
		async inspect(id: string) {
			return claudeObservation
				.nullable()
				.parse(await call({ operation: "inspect", id }));
		},
		async events(id: string, after: number) {
			return claudeEventsResponse.parse(
				await call({ operation: "events", id, after }),
			);
		},
		async narration(id: string, after: number) {
			return claudeNarrationResponse.parse(
				await call({ operation: "narration", id, after }),
			);
		},
		async stop(
			id: string,
			operationId: string,
			supervised?: ClaudeStart["supervised"],
		) {
			return claudeObservation
				.nullable()
				.parse(await call({ operation: "stop", id, operationId, supervised }));
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
		async present(id: string, questionId: string, expiresAt: number) {
			claudeObservation.parse(
				await call({ operation: "present", id, questionId, expiresAt }),
			);
		},
		async recover(
			id: string,
			lease: ClaudeLease,
			proof: "process_exit" | "host_reboot",
		) {
			return claudeObservation.parse(
				await call({ operation: "recover", id, lease, proof }),
			);
		},
		async approveTool(id: string, requestId: string, lease: ClaudeLease) {
			await call({ operation: "approve_tool", id, requestId, lease });
		},
	};
}
