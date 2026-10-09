import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import type {
	ClaimChange,
	ClaimRow,
	ForgetAccepted,
} from "../../../../../api/domains/world/contracts";
import { Button } from "../../../design-system";
import { useWorldClaim, worldKey } from "../../../domains/world/hooks";
import {
	conditionLabels,
	contentText,
	evidenceLabels,
	failureOf,
	originLabels,
	sourceStateLabels,
	freshnessLabels,
	adoptionLabels,
} from "../../../domains/world/present";
import { ToneBadge } from "./ClaimTable";

type Client = Pick<
	EumenesClient,
	| "identity"
	| "worldClaim"
	| "correctWorldClaim"
	| "retractWorldClaim"
	| "forgetWorldClaim"
>;
export type ReasonMessage = { id: string; text: string };
type Action = "correct" | "retract" | "forget";

const preview = (text: string) =>
	text.length > 40 ? `${text.slice(0, 40)}…` : text;

/**
 * One claim in detail, and the three explicit operations on it. Every
 * operation carries the revision of the claim as it is SHOWN here; a
 * conflict reloads and asks the person to look again. Nothing here edits an
 * edge or a graph.
 */
export function ClaimDrawer({
	client,
	scopeKey,
	claimId,
	reasons,
	onClose,
	onPick,
	onDone,
}: {
	client: Client;
	scopeKey: string | undefined;
	claimId: string;
	reasons: readonly ReasonMessage[];
	onClose: () => void;
	/** The person chose one of several candidates: open that claim. */
	onPick: (row: ClaimRow) => void;
	onDone: (message: string) => void;
}) {
	const cache = useQueryClient();
	const detail = useWorldClaim(client, scopeKey, claimId);
	const heading = useRef<HTMLHeadingElement>(null);
	const [action, setAction] = useState<Action | null>(null);
	const [reasonId, setReasonId] = useState("");
	const [kind, setKind] = useState<"string" | "boolean" | "number">("string");
	const [text, setText] = useState("");
	const [flag, setFlag] = useState("true");
	const [unit, setUnit] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [notice, setNotice] = useState("");
	const [candidates, setCandidates] = useState<readonly ClaimRow[]>([]);

	useEffect(() => {
		heading.current?.focus();
	}, [claimId]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const refresh = () =>
		cache.invalidateQueries({ queryKey: worldKey(client.identity) });
	const row = detail.data?.claim;
	const reset = () => {
		setAction(null);
		setReasonId("");
		setText("");
		setUnit("");
		setConfirmed(false);
	};
	const settle = (result: ClaimChange | ForgetAccepted, done: string) => {
		if (result.status === "unresolved") {
			setCandidates(result.candidates);
			setNotice(
				"対象が一つに決まりません。何も変更していません。変更したい主張を選んでください。",
			);
			return;
		}
		reset();
		void refresh();
		onDone(done);
	};
	const onError = (error: unknown) => {
		const failure = failureOf(error);
		setNotice(failure.message);
		if (failure.reload) void refresh();
	};
	const base = () => ({
		...(scopeKey === undefined ? {} : { scopeKey }),
		requestId: crypto.randomUUID(),
		expectedRevision: row!.revision,
		target: { claimId },
	});
	const correct = useMutation({
		mutationFn: () =>
			client.correctWorldClaim({
				...base(),
				reasonMessageId: reasonId,
				value:
					kind === "string"
						? { kind: "string", value: text.trim() }
						: kind === "boolean"
							? { kind: "boolean", value: flag === "true" }
							: { kind: "number", value: Number(text), unit: unit.trim() },
			}),
		onSuccess: (result) =>
			settle(result, "訂正しました。新しい内容を採用しています。"),
		onError,
	});
	const retract = useMutation({
		mutationFn: () =>
			client.retractWorldClaim({ ...base(), reasonMessageId: reasonId }),
		onSuccess: (result) => settle(result, "撤回しました。"),
		onError,
	});
	const forget = useMutation({
		mutationFn: () => client.forgetWorldClaim(base()),
		// A forget that failed on the way may still be pending: always look again.
		onSettled: () => void refresh(),
		onSuccess: (result) =>
			settle(
				result,
				"忘却を受け付けました。完了ではありません。下の「忘却の状況」で進み具合を確認できます。",
			),
		onError,
	});
	const busy = correct.isPending || retract.isPending || forget.isPending;
	const valid =
		(kind === "boolean" || text.trim() !== "") &&
		(kind !== "number" || Number.isFinite(Number(text)));

	return (
		<dialog open className="world-drawer" aria-labelledby="world-drawer-title">
			<header className="world-drawer-head">
				<h3 id="world-drawer-title" ref={heading} tabIndex={-1}>
					主張の詳細
				</h3>
				<Button variant="secondary" onClick={onClose}>
					閉じる
				</Button>
			</header>
			{notice && <p role="alert">{notice}</p>}
			{detail.isPending && <p>読み込み中…</p>}
			{detail.isError && (
				<p role="alert">
					この主張を表示できません。一覧を読み込み直してください。
				</p>
			)}
			{detail.data && row && (
				<div className="world-drawer-body">
					<dl className="world-facts">
						<dt>対象</dt>
						<dd>{row.target.subjectId}</dd>
						<dt>主張</dt>
						<dd>
							{row.claim.predicate} : {contentText(row.claim.content)}
						</dd>
						<dt>採用状態</dt>
						<dd>
							{adoptionLabels[row.adoption]} <ToneBadge row={row} />
						</dd>
						<dt>由来</dt>
						<dd>{originLabels[row.origin]}</dd>
						<dt>鮮度</dt>
						<dd>{freshnessLabels[row.freshness]}</dd>
						<dt>版</dt>
						<dd>{row.revision}</dd>
					</dl>
					<section aria-label="条件">
						<h4>条件</h4>
						<p>
							{detail.data.condition.text}（
							{conditionLabels[detail.data.condition.evaluation]}）
						</p>
						{detail.data.condition.evaluation === "unknown" && (
							<p className="world-muted">
								条件は観測がそろうまで未確認です。成立とは扱いません。
							</p>
						)}
					</section>
					<section aria-label="支持する根拠">
						<h4>支持する根拠</h4>
						{detail.data.supports.length === 0 ? (
							<p className="world-muted">なし</p>
						) : (
							<ul>
								{detail.data.supports.map((e) => (
									<li key={e.evidenceId}>
										{evidenceLabels[e.kind]} — {e.source.kind} {e.source.id}
										（版 {e.source.revision.slice(0, 12)}）
									</li>
								))}
							</ul>
						)}
					</section>
					<section aria-label="反証">
						<h4>反証</h4>
						{detail.data.refutations.evidence.length === 0 &&
						detail.data.refutations.claims.length === 0 ? (
							<p className="world-muted">なし</p>
						) : (
							<ul>
								{detail.data.refutations.evidence.map((e) => (
									<li key={e.evidenceId}>
										{evidenceLabels[e.kind]} — {e.source.kind} {e.source.id}
									</li>
								))}
								{detail.data.refutations.claims.map((c) => (
									<li key={`${c.id}-${c.revision}`}>
										別の主張 {c.id}（版 {c.revision}）
										{c.predicate ? ` : ${c.predicate}` : ""}
									</li>
								))}
							</ul>
						)}
					</section>
					<section aria-label="出典の版">
						<h4>出典の版</h4>
						<ul>
							{detail.data.sources.map((s) => (
								<li key={`${s.kind}-${s.id}`}>
									{s.kind} {s.id}（版 {s.citedRevision.slice(0, 12)}）—{" "}
									{sourceStateLabels[s.state]}
								</li>
							))}
						</ul>
					</section>
					<section aria-label="履歴">
						<h4>履歴</h4>
						<ol className="world-history">
							{detail.data.history.map((h) => (
								<li key={h.revision}>
									版 {h.revision}: {h.lifecycle} — {contentText(h.content)}
									<span className="world-muted">
										{" "}
										（{originLabels[h.origin]}）
									</span>
								</li>
							))}
						</ol>
						{detail.data.historyTruncated && (
							<p className="world-muted">古い版は省略しています。</p>
						)}
					</section>
					<section aria-label="操作" className="world-actions">
						<h4>この主張への操作</h4>
						<div className="world-action-row">
							{(
								[
									["correct", "訂正する"],
									["retract", "撤回する"],
									["forget", "忘れる"],
								] as const
							).map(([id, label]) => (
								<Button
									key={id}
									variant={action === id ? "default" : "secondary"}
									aria-pressed={action === id}
									disabled={busy}
									onClick={() => {
										setNotice("");
										setCandidates([]);
										setAction(action === id ? null : id);
									}}
								>
									{label}
								</Button>
							))}
						</div>
						{(action === "correct" || action === "retract") && (
							<label className="world-field">
								理由にする、あなたの発言
								<select
									value={reasonId}
									onChange={(e) => setReasonId(e.target.value)}
								>
									<option value="">選んでください</option>
									{reasons.map((m) => (
										<option key={m.id} value={m.id}>
											{preview(m.text)}
										</option>
									))}
								</select>
							</label>
						)}
						{action === "correct" && (
							<form
								className="world-form"
								onSubmit={(e) => {
									e.preventDefault();
									if (valid && reasonId && !busy) correct.mutate();
								}}
							>
								<label className="world-field">
									新しい値の種類
									<select
										value={kind}
										onChange={(e) =>
											setKind(e.target.value as "string" | "boolean" | "number")
										}
									>
										<option value="string">文字</option>
										<option value="boolean">はい / いいえ</option>
										<option value="number">数値</option>
									</select>
								</label>
								{kind === "boolean" ? (
									<label className="world-field">
										新しい値
										<select
											value={flag}
											onChange={(e) => setFlag(e.target.value)}
										>
											<option value="true">はい</option>
											<option value="false">いいえ</option>
										</select>
									</label>
								) : (
									<label className="world-field">
										新しい値
										<input
											value={text}
											onChange={(e) => setText(e.target.value)}
										/>
									</label>
								)}
								{kind === "number" && (
									<label className="world-field">
										単位
										<input
											value={unit}
											onChange={(e) => setUnit(e.target.value)}
										/>
									</label>
								)}
								<p className="world-muted">
									あなたの発言を根拠に、この値を採用します。古い版は使われなくなります。
								</p>
								<Button
									type="submit"
									disabled={busy || !valid || reasonId === ""}
								>
									訂正を送る
								</Button>
							</form>
						)}
						{action === "retract" && (
							<div className="world-form">
								<p className="world-muted">
									撤回すると、この主張は使われなくなります。
								</p>
								<Button
									disabled={busy || reasonId === ""}
									onClick={() => retract.mutate()}
								>
									撤回を送る
								</Button>
							</div>
						)}
						{action === "forget" && (
							<div className="world-form">
								<p>
									忘れると、この主張とその履歴を消す手続きを始めます。取り消せません。
									手続きが終わるまでは「完了」とは表示しません。
								</p>
								<label className="world-check">
									<input
										type="checkbox"
										checked={confirmed}
										onChange={(e) => setConfirmed(e.target.checked)}
									/>
									内容を理解して、忘れます
								</label>
								<Button
									variant="destructive"
									disabled={busy || !confirmed}
									onClick={() => forget.mutate()}
								>
									忘れる手続きを始める
								</Button>
							</div>
						)}
						{candidates.length > 0 && (
							<ul className="world-candidates" aria-label="候補の主張">
								{candidates.map((c) => (
									<li key={c.id}>
										<button
											type="button"
											className="world-link"
											onClick={() => onPick(c)}
										>
											{c.target.subjectId} / {c.claim.predicate} :{" "}
											{contentText(c.claim.content)}（
											{adoptionLabels[c.adoption]}）
										</button>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</dialog>
	);
}
