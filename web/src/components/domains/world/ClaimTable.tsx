import type { ClaimRow } from "../../../../../api/domains/world/contracts";
import {
	adoptionLabels,
	contentText,
	evidenceLabels,
	freshnessLabels,
	originLabels,
	toneLabels,
} from "../../../domains/world/present";

/** A badge for the two tones that must never look like a confirmed claim. */
export function ToneBadge({
	row,
}: {
	row: Pick<ClaimRow, "tone" | "adoption">;
}) {
	if (row.tone === "adopted") return null;
	// Never say the same thing twice.
	if (toneLabels[row.tone] === adoptionLabels[row.adoption]) return null;
	return (
		<span className={`world-badge world-tone-${row.tone}`}>
			{toneLabels[row.tone]}
		</span>
	);
}

export function ClaimTable({
	rows,
	selected,
	onOpen,
}: {
	rows: readonly ClaimRow[];
	selected: string | null;
	onOpen: (row: ClaimRow, opener: HTMLElement) => void;
}) {
	return (
		<div className="world-table-wrap">
			<table className="world-table">
				<caption className="world-caption">
					主張の一覧（対象・主張・採用状態・根拠・鮮度は別の項目です）
				</caption>
				<thead>
					<tr>
						<th scope="col">対象</th>
						<th scope="col">主張</th>
						<th scope="col">採用状態</th>
						<th scope="col">根拠の種類</th>
						<th scope="col">鮮度</th>
						<th scope="col">
							<span className="world-sr">操作</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr
							key={row.id}
							className={`world-claim world-tone-${row.tone}`}
							aria-current={selected === row.id ? "true" : undefined}
						>
							<th scope="row">{row.target.subjectId}</th>
							<td>
								<span className="world-predicate">{row.claim.predicate}</span>
								{" : "}
								<span>{contentText(row.claim.content)}</span>
							</td>
							<td>
								{adoptionLabels[row.adoption]} <ToneBadge row={row} />
							</td>
							<td>
								<span>{originLabels[row.origin]}</span>
								{row.evidenceKinds.length > 0 && (
									<span className="world-muted">
										{" （"}
										{row.evidenceKinds.map((k) => evidenceLabels[k]).join("、")}
										{"）"}
									</span>
								)}
							</td>
							<td>{freshnessLabels[row.freshness]}</td>
							<td>
								<button
									type="button"
									className="world-link"
									aria-label={`${row.target.subjectId} ${row.claim.predicate} の詳細を開く`}
									onClick={(e) => onOpen(row, e.currentTarget)}
								>
									詳細
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
