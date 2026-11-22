import type { Database } from "bun:sqlite";
import {
	createGoalMemory,
	createGoalStore,
	openAgendaGoals,
	type GoalDocument,
	type GoalHost,
	type GoalMemoryGuard,
	type GoalReport,
	type GoalStore,
	type NoteDoc,
} from "eumenes-agency/agenda/runtime";
import {
	PRINCIPAL,
	PROFILE_SCOPE,
	type ForgetPurge,
} from "../../domains/memory/contracts";
import type { AgendaNote } from "../../domains/dialogue";
import type { GoalsService } from "../../domains/goals";
import { currentInput, referencedInput } from "./input";
import { agendaClock, type AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps, NoteDocumentPort } from "./host-types";

const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
export const goalScope = PROFILE_SCOPE;
const reportMessage = (id: string) => `agency-goal-report:${id}`;

export function createAgendaGoalStore(
	store: Parameters<typeof createGoalStore>[0],
	goals: GoalsService,
) {
	return createGoalStore(store, goals, {
		agendaScopeKey: goalScope,
		ledgerScopeKey: `${goalScope}:agenda-goals`,
	});
}

export function forgetGoalDocuments(
	db: Database,
	store: GoalStore,
	documents: NoteDocumentPort,
	inputs: NonNullable<AgencyHostDeps["memory"]["referenceInputs"]>,
	purge: ForgetPurge,
) {
	const messages = new Set(purge.messageIds);
	const items = new Set(purge.itemIds);
	const goalIds = new Set(purge.derived.goalIds);
	for (const note of store.documentsInTransaction(
		db,
		PRINCIPAL,
		PROFILE_SCOPE,
	)) {
		if (
			!goalIds.has(note.goalId) &&
			store.hasAllResearchInputsInTransaction(db, note) &&
			inputs.isCurrentInTransaction(db, {
				complete: true,
				sources: note.inputs,
			}) &&
			!note.memory.some(
				(item) =>
					items.has(item.id) ||
					item.sources.some(
						(source) =>
							source.namespace === "conversation" && messages.has(source.id),
					),
			)
		)
			continue;
		store.forgetDocumentInTransaction(db, note.id);
		documents.forget(note.conversationId, [note.id]);
	}
}

export function createGoalAgenda(input: {
	deps: AgencyHostDeps;
	now(): number;
	active(): AgendaScope | undefined;
	scope(id: string): AgendaScope | undefined;
	idle(scope: AgendaScope): boolean;
}) {
	const { deps, now } = input;
	const goals = deps.agendaGoals;
	const documents = deps.noteDocuments;
	if (!goals || !documents) return null;
	const memory = createGoalMemory(
		goals.readMemory,
		undefined,
		goals.isGoalContextCurrent,
	);
	const goalStore = goals.store;
	const active = input.active;
	const activeRequired = () => {
		const scope = active();
		if (!scope) throw new Error("agenda_goal_conversation_unavailable");
		return scope;
	};
	const records = (db: Database) =>
		goalStore.documentsInTransaction(db, PRINCIPAL, PROFILE_SCOPE);
	const liveRecord = (db: Database, id: string) => {
		const record = records(db).find((entry) => entry.id === id);
		return record &&
			goalStore.hasAllResearchInputsInTransaction(db, record) &&
			goalStore.goal(access, record.goalId) &&
			currentInput(deps, db, { complete: true, sources: record.inputs })
			? record
			: null;
	};
	const readDocument = (db: Database, record: GoalDocument) => {
		const original = documents.readInTransaction(db, record.documentId);
		return original
			? {
					id: record.id,
					title: original.title,
					markdown: original.markdown,
					summary: record.summary,
					refs: record.refs,
					at: record.at,
				}
			: null;
	};
	const researchId = (c: AgendaScope, note: AgendaNote) =>
		JSON.stringify([c.id, note.id]);
	const research = (c: AgendaScope | undefined) =>
		c?.notes.map((note) => ({ ...note, id: researchId(c, note) })) ?? [];
	const read = (_scopeKey: string, id: string): NoteDoc | null =>
		deps.store.read((db) => {
			if (id.startsWith("goal-design-")) {
				const record = liveRecord(db, id);
				return record ? readDocument(db, record) : null;
			}
			let key: unknown;
			try {
				key = JSON.parse(id);
			} catch {
				return null;
			}
			if (
				!Array.isArray(key) ||
				key.length !== 2 ||
				typeof key[0] !== "string" ||
				typeof key[1] !== "string"
			)
				return null;
			const c = input.scope(key[0]);
			const note = c?.notes.find((entry) => entry.id === key[1]);
			if (!note) return null;
			const original = note.documentId
				? documents.readInTransaction(db, note.documentId)
				: note;
			return original ? { ...note, ...original, id } : null;
		});
	const displayNoteInTransaction = (
		db: Database,
		id: string,
	): (AgendaNote & { documentConversationId: string }) | undefined => {
		const record = liveRecord(db, id);
		const note = record && readDocument(db, record);
		return record && note
			? {
					...note,
					documentId: record.documentId,
					documentConversationId: record.conversationId,
					ticketId: id,
					refs: [...note.refs],
					inputs: [...record.inputs],
				}
			: undefined;
	};
	const noteForDisplay = (id: string) =>
		deps.store.read((db) => displayNoteInTransaction(db, id));
	const llm = deps.createLlm(() => {
		const scope = activeRequired();
		const cfg = deps.settings.get().agency;
		return {
			decisionId: crypto.randomUUID(),
			generation: scope.generation,
			conversationId: scope.id,
			independent: true,
			...(cfg.thinkResourceId ? { resourceId: cfg.thinkResourceId } : {}),
			reasoning: cfg.thinkReasoning ?? "low",
		};
	});
	let host: Awaited<ReturnType<typeof openAgendaGoals>> | undefined;
	let opening: Promise<GoalHost> | undefined;
	const init = () =>
		(opening ??= openAgendaGoals({
			dir: goals.mockDir,
			principal: PRINCIPAL,
			scopes: () => [PROFILE_SCOPE],
			now,
			clock: agendaClock,
			llm,
			judge: llm,
			workLimit: () => Number.POSITIVE_INFINITY,
			...(goals.trace ? { trace: goals.trace } : {}),
			...(goals.analysisMs !== undefined
				? { analysisMs: goals.analysisMs }
				: {}),
			...(goals.designer ? { designer: goals.designer } : {}),
			opportunity: () => {
				const c = active();
				return {
					active: !!c,
					busy: !c || !input.idle(c),
					scopeKey: PROFILE_SCOPE,
				};
			},
			bindings: {
				store: goalStore,
				memory,
				quiet: () =>
					active()?.agent.view().quiet ?? { allUntil: null, speechUntil: null },
				documents: {
					list() {
						return [...research(active()), ...deps.store.read(records)];
					},
					read,
					save(db, scopeKey, note, evidence) {
						const c = activeRequired();
						const id = `goal-design-${crypto.randomUUID()}`;
						const retained = referencedInput(
							deps,
							db,
							research(c),
							note.refs.filter(
								(ref) =>
									ref.startsWith("note:") ||
									(ref.startsWith("memory:") &&
										!ref.startsWith("memory:agenda:")),
							),
						);
						if (!retained.complete)
							throw new Error("agenda_goal_sources_unavailable");
						const documentId = documents.startInTransaction(db, {
							conversationId: c.id,
							noteId: id,
							title: note.title,
							markdown: note.markdown,
							at: note.at,
						});
						goalStore.rememberDocumentInTransaction(db, PRINCIPAL, scopeKey, {
							id,
							documentId,
							conversationId: c.id,
							title: note.title,
							summary: note.summary,
							at: note.at,
							refs: note.refs,
							inputs: retained.sources,
							memory: evidence.memory,
							goalId: evidence.goal.goalId,
							allResearchInputs: true,
						});
						return { ...note, id };
					},
				},
			},
			reports: {
				lookupReport: (id) =>
					deps.store.read((db) =>
						deps.conversation.sourceInTransaction(db, reportMessage(id))
							.state === "missing"
							? "absent"
							: "delivered",
					),
				async publish(
					report: GoalReport,
					at: number,
					stillCurrent: GoalMemoryGuard,
				) {
					const c = activeRequired();
					await deps.store.write((db) => {
						const id = reportMessage(report.id);
						if (
							deps.conversation.sourceInTransaction(db, id).state !== "missing"
						)
							return;
						if (active() !== c || !stillCurrent(db))
							throw new Error("agenda_goal_opportunity_changed");
						const noteId = report.work.request.design?.id;
						const record = noteId && liveRecord(db, noteId);
						if (!record) throw new Error("agenda_goal_sources_unavailable");
						const createdAt = new Date(at).toISOString();
						deps.conversation.appendInTransaction(db, {
							id,
							conversationId: c.id,
							role: "assistant",
							text: report.text,
							createdAt,
							runId: null,
						});
						deps.memory.referenceInputs?.recordMessageInTransaction(db, id, {
							complete: true,
							sources: record.inputs,
						});
						deps.recordSpokeInTransaction(db, {
							conversationId: c.id,
							messageId: id,
							text: report.text,
							at: createdAt,
						});
					});
				},
			},
		}).then(
			(opened) => (host = opened),
			(error: unknown) => {
				opening = undefined;
				throw error;
			},
		));
	return {
		init,
		nextAt: () => host?.nextAt() ?? null,
		changed: () => host?.infoChanged(),
		tick: (signal: AbortSignal) => host?.tick(signal),
		close: async () => {
			await opening?.catch(() => undefined);
			await host?.close();
		},
		noteForDisplay,
		displayNoteInTransaction,
		async validNote(id: string) {
			const record = deps.store.read((db) => liveRecord(db, id));
			return (
				!!record &&
				(await memory
					.withGoalMemory(
						PROFILE_SCOPE,
						record.memory,
						record.memory.map((item) => item.id),
						async (valid, guard) => valid && guard(),
						true,
					)
					.catch(() => false))
			);
		},
	};
}
