import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { DataTable } from "../DataTable";
import { UsageSelect, stamp } from "./controls";
import type { UsageDashboardProps, UsageRateDraft } from "./types";
export function RatePanel({
	data,
	busy,
	onRateSave,
}: Pick<UsageDashboardProps, "data" | "busy" | "onRateSave">) {
	const fieldId = useId();
	const [draft, setDraft] = useState<UsageRateDraft>({
		model: "",
		amount: "",
		effectiveFrom: "",
		source: "",
	});
	const [review, setReview] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const model = draft.model || data.liveModels[0] || "";
	function change(key: keyof UsageRateDraft, value: string) {
		setDraft((d) => ({ ...d, [key]: value }));
		setReview(false);
		setError("");
	}
	async function submit() {
		const date = new Date(draft.effectiveFrom + ":00+09:00");
		if (
			!model ||
			!/^(0|[1-9]\d{0,5})(\.\d{1,9})?$/.test(draft.amount) ||
			!Number.isFinite(+date) ||
			!draft.source.trim()
		) {
			setError("モデル・0以上の単価・適用開始・出典を入力してください。");
			return;
		}
		if (!review) {
			setReview(true);
			return;
		}
		setSaving(true);
		try {
			if (
				await onRateSave({
					...draft,
					model,
					effectiveFrom: date.toISOString(),
					source: draft.source.trim(),
				})
			) {
				setReview(false);
				setDraft({ model, amount: "", effectiveFrom: "", source: "" });
			}
		} finally {
			setSaving(false);
		}
	}
	return (
		<section className="ds-usage-section">
			<h3>概算に使う単価</h3>
			<p className="ds-usage-muted">
				LiveのUSD /
				分を登録します。秒単位で換算し、適用開始以前の記録には使いません。単価履歴は追記して残します。
			</p>
			<p className="ds-usage-muted">
				Codex
				SDKはトークン量を集計します。契約残量・追加請求額・クレジットへの換算には対応していません。
			</p>
			<form
				className="ds-usage-rate"
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<UsageSelect
					label="Liveモデル"
					value={model}
					disabled={busy || saving || !data.liveModels.length}
					options={data.liveModels.map((m) => ({ value: m, label: m }))}
					onChange={(v) => change("model", v)}
				/>
				<label htmlFor={fieldId + "-amount"}>
					<span>単価（USD / 分）</span>
					<Input
						id={fieldId + "-amount"}
						value={draft.amount}
						inputMode="decimal"
						placeholder="0.00"
						maxLength={16}
						onChange={(e) => change("amount", e.target.value)}
						disabled={saving}
					/>
				</label>
				<label htmlFor={fieldId + "-effective"}>
					<span>適用開始（日本時間）</span>
					<Input
						id={fieldId + "-effective"}
						type="datetime-local"
						value={draft.effectiveFrom}
						onChange={(e) => change("effectiveFrom", e.target.value)}
						disabled={saving}
					/>
				</label>
				<label className="ds-usage-rate-source" htmlFor={fieldId + "-source"}>
					<span>出典・確認資料</span>
					<Input
						id={fieldId + "-source"}
						value={draft.source}
						maxLength={500}
						placeholder="公式料金ページなど"
						onChange={(e) => change("source", e.target.value)}
						disabled={saving}
					/>
				</label>
				{review && (
					<p className="ds-usage-review" role="status">
						{model} · USD {draft.amount} / 分 ·{" "}
						{draft.effectiveFrom.replace("T", " ")} 以降に適用します。
					</p>
				)}
				{error && <p role="alert">{error}</p>}
				<div className="ds-usage-rate-actions">
					<Button type="submit" disabled={busy || saving || !model}>
						{saving ? "保存中…" : review ? "この単価を保存" : "入力を確認"}
					</Button>
					{review && (
						<Button
							type="button"
							variant="ghost"
							onClick={() => setReview(false)}
						>
							戻る
						</Button>
					)}
				</div>
			</form>
			<DataTable
				title="単価履歴"
				columns={["モデル", "USD / 分", "適用開始", "確認日", "出典"].map(
					(header) => ({ header }),
				)}
				rows={data.rates.map((r) => [
					r.model,
					r.amount,
					stamp(r.effectiveFrom),
					stamp(r.checkedAt),
					r.source,
				])}
			/>
		</section>
	);
}
