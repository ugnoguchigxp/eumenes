/**
 * The composition's shared state. `CompositionModelProvider` holds the values of the outermost
 * layout's `model` (inputs live in React state only; nothing is written back to the definition),
 * evaluates its computed values in dependency order and hands them to the views through
 * `useCompositionModel`.
 */
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type {
	CompositionModel,
	CompositionModelDefinition,
} from "./composition-contracts";
import {
	acceptedValue,
	computeValues,
	evaluateSource,
	own,
	scopeOf,
	type StateValue,
} from "./composition-compute";
import { createBudget } from "./composition-expressions";

const ModelContext = createContext<CompositionModel | null>(null);
const noOverrides: ReadonlyMap<string, StateValue> = new Map();

/** The shared state of the surrounding composition; null when its layout has no `model`. */
export function useCompositionModel(): CompositionModel | null {
	return useContext(ModelContext);
}

export function CompositionModelProvider({
	model,
	children,
}: {
	model: CompositionModelDefinition | undefined;
	children?: ReactNode;
}) {
	// A changed definition (a draft being edited) starts over from its initial values.
	const signature = useMemo(
		() => (model ? JSON.stringify(model) : ""),
		[model],
	);
	const definition = useMemo<CompositionModelDefinition | undefined>(
		() => (signature ? JSON.parse(signature) : undefined),
		[signature],
	);
	const [entered, setEntered] = useState<{
		signature: string;
		values: ReadonlyMap<string, StateValue>;
	}>({ signature, values: noOverrides });
	const overrides =
		entered.signature === signature ? entered.values : noOverrides;
	const set = useCallback(
		(name: string, value: StateValue) => {
			const state = own(definition?.state, name);
			const accepted = state && acceptedValue(state, value);
			if (accepted === undefined) return;
			setEntered((current) => {
				const next = new Map(
					current.signature === signature ? current.values : noOverrides,
				);
				next.set(name, accepted);
				return { signature, values: next };
			});
		},
		[definition, signature],
	);
	const value = useMemo<CompositionModel | null>(() => {
		if (!definition) return null;
		const states = new Map<string, StateValue>();
		for (const [name, state] of Object.entries(definition.state ?? {}))
			states.set(
				name,
				acceptedValue(state, overrides.get(name)) ??
					acceptedValue(state, state.initial) ??
					state.initial,
			);
		const values = computeValues(definition, states);
		return {
			value: (name) => values.get(name) ?? null,
			set,
			evaluate: (source, locals) =>
				evaluateSource(source, scopeOf(values, locals), createBudget()),
			state: (name) => own(definition.state, name) ?? null,
		};
	}, [definition, overrides, set]);
	return (
		<ModelContext.Provider value={value}>{children}</ModelContext.Provider>
	);
}
