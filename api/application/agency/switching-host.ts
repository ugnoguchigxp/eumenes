import { createAgencyHost } from "./host";
import { createAlwaysOnHost } from "./always-on-host";
import { fixedInput } from "./input";
import { agencyReplyParts } from "./system-context";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import type { AgencyHostDeps } from "./host-types";
import type { AgencyWork } from "./work";
import type { AgencyActivity } from "../../domains/dialogue/contracts/agency-status";
type Legacy = ReturnType<typeof createAgencyHost>;

/** One owner at a time. A switch drains and invalidates the previous owner before constructing the next. */
export function createSwitchingAgencyHost(deps: AgencyHostDeps) {
	const mode = () => deps.settings.get().agency.runtime ?? "F";
	const key = () =>
		fixedInput({
			mode: mode(),
			...(mode() === "always-on" ? deps.settings.get() : {}),
		}).sources[0]!;
	const create = () =>
		mode() === "always-on" ? createAlwaysOnHost(deps) : createAgencyHost(deps);
	let current = create();
	let ownerKey = key(),
		started = false,
		closed = false;
	let work: AgencyWork | undefined;
	let unsubscribe: (() => void) | undefined;
	let changing = Promise.resolve();
	const change = () => {
		changing = changing
			.then(async () => {
				if (closed || key() === ownerKey) return;
				await current.close();
				const nextKey = key();
				current = create();
				if (work) current.attachWork(work);
				await current.recover();
				ownerKey = nextKey;
				if (started && !closed) current.start();
			})
			.catch((error) =>
				getLogger("agency").warn("agency.switch_failed", {
					reason: toErrorCode(error, "switch_failed"),
				}),
			);
	};
	return {
		recover: () => current.recover(),
		start() {
			if (started || closed) return;
			started = true;
			current.start();
			unsubscribe = deps.settings.onChange(change);
		},
		async close() {
			if (closed) return;
			closed = true;
			unsubscribe?.();
			await changing;
			await current.close();
		},
		conversationAgent: {
			system: () => agencyReplyParts(deps.settings.get().agency),
			respond: (
				...args: Parameters<typeof current.conversationAgent.respond>
			) => current.conversationAgent.respond(...args),
		},
		dialoguePort: {
			isCurrentInputInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.isCurrentInputInTransaction>
				>
			) => current.dialoguePort.isCurrentInputInTransaction!(...args),
			inputForMessageInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.inputForMessageInTransaction>
				>
			) => current.dialoguePort.inputForMessageInTransaction!(...args),
			inputForContextInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.inputForContextInTransaction>
				>
			) => current.dialoguePort.inputForContextInTransaction!(...args),
			stateForContextInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.stateForContextInTransaction>
				>
			) => current.dialoguePort.stateForContextInTransaction!(...args),
			workChangedInTransaction: (
				...args: Parameters<
					typeof current.dialoguePort.workChangedInTransaction
				>
			) => current.dialoguePort.workChangedInTransaction(...args),
		},
		attachWork(value: AgencyWork) {
			work = value;
			current.attachWork(value);
		},
		forgetInTransaction: (
			db: Parameters<Legacy["forgetInTransaction"]>[0],
			purge: Parameters<Legacy["forgetInTransaction"]>[1],
		) => current.forgetInTransaction(db, purge),
		planForgetInTransaction: (
			db: Parameters<Legacy["planForgetInTransaction"]>[0],
			input: Parameters<Legacy["planForgetInTransaction"]>[1],
		) => current.planForgetInTransaction(db, input),
		invalidateTopics: () => current.invalidateTopics(),
		attend: (id: string, report?: AgencyActivity) =>
			mode() === "always-on"
				? (current as ReturnType<typeof createAlwaysOnHost>).attend(id, report)
				: report && (!report.visible || report.leaving)
					? Promise.resolve(current.status(id))
					: current.attend(id),
		status: (id: string) => current.status(id),
		inspect: (id: string) => current.inspect(id),
	};
}
