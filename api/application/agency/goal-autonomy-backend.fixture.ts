import { writeFileSync } from "node:fs";
import { createAgendaGoalStore } from "./goal-agenda";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { loadProcessConfig } from "../../infrastructure/config";
import { createApp } from "../app";
import { appModules } from "../app-modules";
import { createLifecycleRunner } from "../lifecycle";
import { appServices } from "../server-app-services";
import { createLifecycles } from "../server-lifecycles";
import { buildServices } from "../server-services";

const config = loadProcessConfig();
if (!config.apiToken || !config.goalWorkspaces || !process.argv[2])
	throw new Error("goal_acceptance_isolation_missing");
const s = await buildServices(config);
const goals = createAgendaGoalStore(s.store, s.goalLedger);
const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
const runner = createLifecycleRunner(
	createLifecycles(s, { name: "fixture-http", close: async () => {} }),
);
await runner.recoverAll();
await runner.startAll();
const app = createApp({
	token: config.apiToken,
	origin: config.origin,
	modules: [
		...appModules(appServices(s)),
		{
			mount(app) {
				app.get("/api/goal-acceptance-observation", (c) =>
					c.json(
						s.store.read((db) => ({
							rows: goals.progressRowsInTransaction(db).map((row) => ({
								...row,
								attempts: goals.goalAttemptsInTransaction(db, access, row),
							})),
							reports: goals.goalReportsInTransaction(db, access),
							mockWork: goals.work(PRINCIPAL).length,
							workers: db
								.query(
									"SELECT id, run_id AS dispatchId, owner_key AS goalId FROM development_supervision_work WHERE owner_kind='goal' ORDER BY rowid",
								)
								.all(),
							children: db
								.query(
									`SELECT id, json_extract(data, '$.source.delegation.parentWorkId') AS parentId,
					coalesce(json_extract(data, '$.executionId'), json_extract(data, '$.observation.executionId'), json_extract(data, '$.previousId')) AS executionId, json_extract(data, '$.observation.state') AS runnerState,
							json_extract(data, '$.observation.structuredEvidence') AS evidence,
					json_extract(data, '$.executions') AS executions FROM claude_code_work WHERE json_type(data, '$.source.goal')='object'`,
								)
								.all(),
							runnerReady:
								s.toolchain.claudeCode?.supervisedAvailableInTransaction(
									true,
								) ?? false,
						})),
					),
				);
			},
		},
	],
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
writeFileSync(process.argv[2], String(server.port), { mode: 0o600 });
process.once("SIGTERM", async () => {
	await server.stop(true);
	const ok = await runner.closeAll(10_000);
	process.exit(ok ? 0 : 1);
});
