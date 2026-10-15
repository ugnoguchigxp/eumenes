import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readPrivate } from "./storage";
import { sdkGitPhaseSchema } from "./sdk-git-contracts";
import { executeSdkGitPhase } from "./sdk-git-operations";
const file = process.argv[2];
if (!file) throw new Error("sdk_git_grant_missing");
const grant = sdkGitPhaseSchema.parse(JSON.parse(readPrivate(file)));
const server = new McpServer({
	name: "eumenes-approved-git",
	version: "1.0.0",
});
const run = (message: string) => {
	try {
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(executeSdkGitPhase(grant, message)),
				},
			],
		};
	} catch (error) {
		const code =
			error instanceof Error && /^(sdk_git|runner)_[a-z_]+$/.test(error.message)
				? error.message
				: "sdk_git_failed";
		return {
			isError: true,
			content: [{ type: "text" as const, text: JSON.stringify({ code }) }],
		};
	}
};
if (grant.phase === "commit")
	server.registerTool(
		"approved_commit",
		{
			description:
				"Commit only the exact bytes/files confirmed by the person. Choose a concise message. No push or other changes.",
			inputSchema: z.object({ message: z.string().min(1).max(8000) }).strict(),
		},
		async ({ message }) => run(message),
	);
else
	server.registerTool(
		"approved_push",
		{
			description:
				"Push the already verified commit to the exact registered remote/ref confirmed by the person. No new commit, force, tags, or other destination.",
			inputSchema: z.object({}).strict(),
		},
		async () => run(""),
	);
await server.connect(new StdioServerTransport());
