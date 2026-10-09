import { serve } from "../src/mcp";
const config = process.env.EUMENES_CODING_RUNNER_CONFIG;
if (!config) process.exit(2);
await serve(config, true);
