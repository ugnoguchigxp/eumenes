import type { Database } from "bun:sqlite";
import type { GoalStore } from "eumenes-agency/agenda/runtime";
import type { ClaudeCodeService } from "../../domains/claude-code";
import type { MarkdownService } from "../../domains/markdown";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { goalDigest } from "./goal-progress-context";
import type { GoalProgressPorts } from "./goal-progress";
import {
	createGoalSemanticVerification,
	type GoalEvidenceDocument,
} from "./goal-semantic-verification";
import { createGoalVerification } from "./goal-verification";
import { createGoalWorkspaceVerification } from "./goal-workspace-verification";
import { composeGoalVerifiers } from "./goal-verifiers";
import type { GoalWorkspaceRegistry } from "./goal-workspaces";

export function registeredGoalVerifier(ports: {
	goals: GoalStore;
	store: SqliteStore;
	claude?: ClaudeCodeService;
	markdown: MarkdownService;
	llm: GoalProgressPorts["llm"];
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"];
	workspaces: GoalWorkspaceRegistry;
	permit?: Parameters<typeof createGoalWorkspaceVerification>[0]["permit"];
	readResearch?(db: Database, id: string): GoalEvidenceDocument | null;
}) {
	const { goals, store, workspaces, llm, sourcesCurrent } = ports;
	const machine = createGoalVerification({ goals, workspaces, sourcesCurrent });
	const semantic = createGoalSemanticVerification({
		llm,
		sourcesCurrent,
		read(db, row, id) {
			const research = ports.readResearch?.(db, id);
			if (research) return research;
			const evidence = row.state.evidence.find((item) => item.ref === id);
			const original =
				evidence && ports.markdown.generated.originalInTransaction(db, id);
			return original &&
				evidence &&
				goalDigest([
					id,
					original.title,
					original.markdown,
					evidence.sources,
				]) === evidence.digest
				? { ...original, id, sources: evidence.sources ?? [] }
				: null;
		},
	});
	const workspace =
		ports.permit &&
		createGoalWorkspaceVerification({
			store,
			goals,
			permit: ports.permit,
			llm,
			sourcesCurrent,
			protectedPaths: ports.claude?.protectedPaths,
		});
	return composeGoalVerifiers(machine, semantic, workspace);
}
