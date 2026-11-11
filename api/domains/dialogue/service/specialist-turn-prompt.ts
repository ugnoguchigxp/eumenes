import type { Database } from "bun:sqlite";
import { systemContext } from "../../../infrastructure/system-context";
import { agentSystemMessage } from "../../inference";
import type { GuidanceLanguage, Run, SpecialistSet } from "../contracts";
import { guidanceNoticeSchema } from "../contracts/specialist";
import { byId, sessionById, type SessionRecord } from "../repository";
import type { DialogueDeps } from "./context";
import {
	agentPolicy,
	documentTools,
	documentView,
	type AgentPolicy,
} from "./specialist-agent";
import { viewedSpecialistTarget } from "./specialist-context";
import { sessionCourse, specialistTurnMessages } from "./specialist-memory";
import { specialistObservation } from "./specialist-notices";
import { structuredSpecialistControl } from "./specialist-output";
import { specialistControl } from "./specialist-prompt";
import { turnRefusal } from "./specialist-core";
import type { TurnInput } from "./specialist-turn";

const HOST_EVENT_NOTICE = systemContext(
	"dialogue.contexts.specialist-turn.host-observation",
	{},
);

/**
 * The session's work document for this turn, read as its canonical text: whole, or an outline (then the agent
 * gets doc.view to read lines). Null when the binding names none or it cannot be read.
 */
function turnDocument(
	port: NonNullable<DialogueDeps["specialist"]>,
	set: SpecialistSet,
	workRef: string,
	policy: AgentPolicy,
	tx: Database,
) {
	const declared = set.agent.document;
	const document = declared
		? port.documentOf(set.adapterRef)?.readInTransaction(tx, workRef)
		: null;
	if (!declared || !document) return null;
	return {
		path: declared.path,
		revision: document.revision,
		title: document.title,
		...documentView(document.text, policy.inlineBytes),
		rejected: document.rejected,
		inlineBytes: policy.inlineBytes,
	};
}

/** A host event is reference data, carried separately from the real user input. */
function observedWork(
	work: NonNullable<
		ReturnType<
			NonNullable<DialogueDeps["specialist"]>["workStateInTransaction"]
		>
	>,
	hostEvent: unknown,
) {
	return hostEvent !== null
		? {
				...work,
				current: { work: work.current, hostEvent },
				context: { work: work.context, hostEvent },
			}
		: work;
}

export function prepareSpecialistPrompt(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	session: SessionRecord,
	set: SpecialistSet,
	work: Parameters<typeof observedWork>[0],
	report: string,
	language?: GuidanceLanguage,
) {
	const port = deps.specialist!;
	const policy = agentPolicy(set);
	const document = turnDocument(port, set, session.workRef, policy, tx);
	const hostEvent = specialistObservation(deps, tx, run.id, session);
	const notice = guidanceNoticeSchema.safeParse(hostEvent);
	const guidance =
		document && hostEvent === null ? port.guidance?.tool(set) : undefined;
	const candidates =
		guidance && report ? port.guidance?.candidates(tx, language) : undefined;
	const control = specialistControl(
		set,
		[
			...documentTools(set, document?.outlined ?? false),
			...(guidance ? [guidance] : []),
		],
		hostEvent !== null,
	);
	const delivery =
		candidates?.length && document
			? {
					workRevision: document.revision,
					candidates,
				}
			: undefined;
	const modelControl = delivery
		? structuredSpecialistControl(control)
		: control;
	const messages = specialistTurnMessages({
		system: agentSystemMessage(modelControl),
		utterance: hostEvent !== null ? HOST_EVENT_NOTICE : report,
		course: sessionCourse(deps, tx, session, run, policy),
		work: observedWork(work, hostEvent),
		viewing: viewedSpecialistTarget(deps, tx, run),
		nowMs: Date.parse(deps.clock()),
		callsLeft: policy.maxModelCalls,
		...(document ? { document } : {}),
	});
	if (delivery)
		messages.splice(messages.length - 1, 0, {
			role: "user",
			content: "GUIDANCE_CANDIDATES=" + JSON.stringify(delivery),
		});
	return {
		control: modelControl,
		messages,
		...(hostEvent !== null ? { observation: true as const } : {}),
		...(notice.success ? { guidanceNoticeRef: notice.data.requestRef } : {}),
		...(guidance
			? {
					guidanceToolId: guidance.id,
					guidanceReport: report,
					guidanceLanguage: language,
				}
			: {}),
		...(delivery
			? {
					candidateDelivery: {
						acceptedAt: Date.parse(run.createdAt),
						workRevision: delivery.workRevision,
						kind: delivery.candidates.map(({ language }) => language).join(","),
						skillDigest: delivery.candidates
							.map(({ digest }) => digest)
							.join(","),
						requestBytes: Buffer.byteLength(report),
					},
				}
			: {}),
	};
}

/** Resolve a stored notice through the same delivery checks as an explicit lookup. */
export async function appendGuidanceNotice(
	deps: DialogueDeps,
	input: TurnInput,
	signal: AbortSignal,
) {
	const port = deps.specialist;
	if (!input.guidanceNoticeRef || !port?.guidance) return;
	const document = port.documentOf(input.adapterRef);
	const currentRevision = (tx: Database) => {
		const run = byId(tx, input.runId);
		const session = sessionById(tx, input.sessionId);
		if (
			run?.status !== "running" ||
			run.revision !== input.revision ||
			turnRefusal(session, input.runId, input.epoch, deps.clock())
		)
			throw Error("guidance_turn_stale");
		return document?.readInTransaction(tx, input.workRef)?.revision;
	};
	const revision = deps.store.read(currentRevision);
	const result =
		revision === undefined
			? { kind: "unavailable", reason: "workspace_unavailable" }
			: await port.guidance.read(input.guidanceNoticeRef, {
					sessionId: input.sessionId,
					sessionEpoch: input.epoch,
					revision,
					signal,
					assertCurrent(tx) {
						if (currentRevision(tx) !== revision)
							throw Error("guidance_revision_changed");
					},
				});
	signal.throwIfAborted();
	input.messages.splice(input.messages.length - 1, 0, {
		role: "user",
		content: "GUIDANCE_RESULT=" + JSON.stringify(result),
	});
}
