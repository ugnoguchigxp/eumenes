import type { TerminalActivity } from "./contracts";
import { type HookPayload, waitsForPerson } from "./hooks";

/** A request handed over from the conversation, waiting for or running in its Claude Code turn. */
export type HandedTask = {
	name: string;
	prompt: string;
	conversationId?: string;
};
export type TaskOutcome = "completed" | "interrupted" | "ended";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
/** The turn Claude Code started is this request (its UserPromptSubmit prompt). */
const isTurnOf = (prompt: string, task: HandedTask) => {
	const submitted = normalize(prompt);
	const handed = normalize(task.prompt);
	return submitted === handed || submitted.includes(handed.slice(0, 80));
};

/**
 * Attributes Claude Code's turns to handed-over tasks, one run at a time. A task becomes active
 * only when its own prompt is submitted, so a Stop of an earlier turn never finishes it; a turn
 * that starts while one is active without a Stop means the earlier one was interrupted.
 */
export function createTaskTracker() {
	const pending: HandedTask[] = [];
	let active: HandedTask | undefined;
	return {
		hand(task: HandedTask) {
			pending.push(task);
		},
		/** The task shown for the session: the running one, else the next to run. */
		current: () => (active ?? pending[0])?.name,
		/** A turn started; returns the task it interrupted, if any. */
		submitted(prompt: string | undefined): HandedTask | undefined {
			const interrupted = active;
			const index =
				prompt === undefined
					? -1
					: pending.findIndex((t) => isTurnOf(prompt, t));
			active = index < 0 ? undefined : pending.splice(index, 1)[0];
			return interrupted;
		},
		/** The turn finished; returns the task it ran, if it was a handed-over one. */
		stopped(): HandedTask | undefined {
			const done = active;
			active = undefined;
			return done;
		},
		/** The run ended: every task not reported yet. */
		drain(): HandedTask[] {
			const left = [...(active ? [active] : []), ...pending];
			active = undefined;
			pending.length = 0;
			return left;
		},
	};
}
export type TaskTracker = ReturnType<typeof createTaskTracker>;

/**
 * What one hook changes for a run: its activity and, when a handed-over task is over, that task
 * with its outcome. `idle_prompt` notifications and tool use outside a permission wait change
 * nothing.
 */
export function applyHook(
	run: { activity: TerminalActivity; tasks: TaskTracker },
	payload: HookPayload,
): { changed: boolean; over?: { task: HandedTask; outcome: TaskOutcome } } {
	switch (payload.hook_event_name) {
		case "UserPromptSubmit": {
			run.activity = "working";
			const interrupted = run.tasks.submitted(payload.prompt);
			return {
				changed: true,
				...(interrupted
					? { over: { task: interrupted, outcome: "interrupted" as const } }
					: {}),
			};
		}
		case "PostToolUse":
			// Work goes on after the person answered a permission question.
			if (run.activity !== "waiting") return { changed: false };
			run.activity = "working";
			return { changed: true };
		case "Notification":
			if (!waitsForPerson(payload)) return { changed: false };
			run.activity = "waiting";
			return { changed: true };
		case "Stop": {
			run.activity = "idle";
			const done = run.tasks.stopped();
			return {
				changed: true,
				...(done
					? { over: { task: done, outcome: "completed" as const } }
					: {}),
			};
		}
	}
}
