import {
	createAlwaysOnAgent,
	createHeartbeat,
	createHeartbeatScheduler,
	defaultHeartbeat,
	speechIntervals,
	type AlwaysOnAgent,
	type AlwaysOnTicket,
	type AlwaysOnTool,
	type Heartbeat,
	type HeartbeatCheckpoint,
	type InputContext,
} from "eumenes-agency";
import {
	alwaysOnSources,
	isAlwaysOnSnapshot,
	type AgencyRecord,
	type AlwaysOnHostSnapshot,
} from "../../domains/dialogue";
import { promptTime } from "../../domains/inference";
import { combineInput, currentInput, fixedInput } from "./input";
import { alwaysOnHostSystem } from "./always-on-system";
import type { AgencyHostDeps } from "./host-types";

export type AlwaysOnScope = {
	id: string;
	scope: string;
	epoch: number;
	generation: number;
	revision: number;
	agent: AlwaysOnAgent;
	heartbeat: Heartbeat;
	scheduler: ReturnType<typeof createHeartbeatScheduler>;
	tickets: AlwaysOnTicket[];
	controller: AbortController | null;
	pendingInput?: InputContext;
	busy: boolean;
	touched: number;
};

export function alwaysOnEnvelope(c: AlwaysOnScope): AlwaysOnHostSnapshot {
	return {
		kind: "always-on",
		version: 1,
		revision: c.revision,
		agent: c.agent.snapshot(),
		tickets: structuredClone(c.tickets),
	};
}

export function alwaysOnRecord(
	c: AlwaysOnScope,
	settingsDigest: string,
): AgencyRecord {
	const snapshot = alwaysOnEnvelope(c);
	return {
		conversationId: c.id,
		scope: c.scope,
		epoch: c.epoch,
		snapshot,
		idle: c.heartbeat.checkpoint(),
		settingsDigest,
		sourceRefs: alwaysOnSources(snapshot),
	};
}

export function createAlwaysOnScope(input: {
	deps: AgencyHostDeps;
	id: string;
	epoch: number;
	previous?: AgencyRecord;
	settled(c: AlwaysOnScope): Promise<void>;
	now(): number;
	run(c: AlwaysOnScope): Promise<{
		next: "soon" | "normal" | "later";
		wakeAt: number | null;
	} | null>;
}) {
	const { deps, id, now } = input;
	const cfg = deps.settings.get();
	const restored =
		input.previous && isAlwaysOnSnapshot(input.previous.snapshot)
			? input.previous.snapshot
			: undefined;
	let c: AlwaysOnScope;
	const inner = deps.createLlm(() => ({
		decisionId: crypto.randomUUID(),
		generation: c.generation,
		conversationId: id,
		independent: true,
		...(cfg.agency.thinkResourceId
			? { resourceId: cfg.agency.thinkResourceId }
			: {}),
		reasoning: cfg.agency.thinkReasoning ?? "high",
	}));
	const catalog = deps.state
		? deps.store.read((db) => deps.state!.catalogInTransaction(db))
		: [];
	// The initial publication is bounded by declared effect, never by capability names or request wording.
	const selected = ["read", "create"].flatMap((effect) =>
		catalog
			.filter(
				(card) =>
					!card.requiresApproval && "effect" in card && card.effect === effect,
			)
			.slice(0, 1),
	);
	const tools = selected.flatMap<AlwaysOnTool>((card) => {
		if (
			!("effect" in card) ||
			(card.effect !== "read" && card.effect !== "create")
		)
			return [];
		return [
			{
				name: card.revisionId,
				effect: card.effect,
				requiresApproval: card.requiresApproval,
				description: `${card.title}: ${card.description}。toolInputはJSON文字列 {"question":"目的と完了条件", "arguments":{}}。argumentsは必要な場合だけ。引数schema: ${JSON.stringify("argumentsSchema" in card ? card.argumentsSchema : null)}。受付と完成は別です。`,
				input: { sources: [`capability:${card.revisionId}`], complete: true },
			},
		];
	});
	const agent = createAlwaysOnAgent({
		llm: {
			async complete(request, signal) {
				const assertCurrent = () => {
					if (
						!request.input?.complete ||
						!deps.store.read((db) =>
							currentInput(
								deps,
								db,
								request.input ?? { sources: [], complete: false },
							),
						)
					)
						throw new DOMException("agency_input_stale", "AbortError");
				};
				assertCurrent();
				const captured = structuredClone(
					request.input ?? { sources: [], complete: false },
				);
				c.pendingInput = captured;
				try {
					const result = await inner.complete(request, signal);
					assertCurrent();
					return result;
				} finally {
					if (c.pendingInput === captured) delete c.pendingInput;
				}
			},
		},
		known: () => {
			const status = deps.memory.status();
			if (!status.enabled || !status.healthy) return [];
			return deps.memory
				.list()
				.filter(
					(item) =>
						item.status === "active" &&
						(item.validFromMs === null || item.validFromMs <= now()) &&
						(item.validUntilMs === null || item.validUntilMs > now()),
				)
				.flatMap((item) => {
					const input = deps.store.read((db) =>
						deps.memory.referenceInputs?.captureInTransaction(db, {
							itemIds: [item.id],
							itemRevisions: { [item.id]: item.revision },
						}),
					);
					return input?.complete &&
						deps.store.read((db) => currentInput(deps, db, input))
						? [
								{
									id: item.id,
									text: `${item.polarity === "negated" ? "（否定）" : ""}${item.text}`,
									input,
								},
							]
						: [];
				});
		},
		system: () => ({
			value: alwaysOnHostSystem(cfg.general),
			input: fixedInput(cfg),
		}),
		interests: cfg.agency.interests.map((text, i) => ({
			id: `persona-${i + 1}`,
			text,
			input: fixedInput(text),
		})),
		tools,
		speechIntervalSec:
			speechIntervals.find((n) => n === cfg.agency.speechIntervalSec) ?? 10,
		clock: (at) => promptTime(at).now,
		...(restored ? { restore: restored.agent } : {}),
	});
	const heartbeat = createHeartbeat(
		defaultHeartbeat,
		now(),
		restored ? (input.previous!.idle as HeartbeatCheckpoint) : undefined,
	);
	c = {
		id,
		scope: input.previous?.scope ?? crypto.randomUUID(),
		epoch: input.epoch,
		generation: 1,
		revision: restored?.revision ?? 0,
		agent,
		heartbeat,
		tickets: structuredClone(restored?.tickets ?? []),
		controller: null,
		busy: false,
		touched: now(),
		scheduler: createHeartbeatScheduler({
			heartbeat,
			now,
			setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
			clearTimer:
				deps.clearTimer ??
				((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
			run: () => input.run(c),
			onSettled: () => input.settled(c),
		}),
	};
	return c;
}

export function alwaysOnProjection(snapshot: AlwaysOnHostSnapshot) {
	const { state } = snapshot.agent;
	return {
		lines: [
			JSON.stringify({
				hypotheses: state.facts,
				questions: state.gaps,
				preparing: state.preparing,
				prepared: state.stock,
				thoughts: state.thoughts.slice(-4),
			}),
		],
		input: combineInput({ sources: alwaysOnSources(snapshot), complete: true }),
	};
}
