import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import type { ActionBindingV1 } from "../../../../api/domains/capabilities/contracts";
import { invalidateAllButLive, queryRoots } from "../../queryKeys";
import { useSettings } from "../settings";
import { dirtyEntries } from "../toolchain-artifacts/documents";
import type { DraftView } from "../toolchain-artifacts/drafts";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { createAccess, createRuleOf, isSpeechTarget } from "./settings-rules";
import {
	applyDraft,
	buildActions,
	buildInputs,
	buildSnapshot,
	groupsFor,
	settingsMessages,
} from "./settings-screens";
import { useFieldOptions, useTargets } from "./settings-sources";
import { useModelCatalog } from "./useModelCatalog";
import { useVoiceTools } from "./useVoiceTools";

export const SETTINGS_ADAPTER_REF = "adapter:settings@1";
export const SETTINGS_DOCUMENT = "document:settings@1";

const emptyView: DraftView = {
	version: 0,
	entries: [],
	structural: [],
	secrets: [],
	busy: false,
	message: "",
};

function useSettingsArtifact(context: AdapterHostContext): AdapterState {
	const {
		client,
		artifact,
		drafts,
		documentFields,
		documentFieldsReady,
		catalog,
	} = context;
	const cache = useQueryClient();
	const query = useSettings(client);
	const saved = query.data;
	const view = drafts[SETTINGS_DOCUMENT] ?? emptyView;
	const all = documentFields[SETTINGS_DOCUMENT] ?? [];
	// The fields this screen registered (with their owner's context), in registration order.
	const own = all.filter(
		(f) => f.artifactRevisionId === context.artifactRevisionId,
	);
	const effective = saved ? applyDraft(saved, view.entries, all) : undefined;

	const speechActive = own.some(
		(f) => f.path.startsWith("$.larm.") || isSpeechTarget(f),
	);
	// A review of a pending voice change needs the catalog to name the values it compares.
	const voiceDraft = view.entries.some((entry) =>
		all.some(
			(f) => f.fieldId === entry.fieldId && f.path.startsWith("$.larm."),
		),
	);
	const { targetData, targetsOf } = useTargets(client, all, saved);
	const voice = useVoiceTools({
		client,
		saved,
		effective,
		active: speechActive || voiceDraft,
		speech: {
			local:
				targetData?.localAvailable ??
				(saved ? saved.routes.tts.mode !== "cloud-only" : true),
			cloud: (targetData?.targets ?? []).map((t) => ({
				id: t.id,
				label: t.selectLabel ?? t.label,
			})),
		},
	});
	const catalogActive = artifact.sourceBindings.some(
		(s) => s.source === "settings-model-catalog",
	);
	const modelCatalog = useModelCatalog(
		client,
		saved,
		effective,
		view,
		catalogActive,
	);
	const fetchedOptions = useFieldOptions(client, all);
	const ruleOf = createRuleOf({ effective, voice, fetchedOptions });
	const access = createAccess({ saved, effective, voice, targetsOf, ruleOf });

	const dirty =
		dirtyEntries(view, all, access).length > 0 ||
		view.structural.length > 0 ||
		view.secrets.length > 0;
	// The saved revision and the draft version never collide as one number.
	const revision = access.revision * 1_000_000 + view.version;
	const { inputs, targetGroups } = buildInputs({
		effective,
		view,
		own,
		access,
		ruleOf,
		voice,
		speechActive,
	});
	const actions = buildActions({
		effective,
		saved,
		speechActive,
		bindings: artifact.actionBindings,
		voice,
	});
	const groups = groupsFor(inputs, effective, voice, saved, targetGroups);
	const snapshot = buildSnapshot({
		effective,
		artifact,
		own,
		all,
		access,
		view,
		revision,
		dirty,
		inputs,
		groups,
		actions,
		catalog,
		documentFieldsReady,
	});

	if (catalogActive) snapshot["settings-model-catalog"] = modelCatalog.resource;

	const phase: AdapterState["phase"] = query.isError
		? {
				kind: "error",
				message: "設定を読み込めません。APIの接続を確認してください。",
			}
		: !effective
			? { kind: "loading" }
			: { kind: "ready" };

	async function runLocal(
		binding: ActionBindingV1,
		event: ArtifactEvent,
	): Promise<Receipt> {
		const id = String(event.values.id ?? "");
		if (binding.source === "settings-model-catalog")
			return (
				(await modelCatalog.run(id)) ?? {
					status: "rejected",
					message: "この操作は利用できません",
				}
			);
		const action = actions.find((a) => a.id === id && !a.disabled);
		if (binding.eventAction !== "settings-action" || !action)
			return { status: "rejected", message: "この操作は利用できません" };
		switch (id) {
			case "voice-refresh":
				voice.sample.stop();
				void voice.voices.refetch();
				break;
			case "voice-sample":
				if (voice.sample.state === "idle") void voice.sample.play();
				else voice.sample.stop();
				break;
			default:
				void voice.discover();
		}
		return { status: "accepted", message: "" };
	}

	return {
		phase,
		snapshot,
		targetOf: () => undefined,
		local: runLocal,
		async settled() {
			await cache.refetchQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
			void invalidateAllButLive(cache);
		},
		refresh: () =>
			void cache.invalidateQueries({ queryKey: [queryRoots.settings] }),
		documents: { [SETTINGS_DOCUMENT]: access },
		describeRejection: (code) => (code ? settingsMessages[code] : undefined),
		editLocal(key, wire) {
			const catalogResult = modelCatalog.edit(key, wire);
			if (catalogResult) return catalogResult;
			if (key !== "speech.target" || voice.targets.length < 2) return null;
			if (!voice.targets.some((t) => t.value === wire))
				return { status: "rejected", message: "未登録の読み上げ先です" };
			voice.chooseTarget(wire);
			return { status: "accepted", message: "" };
		},
	};
}

export const settingsWebAdapter: WebArtifactAdapter = {
	adapterRef: SETTINGS_ADAPTER_REF,
	useArtifact: useSettingsArtifact,
};
