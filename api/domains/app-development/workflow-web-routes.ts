import type { Database } from "bun:sqlite";

export type WorkflowWebRouteKey = {
	scope: string;
	workflowId: string;
	revision: number;
	stepId: string;
	target: string;
};

const columns = (
	key: WorkflowWebRouteKey,
): [string, string, number, string, string] => [
	key.scope,
	key.workflowId,
	key.revision,
	key.stepId,
	key.target,
];

export function readWorkflowWebRoute(db: Database, key: WorkflowWebRouteKey) {
	return (
		db
			.query<{ url: string }, ReturnType<typeof columns>>(
				"SELECT url FROM app_development_web_routes WHERE scope=? AND workflow_id=? AND revision=? AND step_id=? AND target_key=?",
			)
			.get(...columns(key))?.url ?? null
	);
}

export function rememberWorkflowWebRoute(
	db: Database,
	key: WorkflowWebRouteKey,
	url: string,
) {
	db.run(
		`INSERT INTO app_development_web_routes(scope,workflow_id,revision,step_id,target_key,url) VALUES(?,?,?,?,?,?)
		 ON CONFLICT(scope,workflow_id,revision,step_id,target_key) DO UPDATE SET url=excluded.url`,
		[...columns(key), url],
	);
}

export function forgetWorkflowWebRoute(
	db: Database,
	key: WorkflowWebRouteKey,
	url: string,
) {
	db.run(
		"DELETE FROM app_development_web_routes WHERE scope=? AND workflow_id=? AND revision=? AND step_id=? AND target_key=? AND url=?",
		[...columns(key), url],
	);
}
