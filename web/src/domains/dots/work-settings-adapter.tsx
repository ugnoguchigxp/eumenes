import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Resource, Snapshot } from "@eumenes/artifact-ui/contracts";
import type { WorkSettings } from "../../../../api/domains/dots/contracts";
import {
	dirtyEntries,
	reviewRows,
	ruleOf,
	toWire,
	type DocumentAccess,
} from "../toolchain-artifacts/documents";
import { readPath, writePath } from "../toolchain-artifacts/paths";
import type {
	AdapterHostContext,
	AdapterState,
} from "../toolchain-artifacts/registry";

const DOCUMENT = "document:dots.settings@1";
type Options = { options: Array<{ value: string; label: string }> };
export function useDotsWorkSettings(context: AdapterHostContext): AdapterState {
	const { client, artifact, artifactRevisionId, drafts, documentFields } =
			context,
		cache = useQueryClient();
	const key = ["dots-work-settings", client.identity, artifactRevisionId];
	const query = useQuery({
		queryKey: key,
		retry: false,
		queryFn: async ({ signal }) => {
			const [document, connections, projects] = await Promise.all([
				client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-settings",
					undefined,
					signal,
				),
				client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-connections",
					undefined,
					signal,
				),
				client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-projects",
					undefined,
					signal,
				),
			]);
			return {
				revision: document.revision,
				data: document.data as { settings: WorkSettings },
				connections: connections.data as Options,
				projects: projects.data as Options,
			};
		},
	});
	const own = artifact.fields ?? [],
		saved = query.data,
		view = drafts[DOCUMENT],
		all = documentFields[DOCUMENT] ?? [];
	const access: DocumentAccess = {
		ready: !!saved,
		revision: saved?.revision ?? 0,
		read: (field) => (saved ? readPath(saved.data, field.path) : undefined),
		rule: (field) => ({
			...ruleOf(field),
			...(field.optionsSource
				? {
						options:
							field.optionsSource === "query:dots.connections@1"
								? saved?.connections.options
								: saved?.projects.options,
						disabled: !saved,
					}
				: {}),
		}),
		targets: () => [],
	};
	const effective = saved ? structuredClone(saved.data) : undefined;
	if (effective && view)
		for (const entry of view.entries) {
			const field = own.find((f) => f.fieldId === entry.fieldId);
			if (field) writePath(effective, field.path, undefined, entry.change);
		}
	const dirty = !!view && dirtyEntries(view, all, access).length > 0;
	const snapshot: Record<string, Resource> = {};
	const revision = (saved?.revision ?? 0) * 1_000_000 + (view?.version ?? 0);
	snapshot["dots-settings"] = {
		kind: "settings-section",
		revision,
		dirty,
		busy: view?.busy,
		blocked: !saved,
		message: view?.message,
		description:
			"接続と作業先は登録済みの候補から選びます。設定はこのPCに保存します。PC停止中の結果はChatGPTで確認してください。",
		groups: [
			{ id: "connection", label: "接続" },
			{ id: "target", label: "作業先と上限" },
			{ id: "results", label: "結果の表示" },
		],
		actions: [{ id: "back", label: "仕事へ戻る" }],
		fields: own.map((field) => {
			const rule = access.rule(field);
			return {
				id: field.fieldId,
				label: field.label,
				control: field.control,
				value: toWire(effective ? readPath(effective, field.path) : undefined),
				group: field.group,
				help: field.help,
				options: rule?.options ? [...rule.options] : undefined,
				minimum: rule?.min,
				maximum: rule?.max,
				step: rule?.step,
				disabled: !saved,
			};
		}),
	};
	const base = snapshot["dots-settings"];
	if (base.kind === "settings-section")
		for (const [source, group] of [
			["dots-settings", "connection"],
			["dots-settings-target", "target"],
			["dots-settings-results", "results"],
		]) {
			snapshot[source!] = {
				...base,
				fields: base.fields.filter((f) => f.group === group),
				groups: [],
				actions: group === "connection" ? base.actions : [],
			};
		}
	snapshot["dots-settings-changes"] = {
		kind: "settings-changes",
		revision,
		dirty,
		busy: view?.busy ?? false,
		blocked: !saved,
		message: view?.message ?? "",
		rows: view
			? reviewRows(view, all, access, context.documentFieldsReady)
			: [],
	};
	const refresh = useCallback(() => {
		void cache.invalidateQueries({
			queryKey: ["dots-work-settings", client.identity],
		});
	}, [cache, client.identity]);
	return {
		phase: query.isError
			? { kind: "error", message: "dotsの設定を取得できません。" }
			: query.isPending
				? { kind: "loading" }
				: { kind: "ready" },
		snapshot: snapshot as Snapshot,
		targetOf: () => undefined,
		documents: { [DOCUMENT]: access },
		local: async () => ({
			status: "rejected",
			message: "この操作は利用できません。",
		}),
		settled: () => {
			refresh();
			void cache.invalidateQueries({
				queryKey: ["dots-work", client.identity],
			});
		},
		refresh,
		describeRejection: (code) =>
			({
				dots_settings_target_invalid:
					"接続先と作業先の組合せを確認してください。",
				dots_unavailable: "有効な接続先と作業先を選んでください。",
			})[code ?? ""],
	};
}
