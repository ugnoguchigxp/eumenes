import { shapeObservation, type ObservationEnvelope } from "eumenes-interact";
import { Refusal } from "eumenes-interact/parts";
import { interactHash, interactIso } from "./interact-authority";
import type {
	InteractExecutionContext,
	InteractExecutionDeps,
} from "./interact-execution";

/** Owns the latest observation and its tab generation; all operations use this same state. */
export function createInteractObservations(
	deps: Pick<InteractExecutionDeps, "driver" | "now">,
	context: () => InteractExecutionContext,
	active: () => void,
	allowed: (url: string) => Promise<void>,
) {
	let observation: ObservationEnvelope | null = null;
	let refs = new Set<string>();
	let tabGeneration = 0;
	let tabs: {
		tabRef: string;
		status: "open";
		current: boolean;
		url: string;
		title: string;
	}[] = [];
	async function list() {
		active();
		const raw = await deps.driver.listTabs();
		for (const t of raw) await allowed(t.url);
		active();
		tabs = raw.map((t) => ({
			tabRef: `t${t.index}`,
			status: "open",
			current: t.current,
			url: t.url,
			title: t.title,
		}));
		return tabs;
	}
	async function observe() {
		active();
		const raw = await deps.driver.snapshot(context().signal);
		await allowed(raw.url);
		const target = (await list()).find((t) => t.current);
		if (!target) throw new Error("tab_lost");
		const shaped = shapeObservation("arm1", {
			body: raw.snapshot,
			url: raw.url,
			title: raw.title,
			truncated: false,
			missing: [],
		});
		refs = new Set(shaped.refs);
		observation = {
			...shaped,
			observationRef: crypto.randomUUID(),
			platform: "playwright-mcp",
			sessionId: context().runId,
			target: { kind: "tab", tabRef: target.tabRef },
			generation: tabGeneration,
			capturedAt: interactIso(deps.now()),
			url: raw.url,
			title: raw.title,
			missing: [],
		};
		return observation;
	}
	function observed(
		tabRef: string,
		ref: string | undefined,
		target: string | null = null,
	) {
		active();
		if (
			!observation ||
			observation.target.kind !== "tab" ||
			observation.target.tabRef !== tabRef ||
			observation.observationRef !== ref ||
			observation.generation !== tabGeneration ||
			(target !== null && !refs.has(target))
		)
			throw new Refusal("observation_stale", false);
		return observation;
	}

	return {
		list,
		observe,
		observed,
		current: () => observation,
		invalidate() {
			tabGeneration++;
			observation = null;
			refs.clear();
		},
		snapshotDigest: () =>
			observation
				? interactHash({ body: observation.body, url: observation.url })
				: null,
		tabs: {
			get: (id: string) => tabs.find((t) => t.tabRef === id),
			open: () => tabs,
		},
	};
}
