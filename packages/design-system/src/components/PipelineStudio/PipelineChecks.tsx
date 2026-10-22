import type { PipelineStudioIssue } from "./types";

/** The findings of the pipeline check: where, which rule and the line in the source. */
export function PipelineChecks({ issues }: { issues: PipelineStudioIssue[] }) {
	if (issues.length === 0)
		return (
			<p className="pipeline-studio-ok">
				検査の指摘はありません。公開できる状態です。
			</p>
		);
	return (
		<ul className="pipeline-studio-issues" aria-label="検査の指摘">
			{issues.map((issue, index) => (
				<li key={`${index}:${issue.pointer}:${issue.rule}`}>
					<code>{issue.pointer || "(root)"}</code>
					<span>{issue.rule}</span>
					{issue.line !== null && (
						<span className="pipeline-studio-line">{issue.line}行目</span>
					)}
				</li>
			))}
		</ul>
	);
}
