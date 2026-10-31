import type { Database } from "bun:sqlite";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";
import type { TaskExecutionHost } from "./task-execution-port";
import { reference, result, total } from "./task-execution-values";
export function taskChildContext(host: TaskExecutionHost) {
	const { agents, routing, registry, dialogue } = host;
	function available(db: Database, sourceRunId?: string) {
		return routing.catalogInTransaction(db).filter((e) => {
			if (
				e.runtime.execution === "task" ||
				e.runtime.execution === "pipeline" ||
				(e.runtime.binding && !e.runtime.binding.available)
			)
				return false;
			if (
				e.runtime.execution === "session" &&
				!dialogue.executionCommands.sessionAvailableInTransaction()
			)
				return false;
			const requires = e.runtime.requires;
			if (
				requires === "image" ||
				requires === "music" ||
				requires === "excalidraw"
			)
				return !!host.media?.available(requires);
			if (requires === "object-recognition")
				return !!host.legacy?.availableInTransaction(
					db,
					requires,
					e.revisionId,
					sourceRunId,
				);
			return true;
		});
	}
	function resolve(db: Database, child: ChildExecution) {
		if (
			!available(db, child.source.runId).some(
				(e) => e.revisionId === child.chainRevisionId,
			)
		)
			throw new Error("toolchain_unavailable");
		return routing.resolveInTransaction(db, child.chainRevisionId);
	}
	function live(db: Database, child: ChildExecution) {
		if (!agents.executions.authorizeChildInTransaction(db, child))
			throw new Error("execution_changed");
		resolve(db, child);
	}
	function research(
		db: Database,
		child: ChildExecution,
		calls = 0,
	): ChildResult {
		const dispatchId = child.dispatchId ?? child.id;
		const current = agents.executionChildInTransaction(db, dispatchId);
		const ref = {
			kind: "research",
			dispatchId,
			calls,
			reportDigest: current?.reportDigest ?? null,
		};
		if (!current)
			return result(
				"cancelled",
				ref,
				"dispatch_not_started",
				total(child, calls),
			);
		if (["cancelled", "interrupted", "failed"].includes(current.root.state))
			return result(
				current.root.state === "failed" ? "failed" : "cancelled",
				ref,
				current.root.error_code ?? current.root.state,
				total(child, calls + current.calls),
				current.root.error_code ?? undefined,
			);
		const ticket = current.ticket;
		if (!ticket)
			return result(
				current.root.state === "completed" ? "completed" : "running",
				ref,
				current.root.state,
				total(child, calls + current.calls),
			);
		if (ticket.failureCode)
			return result(
				"failed",
				ref,
				ticket.failureCode,
				total(child, calls + current.calls),
				ticket.failureCode,
			);
		const body = ticket.projection ? JSON.parse(ticket.projection) : null;
		if (body?.clarification)
			return {
				...result(
					"waiting_input",
					ref,
					body.clarification,
					total(child, calls + current.calls),
				),
				question: body.clarification,
			};
		return {
			...result(
				"completed",
				ref,
				typeof body?.summary === "string"
					? body.summary
					: (ticket.projection ?? "confirmed"),
				total(child, calls + current.calls),
			),
			output: body,
			...(current.links.length ? { links: current.links } : {}),
		};
	}
	function bound(
		db: Database,
		child: ChildExecution,
		raw: unknown,
	): ChildResult {
		const ref = reference.parse(raw);
		const adapter = ref.adapterRef ? registry.get(ref.adapterRef) : undefined;
		const saved = ref.operationId
			? adapter?.readInTransaction(db, ref.operationId)
			: null;
		if (!adapter || !saved)
			return result(
				"failed",
				raw,
				"operation_result_missing",
				total(child, ref.calls ?? 0),
			);
		if (adapter.execution) {
			const current = adapter.execution.currentInTransaction(
				db,
				ref.operationId!,
				child,
			);
			return {
				...current,
				ref: { ...ref, domain: current.ref },
				modelCalls: total(child, (ref.calls ?? 0) + current.modelCalls),
			};
		}
		return {
			...result(
				"completed",
				ref,
				JSON.stringify(saved.answerContext ?? saved.receipt),
				total(child, ref.calls ?? 0),
			),
			output: saved.answerContext ?? saved.receipt,
		};
	}

	return { available, resolve, live, research, bound };
}
export type TaskChildContext = ReturnType<typeof taskChildContext>;
