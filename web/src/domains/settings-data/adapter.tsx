import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ActionBindingV1 } from "../../../../api/domains/capabilities/contracts";
import { invalidateAllButLive, queryRoots } from "../../queryKeys";
import { useSettings } from "../settings";
import {
	dirtyEntries,
	type RegisteredField,
} from "../toolchain-artifacts/documents";
import type { DraftView } from "../toolchain-artifacts/drafts";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { createAccess, createRuleOf, isResourceTarget } from "./settings-rules";
import {
	applyDraft,
	buildActions,
	buildInputs,
	buildSnapshot,
	groupsFor,
	settingsMessages,
} from "./settings-screens";
import { useFieldOptions, useTtsTargets } from "./settings-sources";
import { useVoiceTools } from "./useVoiceTools";

export const SETTINGS_ADAPTER_REF = "adapter:settings@1";
export const SETTINGS_DOCUMENT = "document:settings@1";

const emptyView: DraftView = {
	version: 0,
	entries: [],
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
	const own = useMemo(
		() =>
			(artifact.fields ?? []).filter((f) => f.document === SETTINGS_DOCUMENT),
		[artifact],
	);
	const effective = saved ? applyDraft(saved, view.entries, all) : undefined;

	const speechActive = own.some(
		(f) => f.path.startsWith("$.larm.") || isResourceTarget(f),
	);
	// A review of a pending voice change needs the catalog to name the values it compares.
	const voiceDraft = view.entries.some((entry) =>
		all.some(
			(f) => f.fieldId === entry.fieldId && f.path.startsWith("$.larm."),
		),
	);
	const { targetData, targets } = useTtsTargets(client, all, saved);
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
	const fetchedOptions = useFieldOptions(client, all);
	const ruleOf = createRuleOf({ effective, voice, fetchedOptions });
	const access = createAccess({ saved, effective, voice, targets, ruleOf });

	const dirty =
		dirtyEntries(view, all, access).length > 0 || view.secrets.length > 0;
	// The saved revision and the draft version never collide as one number.
	const revision = access.revision * 1_000_000 + view.version;
	const inputs = buildInputs({
		effective,
		own: own as RegisteredField[],
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
	const groups = groupsFor(inputs, effective, voice, saved);
	const snapshot = buildSnapshot({
		effective,
		artifact,
		own: own as RegisteredField[],
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
