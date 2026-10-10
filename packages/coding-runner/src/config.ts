import { z } from "zod";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { id, digestSchema } from "./contracts";
import { digest, readPrivate } from "./storage";

const absolute = z.string().refine(isAbsolute);
const configSchema = z.strictObject({
	spoolRoot: absolute,
	codexExecutable: absolute,
	codexDigest: digestSchema,
	// Fixture is usable only by the test entry, never by the production MCP server.
	mode: z.enum(["production", "fixture"]).default("production"),
	workspaces: z
		.array(
			z.strictObject({
				id,
				path: absolute,
				commonGitDir: absolute,
				repositoryIdentity: z.strictObject({
					dev: z.number().int(),
					ino: z.number().int(),
				}),
				baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
				branch: z.string().regex(/^codex\/[a-zA-Z0-9_-]+$/),
				remotes: z
					.array(
						z.strictObject({
							id,
							name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
							url: z.string().min(1).max(2048),
						}),
					)
					.max(10)
					.refine(
						(v) =>
							new Set(v.map((r) => r.id)).size === v.length &&
							new Set(v.map((r) => r.name)).size === v.length,
					)
					.default([]),
			}),
		)
		.max(100)
		.refine(
			(v) =>
				new Set(v.map((w) => w.id)).size === v.length &&
				new Set(v.map((w) => w.path)).size === v.length,
		),
	fixtureLimits: z
		.strictObject({
			leaseMs: z.number().int().min(100).max(120000),
			graceMs: z.number().int().min(10).max(5000),
			maxLineBytes: z.number().int().min(128).max(1048576),
			maxRunBytes: z.number().int().min(1024).max(20971520),
			finalEventDelayMs: z.number().int().min(50).max(1000).optional(),
		})
		.optional(),
});
export type RunnerConfig = z.infer<typeof configSchema>;
export function loadConfig(path: string, fixtureAllowed = false): RunnerConfig {
	const config = configSchema.parse(JSON.parse(readPrivate(path)));
	if (config.mode === "fixture" && !fixtureAllowed)
		throw new Error("runner_fixture_forbidden");
	if (config.mode !== "fixture" && config.fixtureLimits)
		throw new Error("runner_fixture_forbidden");
	if (config.spoolRoot === dirname(path))
		throw new Error("runner_config_inside_spool");
	return config;
}
export function childEnvironment(
	config: RunnerConfig,
	executionId: string,
	sessionHomeId = executionId,
) {
	// No inherited HOME, CODEX_HOME, credentials, SSH agent, proxies or backend tokens.
	return {
		PATH: "/usr/bin:/bin",
		LANG: "en_US.UTF-8",
		HOME: join(config.spoolRoot, "runs", executionId, "home"),
		CODEX_HOME: join(config.spoolRoot, "runs", sessionHomeId, "home", ".codex"),
	};
}
export function validateExecutable(config: RunnerConfig) {
	const path = realpathSync(config.codexExecutable);
	if (path !== config.codexExecutable || !statSync(path).isFile())
		throw new Error("runner_executable_changed");
	if (digest(readFileSync(path)) !== config.codexDigest)
		throw new Error("runner_executable_changed");
}
