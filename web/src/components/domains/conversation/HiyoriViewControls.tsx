import { defaultAvatarView, type AvatarView } from "../../../domains/avatar";

export function HiyoriViewControls({
	view,
	onChange,
}: {
	view: AvatarView;
	onChange: (view: AvatarView) => void;
}) {
	return (
		<details className="hiyori-view-controls">
			<summary>モデルの表示調整</summary>
			<div className="hiyori-view-fields">
				<label>
					ズーム <output>{Math.round(view.zoom * 100)}%</output>
					<input
						aria-label="ズーム"
						type="range"
						min={50}
						max={300}
						step={1}
						value={Math.round(view.zoom * 100)}
						onChange={(event) =>
							onChange({
								...view,
								zoom: event.currentTarget.valueAsNumber / 100,
							})
						}
					/>
				</label>
				<label>
					左右の位置 <output>{Math.round(view.x * 100)}%</output>
					<input
						aria-label="左右の位置"
						type="range"
						min={-50}
						max={50}
						step={1}
						value={Math.round(view.x * 100)}
						onChange={(event) =>
							onChange({ ...view, x: event.currentTarget.valueAsNumber / 100 })
						}
					/>
				</label>
				<label>
					上下の位置 <output>{Math.round(view.y * 100)}%</output>
					<input
						aria-label="上下の位置"
						type="range"
						min={-50}
						max={50}
						step={1}
						value={Math.round(view.y * 100)}
						onChange={(event) =>
							onChange({ ...view, y: event.currentTarget.valueAsNumber / 100 })
						}
					/>
				</label>
				<div className="hiyori-view-actions">
					<button
						type="button"
						onClick={() => onChange({ zoom: 2.2, x: 0, y: 0 })}
					>
						上半身
					</button>
					<button type="button" onClick={() => onChange(defaultAvatarView)}>
						リセット
					</button>
				</div>
			</div>
		</details>
	);
}
