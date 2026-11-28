import { join } from "node:path";
import { ClaudeService } from "./claude-service";
import { runClaudeExecution } from "./claude-engine";
import { servePrivateRunner } from "./sdk-server";

/** The native SDK and all process control remain in the caller's independent runner process. */
export async function serveClaudeRunner(
	root: string,
	workspace: string,
	prepare: ConstructorParameters<typeof ClaudeService>[2],
	idle?: { ms: number; exit(): void },
) {
	const service = new ClaudeService(
		root,
		workspace,
		prepare,
		runClaudeExecution,
		idle,
	);
	try {
		return await servePrivateRunner(
			join(service.root, "claude.sock"),
			"/claude",
			service,
			"claude",
		);
	} catch (error) {
		await service.close();
		throw error;
	}
}
