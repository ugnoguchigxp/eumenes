import { loadFrozen } from "../../../scripts/nl-acceptance/frozen";
import type {
	Criteria,
	HostSnapshot,
	HostTimer,
	ObservedReceipt,
	RunEvidence,
	ScreenObservation,
} from "../../../scripts/nl-acceptance/types";

/** Synthetic evidence for the main case: a 180 s timer that is paused and resumed, observed once a second. */
export const T0 = 1_700_000_000_000;
const SERVER_OFFSET = 5_000;
export const MAIN_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "10000000-0000-4000-8000-000000000002";
const SEEDED_ID = "10000000-0000-4000-8000-0000000000aa";

export function criteriaOf(caseId: string): Criteria {
	const { set } = loadFrozen();
	const c = set!.criteria.get(`criteria:${caseId}@1`);
	if (!c) throw new Error(`no criteria ${caseId}`);
	return c;
}

export type Fault = {
	durationSeconds?: number;
	doubleStart?: boolean;
	fakeSuccess?: boolean;
	otherTimerModified?: boolean;
	/** Stop the timeline here (seconds) to model an early end. */
	endAtSeconds?: number;
	/** Screens carry no readable clock. */
	unreadableScreen?: boolean;
	/** The paused remaining time drifts, as if the timer kept running. */
	driftWhilePaused?: boolean;
	termination?: RunEvidence["termination"];
};

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;

function mainTimer(
	t: number,
	duration: number,
	drift: boolean,
): HostTimer | null {
	if (t < 3) return null;
	const server = T0 + SERVER_OFFSET;
	const created = server + 3000;
	const base = {
		id: MAIN_ID,
		label: "タイマー",
		durationSeconds: duration,
		originRunId: null,
	};
	if (t < 15)
		return {
			...base,
			revision: 0,
			state: "active",
			dueAt: new Date(created + duration * 1000).toISOString(),
			remainingSeconds: duration - (t - 3),
		};
	const pausedRemaining = duration - 12;
	if (t < 24)
		return {
			...base,
			revision: 1,
			state: "paused",
			dueAt: new Date(created + duration * 1000).toISOString(),
			remainingSeconds: drift ? pausedRemaining - (t - 15) : pausedRemaining,
		};
	return {
		...base,
		revision: 2,
		state: "active",
		dueAt: new Date(server + 24_000 + pausedRemaining * 1000).toISOString(),
		remainingSeconds: pausedRemaining - (t - 24),
	};
}

export function synthMain(fault: Fault = {}): RunEvidence {
	const duration = fault.durationSeconds ?? 180;
	const end = fault.endAtSeconds ?? 40;
	const hostSeries: HostSnapshot[] = [];
	const screens: ScreenObservation[] = [];
	for (let t = 0; t <= end; t++) {
		const timers: HostTimer[] = [];
		if (fault.otherTimerModified)
			timers.push({
				id: SEEDED_ID,
				revision: t >= 20 ? 1 : 0,
				state: t >= 20 ? "paused" : "active",
				label: "既存",
				durationSeconds: 900,
				dueAt: new Date(T0 + 900_000).toISOString(),
				remainingSeconds: 900,
				originRunId: null,
			});
		const main = fault.fakeSuccess
			? null
			: mainTimer(t, duration, !!fault.driftWhilePaused);
		if (main) timers.push(main);
		if (fault.doubleStart && t >= 6 && main)
			timers.push({
				...main,
				id: SECOND_ID,
				revision: 0,
				state: "active",
				remainingSeconds: duration - (t - 6),
			});
		hostSeries.push({
			seq: t,
			atMs: T0 + t * 1000,
			serverNowMs: T0 + SERVER_OFFSET + t * 1000,
			timers,
			interactions: null,
		});
		if (t >= 4 && t % 3 === 0) {
			const m = mainTimer(t, duration, !!fault.driftWhilePaused);
			let text = '- button "アーティファクトを開く" [ref=e1]';
			if (fault.fakeSuccess)
				text += `\n- status: ${duration / 60}分のタイマーを開始しました`;
			else if (m && !fault.unreadableScreen)
				text += `\n- generic: ${m.state === "paused" ? "一時停止中" : "残り"} ${clock(m.remainingSeconds)}`;
			else if (m) text += "\n- generic: タイマー";
			screens.push({ seq: t, atMs: T0 + t * 1000 + 100, text });
		}
	}
	const receipts: ObservedReceipt[] = [];
	if (!fault.fakeSuccess) {
		const at = (t: number) => T0 + t * 1000;
		if (end >= 3)
			receipts.push({
				atMs: at(3),
				action: "started",
				operationId: "20000000-0000-4000-8000-000000000001",
				timerId: MAIN_ID,
				revision: 0,
				httpStatus: 201,
			});
		if (fault.doubleStart)
			receipts.push({
				atMs: at(6),
				action: "started",
				operationId: "20000000-0000-4000-8000-000000000002",
				timerId: SECOND_ID,
				revision: 0,
				httpStatus: 201,
			});
		if (end >= 15)
			receipts.push({
				atMs: at(15),
				action: "paused",
				operationId: "20000000-0000-4000-8000-000000000003",
				timerId: MAIN_ID,
				revision: 1,
				httpStatus: 200,
			});
		if (end >= 24)
			receipts.push({
				atMs: at(24),
				action: "resumed",
				operationId: "20000000-0000-4000-8000-000000000004",
				timerId: MAIN_ID,
				revision: 2,
				httpStatus: 200,
			});
	}
	return {
		caseId: "timer-ui-purpose-01",
		hostSeries,
		receipts,
		screens,
		reloads: [],
		faultsTriggered: [],
		termination: fault.termination ?? { reason: "done" },
	};
}
