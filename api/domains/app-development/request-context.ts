import type { Database } from "bun:sqlite";
import type { Migration } from "../../infrastructure/sqlite";

export type AppRequestSource =
	| {
			kind: "message";
			conversationId: string;
			messageId: string;
			digest: string;
	  }
	| { kind: "ui"; operationId: string; digest: string; urls: string[] };
export type AppRequestContext = {
	revision: number;
	current: string;
	sources: AppRequestSource[];
};

export const requestContextMigration: Migration = {
	id: "app-development/0004-request-context",
	after: ["app-development/0003-storage-lifecycle"],
	sql: `ALTER TABLE app_development_works ADD COLUMN request_context_json TEXT;
ALTER TABLE app_development_storage ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;`,
};

export function saveRequestContext(
	db: Database,
	scope: string,
	workRef: string,
	context: AppRequestContext | null,
) {
	db.run(
		"UPDATE app_development_works SET request_context_json=? WHERE scope=? AND id=?",
		[context ? JSON.stringify(context) : null, scope, workRef],
	);
}

/** Parse explicit HTTP(S) tokens; a prefix of a cited URL is not a new confirmed URL. */
function trimUrlBoundary(token: string) {
	let value = token.replace(/[,，;；]+$/u, "");
	const pairs: Record<string, string> = { ")": "(", "]": "[", "）": "（" };
	const balance = new Map(Object.keys(pairs).map((close) => [close, 0]));
	for (const character of value) {
		for (const [close, open] of Object.entries(pairs)) {
			if (character === open) balance.set(close, balance.get(close)! + 1);
			if (character === close) balance.set(close, balance.get(close)! - 1);
		}
	}
	while ((balance.get(value.at(-1) ?? "") ?? 0) < 0) {
		const close = value.at(-1)!;
		value = value.slice(0, -1);
		balance.set(close, balance.get(close)! + 1);
	}
	return value;
}

export function requestUrls(text: string) {
	return [
		...new Set(
			(text.match(/https?:\/\/[^\s<>"'`「」『』、。]+/gu) ?? []).flatMap(
				(value) => {
					try {
						return [new URL(trimUrlBoundary(value)).href];
					} catch {
						return [];
					}
				},
			),
		),
	];
}
