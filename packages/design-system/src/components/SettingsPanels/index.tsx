import { useId, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Card, CardContent, CardHeader, CardTitle } from "../Card";
import { Input } from "../Input";
import { BookOpen, Brain, CheckCircle2, ChevronRight, Database, Folder, MessageCircle, Mic, Monitor, Network, Search, ScrollText } from "lucide-react";
import "./style.css";

export type SettingsInputField = {
	id: string;
	label: string;
	help?: string;
	control: "text" | "select" | "toggle" | "range" | "number" | "multiple";
	presentation?: "segmented" | "cards";
	value: string;
	defaultValue?: string;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	step?: number;
	options?: { value: string; label: string }[];
	group?: string;
	detail?: boolean;
	disabled?: boolean;
	searchable?: boolean;
};
export type SettingsFieldGroup = {
	id: string;
	label: string;
	description?: string;
};
export type SettingsPanelAction = {
	id: string;
	label: string;
	group?: string;
	disabled?: boolean;
};
export type SettingsLink = {
	id: string;
	label: string;
	icon?: "conversation" | "voice" | "display" | "connections" | "external" | "memory" | "dictionary" | "checks" | "records" | "world";
	description?: string;
	group: string;
	enabled: boolean;
};
const linkIcons = {
	conversation: MessageCircle,
	voice: Mic,
	display: Monitor,
	connections: Network,
	external: Folder,
	memory: Brain,
	dictionary: BookOpen,
	checks: CheckCircle2,
	records: ScrollText,
	world: Database,
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
	presentation = "default",
	description,
	fields,
	dirty,
	groups = [],
	actions = [],
	busy = false,
	blocked = false,
	message,
	supplement,
	hideFooter = false,
	onChange,
	onReview,
	onAction,
	onApply,
}: {
	title: string;
	presentation?: "default" | "card";
	description?: string;
	fields: SettingsInputField[];
	dirty: boolean;
	groups?: SettingsFieldGroup[];
	actions?: SettingsPanelAction[];
	busy?: boolean;
	blocked?: boolean;
	message?: string;
	supplement?: ReactNode;
	hideFooter?: boolean;
	onChange: (id: string, value: string) => void;
	onReview: () => void;
	onAction?: (id: string) => void;
	onApply?: () => void;
}) {
	const [selected, setSelected] = useState<string>();
	const active = groups.find((g) => g.id === selected) ?? groups[0];
	const visible = fields.filter((f) => !active || f.group === active.id);
	const renderFields = (detail: boolean) =>
		visible
			.filter((f) => !!f.detail === detail)
			.map((field) => (
				<SettingsField key={field.id} field={field} onChange={onChange} />
			));
	return (
		<Card className="ds-settings-panel">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				{description && <p className="ds-settings-hint">{description}</p>}
				{groups.length > 0 && (
					<nav aria-label="設定の区分" className="ds-settings-sections">
						{groups.map((group) => (
							<Button
								key={group.id}
								variant={active?.id === group.id ? "secondary" : "ghost"}
								aria-pressed={active?.id === group.id}
								onClick={() => setSelected(group.id)}
							>
								{group.label}
							</Button>
						))}
					</nav>
				)}
				{active?.description && (
					<p className="ds-settings-hint ds-settings-summary">
						{active.description}
					</p>
				)}
				<form
					className="ds-settings-fields"
					onSubmit={(e) => {
						e.preventDefault();
						if (onApply) {
							if (dirty && !busy && !blocked) onApply();
						} else onReview();
					}}
				>
					{presentation === "card" ? (
						<div className="ds-settings-field-card">{renderFields(false)}</div>
					) : renderFields(false)}
					{visible.some((f) => f.detail) && (
						<details className="ds-settings-details">
							<summary>詳細設定</summary>
							<div className="ds-settings-fields">{renderFields(true)}</div>
						</details>
					)}
					{actions.some((a) => !active || a.group === active.id) && (
						<div className="ds-settings-actions">
							{actions
								.filter((a) => !active || a.group === active.id)
								.map((action) => (
									<Button
										key={action.id}
										type="button"
										variant="secondary"
										disabled={action.disabled}
										onClick={() => onAction?.(action.id)}
									>
										{action.label}
									</Button>
								))}
						</div>
					)}
					{supplement && <div className="ds-settings-supplement">{supplement}</div>}
					{!hideFooter && <SettingsDraftBar dirty={dirty} busy={busy} blocked={blocked} onApply={onApply} onReview={onReview} />}
				</form>
				{message && <output aria-live="polite">{message}</output>}
			</CardContent>
		</Card>
	);
}
export function SettingsDraftBar({ dirty, busy = false, blocked = false, onApply, onReview }: {
	dirty: boolean;
	busy?: boolean;
	blocked?: boolean;
	onApply?: () => void;
	onReview: () => void;
}) {
	return <footer className="ds-settings-footer">
		<output>{dirty ? "未適用の変更があります" : "すべての変更を保存済み"}</output>
		{onApply && <Button type="button" disabled={!dirty || busy || blocked} onClick={onApply}>{busy ? "保存中…" : "設定の変更をすべて保存"}</Button>}
		<Button type="button" variant="secondary" onClick={onReview}>変更一覧を開く</Button>
	</footer>;
}
function SettingsField({
	field,
	onChange,
}: {
	field: SettingsInputField;
	onChange: (id: string, value: string) => void;
}) {
	const prefix = useId();
	const [search, setSearch] = useState("");
	const value = field.value || field.defaultValue || "";
	const props = {
		id: prefix,
		disabled: field.disabled,
		"aria-describedby": field.help ? prefix + "-help" : undefined,
	};
	const change = (value: string) => onChange(field.id, value);
	const options = field.options?.filter(
		(o) =>
			o.value === value ||
			o.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
	);
	return (
		<div className="ds-settings-field">
			{field.control === "multiple" ? (
				<fieldset disabled={field.disabled}>
					<legend>{field.label}</legend>
					<div className="ds-settings-options">
						{field.options?.map((option) => {
							const selected = JSON.parse(field.value) as string[];
							return (
								<label key={option.value}>
									<input
										type="checkbox"
										checked={selected.includes(option.value)}
										onChange={(e) =>
											change(
												JSON.stringify(
													e.target.checked
														? [...selected, option.value]
														: selected.filter((v) => v !== option.value),
												),
											)
										}
									/>
									{option.label}
								</label>
							);
						})}
					</div>
					{field.help && (
						<small className="ds-settings-hint">{field.help}</small>
					)}
				</fieldset>
			) : (
				<>
					{field.presentation && field.control === "select" && !field.searchable ? (
						<span className="ds-settings-field-label">{field.label}</span>
					) : (
						<label htmlFor={prefix}>
							{field.label}
							{field.control === "range" && <span className="ds-settings-value">{value}</span>}
						</label>
					)}
					{field.searchable && (
						<Input
							aria-label={field.label + "を探す"}
							placeholder="候補を探す"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					)}
					{field.control === "select" && field.presentation && !field.searchable ? (
						<div className={`ds-settings-choice-group ds-settings-choice-group-${field.presentation}`} role="group" aria-label={field.label}>
							{field.options?.map((option, index) => (
								<button
									type="button"
									key={option.value}
										className="ds-settings-choice"
										aria-pressed={value === option.value}
										disabled={field.disabled}
										onClick={() => change(option.value)}
									>
										{field.presentation === "cards" && <span className="ds-settings-choice-preview" data-index={index % 4} aria-hidden="true" />}
										<span>{option.label}</span>
									</button>
							))}
						</div>
					) : field.control === "select" ? (
						<select
							{...props}
							value={value}
							onChange={(e) => change(e.target.value)}
						>
							{options?.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
					) : field.control === "toggle" ? (
						<input
							{...props}
							type="checkbox"
							checked={value === "true"}
							onChange={(e) => change(String(e.target.checked))}
						/>
					) : field.control === "range" ? (
						<div className="ds-settings-range">
							<Input {...props} type="range" value={value} min={field.minimum} max={field.maximum} step={field.step} onChange={(e) => change(e.target.value)} />
							<output htmlFor={prefix}>{value}</output>
						</div>
					) : (
						<Input
							{...props}
							type={field.control === "text" ? "text" : field.control}
							value={value}
							maxLength={field.maxLength}
							min={field.minimum}
							max={field.maximum}
							step={field.step}
							onChange={(e) => change(e.target.value)}
						/>
					)}
					{field.help && (
						<small id={prefix + "-help"} className="ds-settings-hint">
							{field.help}
						</small>
					)}
				</>
			)}
		</div>
	);
}

export function SettingsNavigation({
	title,
	entries,
	dirty,
	onOpen,
}: {
	title: string;
	entries: SettingsLink[];
	dirty: boolean;
	onOpen: (id: string) => void;
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
				<div className="ds-settings-search">
					<Search aria-hidden="true" size={19} />
					<Input aria-label="設定項目を探す" placeholder="設定項目を探す" value={search} onChange={(event) => setSearch(event.target.value)} />
				</div>
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
										{entry.icon && (() => { const Icon = linkIcons[entry.icon]; return <Icon aria-hidden="true" size={21} />; })()}
										{entry.label}
										<span>{entry.enabled ? <ChevronRight aria-hidden="true" size={18} /> : "移行前"}</span>
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
				<h3 className="ds-settings-change-count">未適用の変更 {rows.length}件</h3>
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
