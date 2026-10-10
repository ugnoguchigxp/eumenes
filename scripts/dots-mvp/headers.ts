import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Codex's header helper reads the private local credential without putting it in config.toml.
if (import.meta.main) {
	const directory =
		process.argv[2] ?? join(homedir(), ".local", "state", "eumenes-dots-mvp");
	const token = readFileSync(join(directory, "admin.token"), "utf8");
	process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
}
