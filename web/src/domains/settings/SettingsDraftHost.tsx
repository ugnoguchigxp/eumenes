import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import {
	settingsSchema,
	type Settings,
	type ApplySettings,
} from "../../../../api/domains/settings/contracts";
import { emptyCloud, type NewCloud } from "./shared";
import { useSettings } from "./index";
import { queryRoots, invalidateAllButLive } from "../../queryKeys";
import { describeError } from "../../errorMessages";

type State = {
	draft: Settings | null;
	keys: ApplySettings["keys"];
	retry: ApplySettings | null;
	busy: boolean;
	adding: boolean;
	message: string;
	version: number;
	newCloud: NewCloud;
};

function useDraftHost(client: EumenesClient) {
	const query = useSettings(client);
	const cache = useQueryClient();
	const [state, setState] = useState<State>({
		draft: null,
		keys: [],
		retry: null,
		busy: false,
		adding: false,
		message: "",
		version: 0,
		newCloud: emptyCloud,
	});
	const currentState = useRef(state);
	const saved = useRef(query.data);
	useEffect(() => {
		if (
			!saved.current ||
			(query.data && query.data.revision >= saved.current.revision)
		)
			saved.current = query.data;
	}, [query.data]);
	const alive = useRef(true);
	const receipts = useRef(new Set<string>());
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	function update(patch: Partial<State>) {
		if (!alive.current) return;
		const next = {
			...currentState.current,
			...patch,
			version: currentState.current.version + 1,
		};
		currentState.current = next;
		setState(next);
	}
	function setField<K extends keyof State>(
		key: K,
		action: SetStateAction<State[K]>,
	) {
		const value =
			typeof action === "function"
				? (action as (v: State[K]) => State[K])(currentState.current[key])
				: action;
		update({ [key]: value });
	}
	function current() {
		return {
			value: currentState.current.draft ?? saved.current,
			revision: currentState.current.version + (saved.current?.revision ?? 0),
		};
	}
	function change(fn: (s: Settings) => void) {
		const value = current().value;
		if (!value) return;
		const next = structuredClone(value);
		fn(next);
		if (JSON.stringify(next) === JSON.stringify(value)) return;
		const unchanged =
			!currentState.current.busy &&
			JSON.stringify(next) === JSON.stringify(saved.current);
		update({ draft: unchanged ? null : next, retry: null, message: "" });
	}
	async function apply(): Promise<Settings | null> {
		const value = current().value;
		const before = currentState.current;
		if (!value || before.busy || before.adding) return null;
		const validated = settingsSchema.safeParse(value);
		if (!validated.success) {
			update({
				message: validated.error.issues.map((i) => i.message).join(" / "),
			});
			return null;
		}
		const originOf = (v: string | null | undefined) =>
			v && URL.canParse(v) ? new URL(v).origin : null;
		const savedOrigin = originOf(saved.current?.larm.baseUrl);
		const nextOrigin = originOf(value.larm.baseUrl);
		let confirmLarmOrigin: string | undefined;
		if (
			!before.retry &&
			savedOrigin &&
			nextOrigin &&
			savedOrigin !== nextOrigin
		) {
			if (
				!window.confirm(
					"LARM の接続先を " +
						nextOrigin +
						" に変更します。LARM の認証情報はこの接続先へ送られます。変更しますか？",
				)
			)
				return null;
			confirmLarmOrigin = nextOrigin;
		}
		const input: ApplySettings = before.retry ?? {
			requestId: crypto.randomUUID(),
			expectedRevision: value.revision,
			settings: value,
			keys: before.keys,
			...(confirmLarmOrigin ? { confirmLarmOrigin } : {}),
		};
		update({ busy: true, message: "", retry: input });
		try {
			const result = await client.applySettings(input);
			if (!alive.current) return null;
			saved.current = result;
			cache.setQueryData([queryRoots.settings, client.identity], result);
			const latest = currentState.current;
			let draft = latest.draft;
			if (!draft || draft === input.settings) draft = null;
			else {
				draft = structuredClone(draft);
				draft.revision = result.revision;
				for (const purpose of ["llm", "asr", "tts"] as const)
					draft.routes[purpose].epoch = result.routes[purpose].epoch;
				for (const connection of draft.connections) {
					const normalized = result.connections.find(
						(c) => c.id === connection.id,
					);
					const submitted = input.settings.connections.find(
						(c) => c.id === connection.id,
					);
					if (normalized) {
						connection.epoch = normalized.epoch;
						if (submitted?.envRef === connection.envRef)
							connection.envRef = normalized.envRef;
					}
				}
			}
			update({
				draft,
				keys: latest.keys.filter(
					(k) =>
						!input.keys.some(
							(sent) =>
								sent.connectionId === k.connectionId && sent.value === k.value,
						),
				),
				retry: null,
				message: "変更を適用しました",
			});
			void invalidateAllButLive(cache);
			return result;
		} catch (cause) {
			if (!alive.current) return null;
			update({
				message:
					cause instanceof Error && cause.message === "revision_conflict"
						? "別の画面で設定が変更されました。最新の設定を読み直してから適用してください。"
						: "適用できませんでした: " + describeError(cause),
			});
			return null;
		} finally {
			if (alive.current) update({ busy: false });
		}
	}
	function discard() {
		if (currentState.current.busy) return;
		update({
			draft: null,
			keys: [],
			retry: null,
			adding: false,
			newCloud: { ...currentState.current.newCloud, key: "" },
			message: "",
		});
		void query.refetch();
	}
	const value = state.draft ?? query.data;
	const dirty = !!state.draft || state.keys.length > 0 || state.adding;
	return {
		...state,
		client,
		query,
		value,
		dirty,
		current,
		change,
		apply,
		discard,
		receipts,
		revision: state.version + (query.data?.revision ?? 0),
		setDraft: (v: SetStateAction<State["draft"]>) => setField("draft", v),
		setKeys: (v: SetStateAction<State["keys"]>) => setField("keys", v),
		setRetry: (v: SetStateAction<State["retry"]>) => setField("retry", v),
		setMessage: (v: SetStateAction<State["message"]>) => setField("message", v),
		setNewCloud: (v: SetStateAction<State["newCloud"]>) =>
			setField("newCloud", v),
		setAdding: (v: SetStateAction<State["adding"]>) => setField("adding", v),
	};
}

export type SettingsDraftHost = ReturnType<typeof useDraftHost>;
const Context = createContext<SettingsDraftHost | null>(null);
export function SettingsDraftProvider({
	client,
	children,
}: {
	client: EumenesClient;
	children: ReactNode;
}) {
	const host = useDraftHost(client);
	return <Context.Provider value={host}>{children}</Context.Provider>;
}
export function useOptionalSettingsDraft() {
	return useContext(Context);
}
export function useSettingsDraft() {
	const host = useOptionalSettingsDraft();
	if (!host) throw new Error("設定ホストが必要です");
	return host;
}
