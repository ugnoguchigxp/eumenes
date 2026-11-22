import { resolve } from "node:path";

/**
 * Record of the size of the fixed model inputs (system texts and tool definitions), kept in
 * api/application/fixed-input-size.json and checked by api/application/fixed-input-size.test.ts.
 *   bun scripts/fixed-input-size.ts            check against the record
 *   bun scripts/fixed-input-size.ts --write    record the current values (after an intended change)
 */
const root = resolve(import.meta.dir, "..");
const write = process.argv.includes("--write");
const result = Bun.spawnSync(
	[process.execPath, "test", "api/application/fixed-input-size.test.ts"],
	{
		cwd: root,
		env: { ...process.env, FIXED_INPUT_SIZE_WRITE: write ? "1" : "0" },
		stdout: "inherit",
		stderr: "inherit",
	},
);
process.exit(result.exitCode);
