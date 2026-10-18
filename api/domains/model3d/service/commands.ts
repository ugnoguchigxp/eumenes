import type { Database } from "bun:sqlite";
import type { Model3dGeneration, Model3dSource } from "../contracts";
import {
	FOCUS_SLOT,
	findAssets,
	focusOf,
	knownAsset,
	listGenerations,
	ownedGeneration,
	pendingOperations,
	recentAssets,
	setFocus,
} from "../repository";

export type Model3dOperation =
	| "open"
	| "generate"
	| "find"
	| "show"
	| "update"
	| "delete"
	| "cancel";
export type Model3dCommandInput = {
	prompt?: string;
	title?: string;
	tags?: string[];
	sourceImageRef?: string;
	query?: string;
	assetRef?: string;
	generationRef?: string;
};

/** The conversation's operations: each one is stored with its request ID and replayed unchanged. */
export function createModel3dCommands(deps: {
	createInTransaction(
		db: Database,
		input: {
			owner: string;
			conversationId: string;
			origin: "conversation";
			requestId: string;
			title: string;
			tags: string[];
			source: Model3dSource;
		},
	): Model3dGeneration;
	cancelInTransaction(
		db: Database,
		owner: string,
		id: string,
	): Model3dGeneration;
	enqueueOperation(db: Database, row: { id: string; assetId: string }): void;
}) {
	function asset(db: Database, owner: string, id: string | undefined) {
		const a = id ? knownAsset(db, owner, id) : null;
		if (!a) throw new Error("model3d_asset_not_found");
		return a;
	}
	function operation(
		db: Database,
		owner: string,
		conversationId: string,
		kind: "update" | "delete",
		assetId: string,
		patch: { title?: string; tags?: string[] } | null,
	) {
		const id = crypto.randomUUID();
		const now = Date.now();
		db.query(
			"INSERT INTO model3d_operations(id,owner,conversation_id,kind,asset_id,patch_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
		).run(
			id,
			owner,
			conversationId,
			kind,
			assetId,
			patch ? JSON.stringify(patch) : null,
			"pending",
			now,
			now,
		);
		deps.enqueueOperation(db, { id, assetId });
	}
	function run(
		db: Database,
		owner: string,
		conversationId: string,
		op: Model3dOperation,
		input: Model3dCommandInput,
		requestId: string,
	): unknown {
		switch (op) {
			case "open":
				return { action: "open", state: "ready" };
			case "generate": {
				const source: Model3dSource = input.sourceImageRef
					? { type: "image-artifact", id: input.sourceImageRef }
					: { type: "prompt", prompt: input.prompt ?? "" };
				const generation = deps.createInTransaction(db, {
					owner,
					conversationId,
					origin: "conversation",
					requestId: `conversation:${requestId}`,
					title: input.title ?? "",
					tags: input.tags ?? [],
					source,
				});
				return {
					action: "generate",
					state: "accepted",
					note: "生成には数分かかります。完成は画面と会話でお知らせします。",
					generation: {
						generationRef: generation.id,
						title: generation.title,
						stageLabel: generation.stageLabel,
					},
				};
			}
			case "find": {
				const query = input.query?.trim() ?? "";
				const tags = input.tags ?? [];
				const matches = findAssets(db, owner, query, tags, 10);
				setFocus(db, owner, FOCUS_SLOT, { kind: "search", query, tags });
				return {
					action: "find",
					query,
					tags,
					matches: matches.map((a) => ({
						assetRef: a.id,
						title: a.title,
						tags: a.tags,
						createdAt: a.createdAt,
					})),
					note: "画面でLARMの保存済みモデルを同じ条件で検索しています。",
				};
			}
			case "show": {
				const a = asset(db, owner, input.assetRef);
				setFocus(db, owner, FOCUS_SLOT, { kind: "asset", assetId: a.id });
				return {
					action: "show",
					asset: { assetRef: a.id, title: a.title, tags: a.tags },
					warnings: a.warnings,
				};
			}
			case "update": {
				const a = asset(db, owner, input.assetRef);
				const patch = {
					...(input.title ? { title: input.title } : {}),
					...(input.tags ? { tags: input.tags } : {}),
				};
				if (!patch.title && !patch.tags)
					throw new Error("model3d_empty_update");
				operation(db, owner, conversationId, "update", a.id, patch);
				setFocus(db, owner, FOCUS_SLOT, { kind: "asset", assetId: a.id });
				return {
					action: "update",
					state: "accepted",
					asset: {
						assetRef: a.id,
						title: patch.title ?? a.title,
						tags: patch.tags ?? a.tags,
					},
				};
			}
			case "delete": {
				const a = asset(db, owner, input.assetRef);
				operation(db, owner, conversationId, "delete", a.id, null);
				return {
					action: "delete",
					state: "accepted",
					asset: { assetRef: a.id, title: a.title },
					note: "元の画像ライブラリの画像は残ります。",
				};
			}
			case "cancel": {
				if (!input.generationRef)
					throw new Error("model3d_generation_not_found");
				const g = deps.cancelInTransaction(db, owner, input.generationRef);
				return {
					action: "cancel",
					generation: {
						generationRef: g.id,
						title: g.title,
						state: g.state,
						stageLabel: g.stageLabel,
					},
				};
			}
		}
	}
	return {
		commandInTransaction(
			db: Database,
			owner: string,
			conversationId: string,
			op: Model3dOperation,
			input: Model3dCommandInput,
			requestId: string,
		) {
			const inputJson = JSON.stringify(input);
			const previous = db
				.query(
					"SELECT owner,conversation_id,operation,input_json,result_json FROM model3d_commands WHERE request_id=?",
				)
				.get(requestId) as {
				owner: string;
				conversation_id: string;
				operation: string;
				input_json: string;
				result_json: string;
			} | null;
			if (previous) {
				if (
					previous.owner !== owner ||
					previous.conversation_id !== conversationId ||
					previous.operation !== op ||
					previous.input_json !== inputJson
				)
					throw new Error("request_conflict");
				return { value: JSON.parse(previous.result_json), replay: true };
			}
			const value = run(db, owner, conversationId, op, input, requestId);
			db.query(
				"INSERT INTO model3d_commands(request_id,owner,conversation_id,operation,input_json,result_json) VALUES(?,?,?,?,?,?)",
			).run(
				requestId,
				owner,
				conversationId,
				op,
				inputJson,
				JSON.stringify(value),
			);
			return { value, replay: false };
		},
		commandResultInTransaction(db: Database, owner: string, requestId: string) {
			const r = db
				.query(
					"SELECT result_json FROM model3d_commands WHERE request_id=? AND owner=?",
				)
				.get(requestId, owner) as { result_json: string } | null;
			return r ? JSON.parse(r.result_json) : null;
		},
		/** What the command specialist may target: host refs only, never IDs the model invents. */
		snapshotInTransaction(db: Database, owner: string) {
			const focus = focusOf(db, owner, FOCUS_SLOT);
			const recent = recentAssets(db, owner, 10);
			const found =
				focus?.kind === "search"
					? findAssets(db, owner, focus.query, focus.tags, 10)
					: [];
			const assets = [
				...new Map([...found, ...recent].map((a) => [a.id, a])).values(),
			];
			return {
				generations: listGenerations(db, owner, 5).map((g) => ({
					generationRef: g.id,
					title: g.title,
					state: g.state,
					stageLabel: g.stageLabel,
					warnings: g.warnings.length,
				})),
				assets: assets.map((a) => ({
					assetRef: a.id,
					title: a.title,
					tags: a.tags,
					createdAt: a.createdAt,
					prompt: a.prompt,
					hasWarnings: a.warnings.length > 0,
				})),
				pendingOperations: pendingOperations(db, owner).map((o) => ({
					kind: o.kind,
					assetRef: o.asset_id,
				})),
			};
		},
		knownAssetInTransaction: (db: Database, owner: string, id: string) =>
			knownAsset(db, owner, id) !== null,
		generationOwnedInTransaction(db: Database, owner: string, id: string) {
			try {
				ownedGeneration(db, id, owner);
				return true;
			} catch {
				return false;
			}
		},
	};
}
