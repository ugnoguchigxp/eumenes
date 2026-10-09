import { useId, useState } from "react";
import { Button } from "@eumenes/design-system";
import {
	designTokens,
	validDesignToken,
	type DesignToken,
	type DesignTokenOverrides,
} from "../../../domains/artifact/designTokens";

function TokenField({
	token,
	value,
	changed,
	onChange,
	onReset,
}: {
	token: DesignToken;
	value: string;
	changed: boolean;
	onChange: (value: string) => void;
	onReset: () => void;
}) {
	const id = useId();
	const [edit, setEdit] = useState<{ base: string; draft: string } | null>(
		null,
	);
	const draft = edit?.base === value ? edit.draft : value;
	const invalid = !validDesignToken(token, draft.trim());
	return (
		<div className="aui-token-field" data-token={token.name}>
			<label htmlFor={id}>
				{token.label}
				<code>{token.name}</code>
			</label>
			<div className="aui-token-value">
				<span
					aria-hidden="true"
					className={`aui-token-swatch aui-token-${token.kind}`}
					style={
						token.kind === "color"
							? { backgroundColor: value }
							: token.name === "--radius"
								? { borderRadius: value }
								: { width: `min(${value}, 100%)` }
					}
				/>
				<input
					id={id}
					aria-label={`トークン ${token.name}`}
					aria-invalid={invalid}
					aria-describedby={invalid ? `${id}-error` : undefined}
					value={draft}
					spellCheck={false}
					onChange={(e) => {
						const next = e.target.value.trim();
						const valid = validDesignToken(token, next);
						setEdit({ base: valid ? next : value, draft: e.target.value });
						if (valid) onChange(next);
					}}
				/>
				<button
					type="button"
					aria-label={`${token.name} を元に戻す`}
					disabled={!changed && !invalid}
					onClick={() => {
						onReset();
						setEdit(null);
					}}
				>
					戻す
				</button>
			</div>
			{invalid && (
				<small id={`${id}-error`} role="alert">
					{token.kind === "color"
						? "#2563eb や hsl(214 78% 46%) などの色を入力してください。"
						: "0px や 0.5rem など、単位付きの0以上の値を入力してください。"}
				</small>
			)}
		</div>
	);
}
export function DesignTokenEditor({
	values,
	overrides,
	onChange,
	onReset,
}: {
	values: Record<string, string>;
	overrides: DesignTokenOverrides;
	onChange: (name: string, value: string | undefined) => void;
	onReset: () => void;
}) {
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("角の丸み");
	const filtered = designTokens.filter((token) =>
		query.trim()
			? `${token.name} ${token.group} ${token.label}`
					.toLowerCase()
					.includes(query.trim().toLowerCase())
			: category === "すべて" || token.group === category,
	);
	return (
		<details className="aui-token-editor">
			<summary>
				デザイントークンを個別に試す（{designTokens.length}項目・変更
				{Object.keys(overrides).length}件）
			</summary>
			<div className="aui-stack">
				<p className="aui-showcase-note">
					個別変更は上のプリセットより優先されます。プレビュー内で使う部品に反映し、色・丸みは左の見本でも確認できます。
				</p>
				<div className="aui-row">
					<label>
						種類
						<select
							aria-label="トークンの種類"
							value={category}
							onChange={(e) => {
								setCategory(e.target.value);
								setQuery("");
							}}
						>
							{[
								"角の丸み",
								"文字",
								"余白・間隔",
								"部品の大きさ",
								"色",
								"すべて",
							].map((group) => (
								<option key={group}>{group}</option>
							))}
						</select>
					</label>
					<label>
						トークンを検索
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</label>
					<Button variant="secondary" onClick={onReset}>
						デザイントークンを初期化
					</Button>
				</div>
				{["角の丸み", "文字", "余白・間隔", "部品の大きさ", "色"].map(
					(group) => {
						const tokens = filtered.filter((token) => token.group === group);
						return tokens.length ? (
							<fieldset key={group}>
								<legend>{group}</legend>
								<div className="aui-token-grid">
									{tokens.map((token) => (
										<TokenField
											key={token.name}
											token={token}
											value={values[token.name]!}
											changed={overrides[token.name] !== undefined}
											onChange={(value) => onChange(token.name, value)}
											onReset={() => onChange(token.name, undefined)}
										/>
									))}
								</div>
							</fieldset>
						) : null;
					},
				)}
				{filtered.length === 0 && <p>該当するトークンがありません。</p>}
			</div>
		</details>
	);
}
