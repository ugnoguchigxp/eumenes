import { useId, useState } from "react";
import { Button } from "../Button";
import { Card, CardContent, CardHeader, CardTitle } from "../Card";
import { Input } from "../Input";
import "./style.css";

export type SettingsInputField = {
	id: string;
	label: string;
	help?: string;
	control: "text" | "select";
	value: string;
	maxLength?: number;
	options?: { value: string; label: string }[];
};
export type SettingsLink = {
	id: string;
	label: string;
	description?: string;
	group: string;
	enabled: boolean;
};
export type SettingsChangeRow = {
	id: string;
	label: string;
	before: string;
	after: string;
};

/** Controlled inputs only; the host owns edits, validation and persistence. */
export function SettingsSection({
	title,
	description,
	fields,
	dirty,
	onChange,
	onReview,
}: {
	title: string;
	description?: string;
	fields: SettingsInputField[];
	dirty: boolean;
	onChange: (id: string, value: string) => void;
	onReview: () => void;
}) {
	const prefix = useId();
	return (
		<Card className="ds-settings-panel">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				{description && <p className="ds-settings-hint">{description}</p>}
				<form
					className="ds-settings-fields"
					onSubmit={(event) => {
						event.preventDefault();
						onReview();
					}}
				>
					{fields.map((field) => (
						<div key={field.id} className="ds-settings-field">
							<label htmlFor={prefix + field.id}>{field.label}</label>
							{field.control === "select" ? (
								<select
									id={prefix + field.id}
									value={field.value}
									onChange={(event) => onChange(field.id, event.target.value)}
									aria-describedby={
										field.help ? prefix + field.id + "-help" : undefined
									}
								>
									{field.options?.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							) : (
								<Input
									id={prefix + field.id}
									value={field.value}
									maxLength={field.maxLength}
									onChange={(event) => onChange(field.id, event.target.value)}
									aria-describedby={
										field.help ? prefix + field.id + "-help" : undefined
									}
								/>
							)}
							{field.help && (
								<small
									id={prefix + field.id + "-help"}
									className="ds-settings-hint"
								>
									{field.help}
								</small>
							)}
						</div>
					))}
					<footer className="ds-settings-footer">
						<output>
							{dirty ? "未適用の変更があります" : "すべての変更を保存済み"}
						</output>
						<Button type="submit" variant="secondary">
							変更一覧を開く
						</Button>
					</footer>
				</form>
			</CardContent>
		</Card>
	);
}

export function SettingsNavigation({
	title,
	entries,
	dirty,
	onOpen,
	onReview,
}: {
	title: string;
	entries: SettingsLink[];
	dirty: boolean;
	onOpen: (id: string) => void;
	onReview: () => void;
}) {
	const [search, setSearch] = useState("");
	const matched = entries.filter((entry) =>
		(entry.label + " " + (entry.description ?? "")).includes(search),
	);
	return (
		<Card className="ds-settings-panel">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<Input
					aria-label="設定項目を探す"
					placeholder="設定項目を探す"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<nav aria-label="設定アーティファクト" className="ds-settings-groups">
					{[...new Set(matched.map((entry) => entry.group))].map((group) => (
						<section key={group}>
							<h3>{group}</h3>
							{matched
								.filter((entry) => entry.group === group)
								.map((entry) => (
									<Button
										key={entry.id}
										variant="ghost"
										className="ds-settings-link"
										disabled={!entry.enabled}
										aria-label={
											entry.enabled ? entry.label : entry.label + "（移行前）"
										}
										onClick={() => onOpen(entry.id)}
									>
										{entry.label}
										<span>{entry.enabled ? "›" : "移行前"}</span>
									</Button>
								))}
						</section>
					))}
				</nav>
				{matched.length === 0 && (
					<p className="ds-settings-hint">一致する設定項目がありません</p>
				)}
				<footer className="ds-settings-footer">
					<output>
						{dirty ? "未適用の変更があります" : "すべての変更を保存済み"}
					</output>
					<Button variant="secondary" onClick={onReview}>
						変更一覧を開く
					</Button>
				</footer>
			</CardContent>
		</Card>
	);
}

export function SettingsChanges({
	title,
	rows,
	dirty,
	busy,
	blocked,
	message,
	onApply,
	onDiscard,
}: {
	title: string;
	rows: SettingsChangeRow[];
	dirty: boolean;
	busy: boolean;
	blocked: boolean;
	message: string;
	onApply: () => void;
	onDiscard: () => void;
}) {
	return (
		<Card className="ds-settings-panel">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="ds-settings-hint">
					この一覧の設定変更をまとめて適用します。辞書や記憶の個別操作は含みません。
				</p>
				<dl className="ds-settings-changes">
					{rows.map((row) => (
						<div key={row.id}>
							<dt>{row.label}</dt>
							<dd>
								<span>{row.before || "（未設定）"}</span>
								<span aria-label="変更後"> → </span>
								<strong>{row.after || "（未設定）"}</strong>
							</dd>
						</div>
					))}
				</dl>
				{rows.length === 0 && <p>未適用の変更はありません</p>}
				<footer className="ds-settings-footer">
					<Button disabled={!dirty || busy || blocked} onClick={onApply}>
						{busy ? "適用中…" : "設定の変更をすべて適用"}
					</Button>
					<Button
						variant="secondary"
						disabled={!dirty || busy}
						onClick={onDiscard}
					>
						未適用の設定変更をすべて破棄
					</Button>
				</footer>
				<output aria-live="polite">{message}</output>
			</CardContent>
		</Card>
	);
}
