import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolInputs } from "./contracts";
import { createRunner } from "./core";
import { executeGit } from "./git-operations";

export async function serve(configPath: string, fixtureAllowed = false) {
	const runner = createRunner(configPath, fixtureAllowed);
	const server = new McpServer({
		name: "eumenes-coding-runner",
		version: "0.1.0",
	});
	for (const [name, schema] of Object.entries(toolInputs))
		server.registerTool(
			name,
			{
				description:
					"Fixed host operation on an administrator-registered coding execution.",
				inputSchema: schema,
			},
			async (raw: unknown) => {
				try {
					const input = schema.parse(raw);
					let value: unknown;
					switch (name) {
						case "runner.probe": {
							const p = toolInputs["runner.probe"].parse(input);
							value = await runner.probe(p.workspaceId);
							break;
						}
						case "runner.start":
						case "runner.continue": {
							const p = toolInputs["runner.start"].parse(input);
							value = await runner.start(
								p.specRef,
								p.operationId,
								p.executionId,
								name === "runner.continue",
							);
							break;
						}
						case "runner.inspect": {
							const p = toolInputs["runner.inspect"].parse(input);
							value = runner.inspect(
								p.executionId,
								p.afterSeq,
								p.limit,
								p.renewLease,
							);
							break;
						}
						case "runner.stop": {
							const p = toolInputs["runner.stop"].parse(input);
							value = runner.stop(
								p.executionId,
								p.generation,
								p.operationId,
								p.reason,
							);
							break;
						}
						case "runner.read_evidence": {
							const p = toolInputs["runner.read_evidence"].parse(input);
							value = runner.readEvidence(
								p.executionId,
								p.evidenceRef,
								p.offset,
								p.limit,
							);
							break;
						}
						case "runner.git_operation": {
							const p = toolInputs["runner.git_operation"].parse(input);
							value = executeGit(runner.config, p.specRef, p.operationId);
							break;
						}
						default:
							throw new Error("runner_unknown_tool");
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(value) }],
					};
				} catch (error) {
					// Only known symbolic codes. Never include native messages, paths, instructions or provider text.
					const code =
						error instanceof Error && /^runner_[a-z_]+$/.test(error.message)
							? error.message
							: "runner_invalid_request";
					return {
						isError: true,
						content: [
							{ type: "text" as const, text: JSON.stringify({ code }) },
						],
					};
				}
			},
		);
	await server.connect(new StdioServerTransport());
	return server;
}
