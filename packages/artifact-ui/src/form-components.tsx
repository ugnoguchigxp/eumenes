import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	Switch,
	Textarea,
} from "@eumenes/design-system";
import { useEffect, useId, useRef, useState } from "react";
import type {
	ArtifactRequest,
	Field,
	FormResource,
	SettingsResource,
} from "./contracts";
import { Result } from "./result";
import { useArtifactRuntime } from "./runtime";

import { Feedback, useAction } from "./action";

function FieldInput({
	field,
	value,
	onChange,
	disabled,
	prefix,
}: {
	field: Field;
	value: string | boolean;
	onChange: (value: string | boolean) => void;
	disabled: boolean;
	prefix: string;
}) {
	const id = `${prefix}-${field.id}`;
	if (field.type === "radio" || field.type === "checkbox") {
		let selected: string[] = [];
		if (field.type === "checkbox" && typeof value === "string") {
			try {
				const parsed: unknown = JSON.parse(value);
				if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string"))
					selected = parsed;
			} catch {
				/* No selection yet. */
			}
		}
		return (
			<fieldset className="aui-field">
				<legend>
					{field.label}
					{field.required && "（必須）"}
				</legend>
				{field.options?.map((option, index) => (
					<label key={option} className="aui-choice">
						<input
							type={field.type}
							name={id}
							value={option}
							checked={
								field.type === "radio"
									? value === option
									: selected.includes(option)
							}
							onChange={(event) => {
								if (field.type === "radio") onChange(option);
								else
									onChange(
										JSON.stringify(
											event.target.checked
												? [...selected, option]
												: selected.filter((item) => item !== option),
										),
									);
							}}
							disabled={disabled}
							required={field.type === "radio" && field.required && index === 0}
						/>
						{field.optionLabels?.[option] ?? option}
					</label>
				))}
			</fieldset>
		);
	}
	return (
		<label htmlFor={id} className="aui-field">
			{field.label}
			{field.required && "（必須）"}
			{field.type === "boolean" ? (
				<input
					id={id}
					type="checkbox"
					checked={value === true}
					onChange={(e) => onChange(e.target.checked)}
					disabled={disabled}
					required={field.required}
				/>
			) : field.type === "select" ? (
				<select
					id={id}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
				>
					<option value="">選んでください</option>
					{field.options?.map((o) => (
						<option key={o} value={o}>
							{field.optionLabels?.[o] ?? o}
						</option>
					))}
				</select>
			) : field.type === "textarea" ? (
				<Textarea
					id={id}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
					maxLength={2000}
				/>
			) : (
				<Input
					id={id}
					type={field.type}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
					maxLength={2000}
				/>
			)}
		</label>
	);
}

function resolveDefaults({ defaults, fields }: FormResource) {
	const dateFields = fields.filter(
		(field) =>
			field.type === "date" &&
			field.defaultDate === "today" &&
			!Object.hasOwn(defaults, field.id),
	);
	if (!dateFields.length) return defaults;
	const now = new Date();
	const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
	return {
		...defaults,
		...Object.fromEntries(dateFields.map((field) => [field.id, today])),
	};
}

export function SmallForm({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as FormResource;
	const disabled = action.pending || data.disabled === true;
	const [values, setValues] = useState(() => resolveDefaults(data));
	const [dirty, setDirty] = useState(false);
	const defaults = useRef(data.defaults);
	const identity = useRef(data.identity);
	const [sent, setSent] = useState(false);
	const [validationMessage, setValidationMessage] = useState("");
	useEffect(() => {
		if (identity.current !== data.identity) {
			identity.current = data.identity;
			defaults.current = data.defaults;
			setValues(resolveDefaults(data));
			setDirty(false);
			setSent(false);
			setValidationMessage("");
			return;
		}
		// Refresh clean forms after a save, including hidden revision controls.
		// An edited form retains its original precondition so external edits still conflict.
		if (!dirty && defaults.current !== data.defaults) {
			defaults.current = data.defaults;
			setValues(resolveDefaults(data));
		}
	}, [data, dirty]);
	const prefix = useId();
	if (data.submitForm)
		return (
			<div className="aui-row">
				<Button type="submit" form={data.submitForm} disabled={disabled}>
					{data.submitLabel ?? "フォームを送信"}
				</Button>
			</div>
		);
	return (
		<Card>
			{request.title !== "" && (
				<CardHeader>
					<CardTitle>{request.title ?? "希望を入力"}</CardTitle>
				</CardHeader>
			)}
			<CardContent>
				<form
					id={data.externalSubmitId}
					className="aui-stack"
					onSubmit={(e) => {
						e.preventDefault();
						if (
							data.fields.some(
								(field) =>
									field.type === "checkbox" &&
									field.required &&
									(!values[field.id] || values[field.id] === "[]"),
							)
						) {
							setValidationMessage("必須の選択肢を選んでください");
							return;
						}
						setValidationMessage("");
						if (!disabled)
							void action.send("submit", values).then((accepted) => {
								setSent(accepted);
								if (accepted) setDirty(false);
							});
					}}
				>
					{data.fields.map((field) => (
						<FieldInput
							key={field.id}
							prefix={prefix}
							field={field}
							value={
								values[field.id] ??
								(field.type === "boolean"
									? false
									: field.type === "checkbox"
										? "[]"
										: "")
							}
							disabled={disabled}
							onChange={(value) => {
								setDirty(true);
								setSent(false);
								setValidationMessage("");
								setValues((v) => ({ ...v, [field.id]: value }));
							}}
						/>
					))}
					<div className="aui-row">
						{!data.externalSubmitId && (
							<Button type="submit" disabled={disabled}>
								{action.pending
									? "送信中"
									: (data.submitLabel ?? "フォームを送信")}
							</Button>
						)}
						{request.title !== "" && (
							<Button
								type="button"
								variant="secondary"
								disabled={disabled}
								onClick={() => {
									setDirty(false);
									setValues(resolveDefaults(data));
									setSent(false);
									setValidationMessage("");
								}}
							>
								入力をリセット
							</Button>
						)}
					</div>
					<Feedback
						message={
							validationMessage ||
							action.message ||
							(sent ? "送信しました" : "")
						}
					/>
					{data.submitted && (
						<Result
							title="前回受け取った内容"
							entries={data.fields.map((field) => {
								const value = data.submitted![field.id];
								return [
									field.label,
									typeof value === "boolean"
										? value
											? "はい"
											: "いいえ"
										: value || "（未入力）",
								];
							})}
						/>
					)}
				</form>
			</CardContent>
		</Card>
	);
}

export function SettingsForm({ request }: { request: ArtifactRequest }) {
	const runtime = useArtifactRuntime();
	const action = useAction(request);
	const data = action.resource as SettingsResource;
	const [values, setValues] = useState({
		theme: data.theme,
		autoSpeak: data.autoSpeak,
		volume: String(data.volume),
	});
	const prefix = useId();
	const theme = runtime.previewTheme ?? values.theme;
	return (
		<Card
			className={`aui-settings-theme ${runtime.previewTheme === undefined ? `ds-theme-${theme}` : ""}`}
			data-theme={theme}
		>
			<CardHeader>
				<CardTitle>{request.title ?? "表示と音声"}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					className="aui-stack"
					onSubmit={(e) => {
						e.preventDefault();
						void action.send("settings-save", { ...values, theme });
					}}
				>
					<p>
						テーマはこのプレビューに反映します。保存先は試用データです。
						音声再生やアプリの設定は変更しません。
					</p>
					{runtime.previewTheme === undefined && (
						<label>
							表示テーマ
							<select
								aria-label="表示テーマ"
								value={values.theme}
								onChange={(e) =>
									setValues((v) => ({
										...v,
										theme: e.target.value as "light" | "dark",
									}))
								}
								disabled={action.pending}
							>
								<option value="light">ライト</option>
								<option value="dark">ダーク</option>
							</select>
						</label>
					)}
					<label className="aui-row" htmlFor={`${prefix}-speak`}>
						回答を読み上げる
						<Switch
							id={`${prefix}-speak`}
							checked={values.autoSpeak}
							onCheckedChange={(autoSpeak) =>
								setValues((v) => ({ ...v, autoSpeak }))
							}
							disabled={action.pending}
						/>
					</label>
					<label htmlFor={`${prefix}-volume`}>
						音量: {values.volume}
						<input
							id={`${prefix}-volume`}
							type="range"
							min="0"
							max="100"
							value={values.volume}
							onChange={(e) =>
								setValues((v) => ({ ...v, volume: e.target.value }))
							}
							disabled={action.pending}
						/>
					</label>
					<Button type="submit" disabled={action.pending}>
						設定を保存
					</Button>
					<Feedback message={action.message} />
					<Result
						title="試用データの現在値"
						entries={[
							["保存済みのテーマ", data.theme === "dark" ? "ダーク" : "ライト"],
							["読み上げ", data.autoSpeak ? "オン" : "オフ"],
							["音量", String(data.volume)],
						]}
					/>
				</form>
			</CardContent>
		</Card>
	);
}
