import type { ForgetView } from "../../../../../api/domains/world/contracts";
import { forgetLabels } from "../../../domains/world/present";

/**
 * The ledger's own word on each forget. "Done" appears only for `complete`:
 * an accepted, pending, unconfirmed or partly refused forget is never shown
 * as finished.
 */
export function ForgetList({ forgets }: { forgets: readonly ForgetView[] }) {
	if (forgets.length === 0) return null;
	return (
		<section className="world-section" aria-label="忘却の状況">
			<h3>忘却の状況</h3>
			<ul className="world-forgets">
				{forgets.map((f) => (
					<li
						key={f.forgetId}
						className={`world-forget world-forget-${f.display}`}
					>
						<span className="world-badge">{forgetLabels[f.display]}</span>
						<span className="world-muted">
							{" "}
							{new Date(f.createdAt).toLocaleString("ja-JP")}
							{f.abandoned.parts + f.abandoned.roots > 0
								? `（実行できなかった範囲 ${f.abandoned.parts + f.abandoned.roots} 件）`
								: ""}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
