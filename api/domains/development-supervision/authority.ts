import type { Database } from "bun:sqlite";
import { hash } from "../capabilities";
import type { ExecutionSource } from "../tool-runtime";
import type {
	SupervisedAuthorityRequest,
	SupervisedSource,
	SupervisionDesignBinding,
	SupervisionHost,
	SupervisionScope,
	SupervisionTarget,
} from "./contracts";
import { grantOf, parentOf, questionsOf, saveGrant } from "./repository";
import type { Grant, Parent, Task } from "./state";

function confirmationCurrent(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
) {
	const saved = parent.confirmation;
	if (!saved) return true;
	const proof = host.confirmedRequestInTransaction?.(
		db,
		parent.source,
		saved.id,
		parent.request,
	);
	return proof?.digest === saved.digest && proof.request === saved.request;
}

export function sourceCurrent(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
) {
	return (
		!parent.forgotten &&
		host.validSourceInTransaction(db, parent.source) &&
		confirmationCurrent(host, db, parent) &&
		parent.references.every((ref) =>
			host.validReferenceInTransaction(db, parent.source, ref),
		) &&
		parent.controls.every(
			({ source }) =>
				!source ||
				hash(
					host.controlSourceInTransaction(
						db,
						parent.source.conversationId,
						source.messageId,
						parent.source,
					),
				) === hash(source),
		)
	);
}

export function bindingCurrent(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	binding: SupervisionDesignBinding,
) {
	return (
		sourceCurrent(host, db, parent) &&
		binding.generation === parent.generation &&
		binding.evidence.every((evidence) =>
			host.research.validEvidenceInTransaction(db, parent.source, evidence),
		)
	);
}

export function designBinding(
	host: SupervisionHost,
	db: Database,
	documentId: string,
	parentId: string,
) {
	const parent = parentOf(db, parentId);
	const binding = parent?.designs.find(
		(design) => design.documentId === documentId,
	);
	return parent && binding && bindingCurrent(host, db, parent, binding)
		? binding
		: null;
}

export function designFor(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	revision: number | null,
) {
	const binding = parent.designs.find((design) => design.revision === revision);
	if (!binding || !bindingCurrent(host, db, parent, binding)) return null;
	const found = host.design.readInTransaction(db, binding);
	return found?.documentId === binding.documentId &&
		found.digest === binding.digest
		? found
		: null;
}

export function issueGrant(
	db: Database,
	parent: Parent,
	input: SupervisionTarget & {
		kind: Grant["kind"];
		request: string;
		scope: SupervisionScope;
		design: Grant["design"];
		task?: Task;
	},
) {
	const { task, request, ...authority } = input;
	const grant: Grant = {
		...authority,
		source: {
			origin: "supervised",
			conversationId: parent.source.conversationId,
			messageId: null,
			runId: parent.source.runId,
			request,
			digest: hash(request),
			delegation: {
				grantRef: crypto.randomUUID(),
				parentWorkId: parent.id,
				taskId: task?.id ?? crypto.randomUUID(),
				parentGeneration: parent.generation,
				taskGeneration: task?.generation ?? parent.generation,
			},
		},
		workId: null,
		operationId: crypto.randomUUID(),
		stopOperationId: null,
		revoked: false,
		released: false,
	};
	// This must already exist when the child owner validates its direct start entry in the same writer.
	saveGrant(db, grant);
	return grant;
}

export function linkedGrant(
	db: Database,
	source: SupervisedSource,
	workId?: string,
) {
	if (
		source.origin !== "supervised" ||
		source.messageId !== null ||
		!source.delegation
	)
		return null;
	const grant = grantOf(db, source.delegation.grantRef);
	if (
		!grant ||
		hash(source) !== hash(grant.source) ||
		(workId !== undefined && grant.workId !== workId)
	)
		return null;
	return grant;
}

export function liveGrant(
	host: SupervisionHost,
	db: Database,
	grant: Grant,
	parent: Parent,
	now: number,
) {
	const { delegation } = grant.source;
	if (
		grant.revoked ||
		parent.stop ||
		!sourceCurrent(host, db, parent) ||
		parent.deadline <= now ||
		grant.scope.deadline <= now ||
		parent.generation !== delegation.parentGeneration ||
		parent.phase === "finished"
	)
		return false;
	if (grant.kind !== "claude")
		return parent.research.some(
			({ grantRef }) => grantRef === delegation.grantRef,
		);
	const task = parent.tasks.find(({ id }) => id === delegation.taskId);
	if (
		!task ||
		task.generation !== delegation.taskGeneration ||
		task.grantRef !== delegation.grantRef ||
		!grant.design ||
		task.designRevision !== grant.design.revision
	)
		return false;
	const design = designFor(host, db, parent, task.designRevision);
	const ceiling = task.ceiling ?? parent.ceiling;
	return (
		!!design &&
		design.digest === grant.design.digest &&
		!!ceiling &&
		host.workspace.authorizeInTransaction(db, {
			source: parent.source,
			parentRequest: parent.request,
			ceiling,
			scope: grant.scope,
			authorityQuote: task.proposal.authorityQuote,
			design,
		})
	);
}

export function authorize(
	host: SupervisionHost,
	db: Database,
	input: SupervisedAuthorityRequest,
	now: number,
) {
	const grant = linkedGrant(db, input.source, input.workId);
	if (
		!grant ||
		grant.bindingRevisionId !== input.bindingRevisionId ||
		grant.toolchainRevisionId !== input.toolchainRevisionId ||
		grant.source.digest !== hash(input.request) ||
		input.request !== grant.source.request
	)
		return null;
	const parent = parentOf(db, grant.source.delegation.parentWorkId);
	if (!parent) return null;
	if (input.action === "inspect" || input.action === "view")
		return input.workId ? grant : null;
	if (input.action === "cancel" || input.action === "stop")
		return input.workId &&
			grant.stopOperationId &&
			input.operationId === grant.stopOperationId
			? grant
			: null;
	if (!liveGrant(host, db, grant, parent, now)) return null;
	if (input.action === "start")
		return input.operationId === grant.operationId &&
			(!grant.workId ||
				input.workId === grant.workId ||
				(grant.kind !== "claude" && grant.workId === grant.operationId))
			? grant
			: null;
	if (grant.released || !input.workId || !grant.workId) return null;
	if (input.action === "continue") return grant;
	const question = questionsOf(db, parent.id).find(
		(row) =>
			row.id === input.parentQuestionId &&
			row.grantRef === grant.source.delegation.grantRef &&
			row.workId === input.workId &&
			(input.questionId === undefined ||
				row.childQuestionId === input.questionId),
	);
	if (!question || !question.expiresAt || question.expiresAt <= now)
		return null;
	if (input.action === "present")
		return question.status === "presented" &&
			question.presentOperationId === input.operationId
			? grant
			: null;
	if (input.action === "answer")
		return (question.status === "presented" ||
			question.status === "answered") &&
			question.answer?.operationId === input.operationId &&
			question.answer?.messageId === input.messageId
			? grant
			: null;
	return null;
}

export function parentSource(
	host: SupervisionHost,
	db: Database,
	source: SupervisedSource,
	now: number,
): ExecutionSource | null {
	const grant = linkedGrant(db, source);
	const parent = grant && parentOf(db, grant.source.delegation.parentWorkId);
	return grant && parent && liveGrant(host, db, grant, parent, now)
		? parent.source
		: null;
}

export function childObservation(
	host: SupervisionHost,
	db: Database,
	grant: Grant,
) {
	if (grant.kind !== "claude" || !grant.workId) return null;
	const found = host.child.viewInTransaction(db, grant.source, grant.workId);
	return found &&
		found.view.id === grant.workId &&
		found.view.conversationId === grant.source.conversationId &&
		found.view.deadline <= grant.scope.deadline
		? found
		: null;
}
