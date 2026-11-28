import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexRuntime } from "./codex-sdk";

/** The longest the CLI may take to print its catalog, and the most it may print. */
const CATALOG_MS = 10_000;
const CATALOG_BYTES = 8 << 20;

/**
 * Codex adds its own tools and agent-team text to every request by what its model catalog says of the model:
 * `tool_mode` (the code-mode `exec`/`wait` tools), `multi_agent_version` (the collaboration tools and the
 * `<multi_agent_role>`/`<multi_agent_mode>` messages), `experimental_supported_tools` and `apply_patch_tool_type`.
 * Eumenes uses none of them (a call is the host's text and a JSON choice), so the catalog a process reads has them
 * off for every model; everything else of each entry stays as Codex listed it. Null when `raw` is not a catalog.
 */
export function leanCatalog(raw: unknown): { models: unknown[] } | null {
	const models = (raw as { models?: unknown } | null)?.models;
	if (!Array.isArray(models) || !models.length) return null;
	const lean: unknown[] = [];
	for (const model of models) {
		if (
			!model ||
			typeof model !== "object" ||
			Array.isArray(model) ||
			typeof (model as { slug?: unknown }).slug !== "string"
		)
			return null;
		lean.push({
			...model,
			tool_mode: null,
			multi_agent_version: null,
			experimental_supported_tools: [],
			apply_patch_tool_type: null,
		});
	}
	return { models: lean };
}

/**
 * Writes the catalog a new process reads (`model_catalog_json`) from what the CLI itself lists under the same home
 * and login, so no model is named here. Returns the file's path, or the reason no catalog could be made (the process
 * then starts with Codex's own).
 */
export async function writeLeanCatalog(input: {
	runtime: CodexRuntime;
	home: { path: string; cwd: string };
	/** The `-c` overrides the process itself is given that decide which catalog the CLI reads. */
	overrides: readonly string[];
	credential: string | null;
}): Promise<{ path: string } | { reason: string }> {
	let text: string;
	try {
		text = await catalogText(input);
	} catch (error) {
		return {
			reason:
				error instanceof Error && /^catalog_[a-z_]+$/.test(error.message)
					? error.message
					: "catalog_failed",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { reason: "catalog_invalid" };
	}
	const lean = leanCatalog(parsed);
	if (!lean) return { reason: "catalog_invalid" };
	const path = join(
		input.home.path,
		`model-catalog-${crypto.randomUUID()}.json`,
	);
	try {
		await writeFile(path, JSON.stringify(lean), { mode: 0o600 });
	} catch {
		return { reason: "catalog_write_failed" };
	}
	return { path };
}

function catalogText(input: {
	runtime: CodexRuntime;
	home: { path: string; cwd: string };
	overrides: readonly string[];
	credential: string | null;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			input.runtime.command,
			["debug", "models", ...input.overrides.flatMap((o) => ["-c", o])],
			{
				cwd: input.home.cwd,
				env: {
					...input.runtime.env,
					CODEX_HOME: input.home.path,
					...(input.credential ? { CODEX_API_KEY: input.credential } : {}),
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const finish = (error: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				proc.kill("SIGKILL");
				reject(error);
			} else resolve(Buffer.concat(chunks).toString("utf8"));
		};
		const timer = setTimeout(
			() => finish(new Error("catalog_timeout")),
			CATALOG_MS,
		);
		proc.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > CATALOG_BYTES) finish(new Error("catalog_too_large"));
			else chunks.push(chunk);
		});
		proc.on("error", () => finish(new Error("catalog_unavailable")));
		proc.on("close", (code) =>
			finish(code === 0 ? null : new Error("catalog_unavailable")),
		);
	});
}
