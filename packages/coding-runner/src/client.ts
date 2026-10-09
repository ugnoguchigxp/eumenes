import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ZodType } from "zod";
import {
	protocolVersion,
	toolInputs,
	probeSchema,
	receiptSchema,
	inspectSchema,
	evidenceSchema,
	gitReceiptSchema,
	type RunnerTool,
	type ExecutionSpec,
	type RunnerPort,
} from "./contracts";

export async function connectRunner(input: {
	executable: string;
	serverPath: string;
	configPath: string;
}): Promise<RunnerPort> {
	const client = new Client({ name: "eumenes-coding", version: "0.1.0" });
	const transport = new StdioClientTransport({
		command: input.executable,
		args: [input.serverPath],
		env: {
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			EUMENES_CODING_RUNNER_CONFIG: input.configPath,
		},
		stderr: "ignore",
	});
	try {
		await client.connect(transport, { timeout: 10000 });
		const listed = await client.listTools();
		if (
			listed.tools.length !== Object.keys(toolInputs).length ||
			new Set(listed.tools.map((t) => t.name)).size !== listed.tools.length ||
			!listed.tools.every((t) => Object.hasOwn(toolInputs, t.name))
		)
			throw new Error("runner_protocol_mismatch");
	} catch {
		await client.close();
		throw new Error("runner_transport_unavailable");
	}
	async function call<T>(
		name: RunnerTool,
		args: unknown,
		schema: ZodType<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const parsed = toolInputs[name].parse(args);
		let result;
		try {
			result = await client.callTool({ name, arguments: parsed }, undefined, {
				timeout: 10000,
				signal,
			});
		} catch {
			throw new Error(
				signal?.aborted ? "runner_rpc_cancelled" : "runner_transport_unknown",
			);
		}
		if (
			!Array.isArray(result.content) ||
			result.content.length !== 1 ||
			result.content[0]?.type !== "text" ||
			typeof result.content[0].text !== "string" ||
			Buffer.byteLength(result.content[0].text) > 512 * 1024
		)
			throw new Error("runner_protocol_error");
		let value;
		try {
			value = JSON.parse(result.content[0].text);
		} catch {
			throw new Error("runner_protocol_error");
		}
		if (result.isError)
			throw new Error(
				typeof value?.code === "string" && /^runner_[a-z_]+$/.test(value.code)
					? value.code
					: "runner_operation_failed",
			);
		const output = schema.safeParse(value);
		if (!output.success) throw new Error("runner_protocol_error");
		return output.data;
	}
	return {
		probe: (workspaceId, signal) =>
			call(
				"runner.probe",
				{ version: protocolVersion, workspaceId },
				probeSchema,
				signal,
			),
		start: (specRef: string, spec: ExecutionSpec, signal) =>
			call(
				spec.kind === "continue" ? "runner.continue" : "runner.start",
				{
					version: protocolVersion,
					executionId: spec.executionId,
					operationId: spec.operationId,
					specRef,
				},
				receiptSchema,
				signal,
			),
		inspect: (executionId, afterSeq, limit, renewLease = false, signal) =>
			call(
				"runner.inspect",
				{ version: protocolVersion, executionId, afterSeq, limit, renewLease },
				inspectSchema,
				signal,
			),
		stop: (executionId, generation, operationId, reason, signal) =>
			call(
				"runner.stop",
				{
					version: protocolVersion,
					executionId,
					generation,
					operationId,
					reason,
				},
				receiptSchema,
				signal,
			),
		readEvidence: (executionId, evidenceRef, offset, limit, signal) =>
			call(
				"runner.read_evidence",
				{ version: protocolVersion, executionId, evidenceRef, offset, limit },
				evidenceSchema,
				signal,
			),
		close: () => client.close(),
		gitOperation: (specRef, operationId, signal) =>
			call(
				"runner.git_operation",
				{ version: protocolVersion, operationId, specRef },
				gitReceiptSchema,
				signal,
			),
	};
}
