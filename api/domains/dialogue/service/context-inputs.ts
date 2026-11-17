import type { Database } from "bun:sqlite";
import type { CallSession } from "../../inference/contracts";
import type { Run } from "../contracts";
import type {
	ContextCapture,
	ContextCaptureSummary,
	RunContext,
} from "../contracts/context-input";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import type { DebugDiagnosticsOptions } from "./debug-diagnostics";

const TTL = 30 * 60_000;
const RUNS_PER_CONVERSATION = 20;
const MAX_INPUT = 2 * 1024 ** 2;
const MAX_TOTAL = 16 * 1024 ** 2;

type Capture = {
	order: number;
	ref: Omit<ContextCaptureSummary, "accepted" | "status" | "available">;
	input: string | null;
	cut: string | null;
	sources: string[];
	size: number;
};
type RecordedRun = {
	token: symbol;
	conversationId: string;
	expiresAt: number;
	number: number;
	baseSize: number;
	inputs: Capture[];
};

export function createContextInputs(
	deps: DialogueDeps,
	options: DebugDiagnosticsOptions,
) {
	const { store, larm } = deps;
	const runs = new Map<string, RecordedRun>();
	let bytes = 0;
	let order = 0;
	let enabled = store.read(options.enabled);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function drop(run: RecordedRun, capture: Capture) {
		const index = run.inputs.indexOf(capture);
		if (index < 0) return;
		run.inputs.splice(index, 1);
		bytes -= capture.size;
	}
	function dropRun(id: string, run: RecordedRun) {
		for (const capture of run.inputs) bytes -= capture.size;
		bytes -= run.baseSize;
		runs.delete(id);
	}
	function expire(now: number) {
		let changed = false;
		for (const [id, run] of runs) {
			if (run.expiresAt <= now) {
				dropRun(id, run);
				changed = true;
				continue;
			}
			for (let index = run.inputs.length - 1; index >= 0; index--) {
				const capture = run.inputs[index]!;
				if (capture.ref.expiresAt <= now) {
					drop(run, capture);
					changed = true;
				}
			}
		}
		return changed;
	}
	function scheduleExpiry() {
		clearTimeout(timer);
		let next = Infinity;
		for (const run of runs.values())
			next = Math.min(
				next,
				run.expiresAt,
				run.inputs[0]?.ref.expiresAt ?? Infinity,
			);
		if (Number.isFinite(next))
			timer = setTimeout(
				() => {
					if (expire(Date.now())) options.publish?.();
					scheduleExpiry();
				},
				Math.max(1, next - Date.now()),
			).unref();
	}
	function invalidate() {
		runs.clear();
		bytes = 0;
		clearTimeout(timer);
	}
	function summary(
		db: Database,
		run: Run,
		capture: Capture,
	): ContextCaptureSummary | null {
		if (run.error === "permission_revoked") return null;
		const attempt = larm.usageOfInTransaction?.(db, {
			requestId: capture.ref.inferenceId,
			attemptId: capture.ref.attemptId,
			value: "",
		});
		if (
			attempt?.status === "revoked" ||
			attempt?.reason === "permission_revoked"
		)
			return null;
		try {
			if (
				capture.sources.length &&
				deps.memory?.referenceInputs.staleInTransaction(db, capture.sources)
					.length
			)
				return null;
		} catch {
			return null;
		}
		return {
			...capture.ref,
			accepted: attempt?.accepted === 1,
			status:
				attempt?.reason === "cancelled"
					? "cancelled"
					: (attempt?.status ?? run.status),
			available: capture.input !== null,
		};
	}
	function removeOldRuns(conversationId: string, newest: string) {
		const same = [...runs].filter(
			([, recorded]) => recorded.conversationId === conversationId,
		);
		for (const [id, oldest] of same.slice(
			0,
			Math.max(0, same.length - RUNS_PER_CONVERSATION),
		))
			dropRun(id, oldest);
		for (const [id, oldest] of runs) {
			if (bytes <= MAX_TOTAL) break;
			if (id !== newest) dropRun(id, oldest);
		}
	}

	return {
		enabled: () => enabled,
		invalidate,
		setEnabled(next: boolean) {
			if (enabled === next) return;
			enabled = next;
			invalidate();
		},
		begin(
			db: Database,
			run: Run,
			cut: string | null,
		): CallSession["observeInput"] {
			if (!enabled || !options.enabled(db)) return undefined;
			const now = Date.now();
			const sources =
				deps.memory?.referenceInputs.readRunInTransaction(db, run.id)
					?.sources ?? [];
			const existing = runs.get(run.id);
			const recorded: RecordedRun = existing ?? {
				token: Symbol(),
				conversationId: run.conversationId,
				expiresAt: now + TTL,
				number: 0,
				baseSize:
					Buffer.byteLength(run.id) +
					Buffer.byteLength(run.conversationId) +
					128,
				inputs: [],
			};
			if (!existing) {
				runs.set(run.id, recorded);
				bytes += recorded.baseSize;
				removeOldRuns(run.conversationId, run.id);
				scheduleExpiry();
			}
			// A pending send must not retain an evicted run's input bodies.
			const { token } = recorded;
			return ({ inferenceId, attemptId, input }) => {
				const recorded = runs.get(run.id);
				if (!enabled || recorded?.token !== token) return;
				const replySources = deps.agency?.replyInputInTransaction;
				const extra = replySources
					? store.read((db) => replySources(db, run.id)?.sources ?? [])
					: [];
				const references = [...new Set([...sources, ...extra])];
				const at = Date.now();
				const encoded = JSON.stringify(input);
				const ref = {
					id: crypto.randomUUID(),
					runId: run.id,
					number: ++recorded.number,
					inferenceId,
					attemptId,
					at,
					expiresAt: at + TTL,
					boundary: input.boundary,
				};
				const overhead = Buffer.byteLength(
					JSON.stringify({ ref, cut, references }),
				);
				const size = Buffer.byteLength(encoded) + overhead;
				const available = size <= MAX_INPUT;
				const capture: Capture = {
					order: ++order,
					ref,
					cut,
					input: available ? encoded : null,
					sources: available ? references : [],
					size: available ? size : Buffer.byteLength(JSON.stringify(ref)) + 128,
				};
				recorded.inputs.push(capture);
				recorded.expiresAt = ref.expiresAt;
				runs.delete(run.id);
				runs.set(run.id, recorded);
				bytes += capture.size;
				removeOldRuns(run.conversationId, run.id);
				while (bytes > MAX_TOTAL && recorded.inputs.length > 1)
					drop(recorded, recorded.inputs[0]!);
				scheduleExpiry();
				options.publish?.();
			};
		},
		list(runId: string): RunContext | null {
			return store.readSnapshot((db) => {
				if (!enabled || !options.enabled(db)) return null;
				const run = byId(db, runId);
				if (!run) return null;
				expire(Date.now());
				const recorded = runs.get(runId);
				const captures = [...(recorded?.inputs ?? [])].flatMap((entry) => {
					const value = summary(db, run, entry);
					if (value) return [value];
					drop(recorded!, entry);
					return [];
				});
				return {
					runId,
					conversationId: run.conversationId,
					status: run.status,
					captures,
					preferredId:
						(captures.findLast((entry) => entry.accepted) ?? captures.at(-1))
							?.id ?? null,
					empty:
						run.status === "running" || run.status === "queued"
							? "preparing"
							: recorded?.number === 0
								? "no_send"
								: "unavailable",
				};
			});
		},
		detail(runId: string, id: string): ContextCapture | null {
			return store.readSnapshot((db) => {
				if (!enabled || !options.enabled(db)) return null;
				expire(Date.now());
				const run = byId(db, runId);
				const recorded = runs.get(runId);
				const entry = recorded?.inputs.find((item) => item.ref.id === id);
				if (!run || !recorded || !entry?.input) return null;
				const current = summary(db, run, entry);
				if (!current) {
					drop(recorded, entry);
					return null;
				}
				const candidate =
					entry.ref.number > 1
						? recorded.inputs.find(
								(item) => item.ref.number === entry.ref.number - 1,
							)
						: [...runs].reduce<Capture | undefined>(
								(latest, [olderId, older]) => {
									if (
										olderId === runId ||
										older.conversationId !== run.conversationId
									)
										return latest;
									const prior = older.inputs.findLast(
										(item) => item.order < entry.order,
									);
									return prior && (!latest || prior.order > latest.order)
										? prior
										: latest;
								},
								undefined,
							);
				const priorRun =
					candidate &&
					(candidate.ref.runId === runId ? run : byId(db, candidate.ref.runId));
				const previous =
					candidate?.input && priorRun && summary(db, priorRun, candidate)
						? {
								runId: candidate.ref.runId,
								id: candidate.ref.id,
								number: candidate.ref.number,
								at: candidate.ref.at,
							}
						: null;
				return {
					summary: current,
					input: JSON.parse(entry.input),
					cut: entry.cut,
					previous,
				};
			});
		},
		close() {
			enabled = false;
			invalidate();
		},
	};
}
