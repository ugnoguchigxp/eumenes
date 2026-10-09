import { serve } from "./mcp";
if (import.meta.main) {
	const configPath = process.env.EUMENES_CODING_RUNNER_CONFIG;
	if (!configPath) process.exit(2);
	await serve(configPath);
}
