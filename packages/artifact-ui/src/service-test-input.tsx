import { Button } from "@eumenes/design-system";
import { useEffect, useRef, useState } from "react";
import type {
	CollectionFormField,
	CollectionRow,
} from "./collection-contracts";
import type { Receipt } from "./contracts";
import { useArtifactRuntime } from "./runtime";

export function TestInput({
	row,
	source,
	busy,
	onReceipt,
}: {
	row: CollectionRow;
	source: string;
	busy: boolean;
	onReceipt: (receipt: Receipt) => void;
}) {
	const runtime = useArtifactRuntime();
	const start = row.actions.find((action) => action.actionId === "start");
	const fields = start?.form?.fields ?? [];
	const defaults = () =>
		Object.fromEntries(
			fields.map((field) => [
				field.id,
				field.id === "text"
					? (row.cells.sample ?? "")
					: (field.defaultValue ?? ""),
			]),
		);
	const [values, setValues] = useState<Record<string, string>>(defaults);
	const [uploadName, setUploadName] = useState("");
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const uploadGeneration = useRef(0);
	const invalidNumber = fields.some((field) => {
		if (field.control !== "number") return false;
		const value = Number(values[field.id]);
		return (
			!Number.isInteger(value) ||
			(field.min !== undefined && value < field.min) ||
			(field.max !== undefined && value > field.max)
		);
	});
	useEffect(
		() => () => {
			uploadGeneration.current++;
		},
		[],
	);
	const set = (id: string, value: string) =>
		setValues((old) => ({ ...old, [id]: value }));
	const renderInput = (field: CollectionFormField) => {
		const common = {
			id: `service-input-${field.id}`,
			disabled: busy || pending || uploading,
		};
		if (field.control === "upload")
			return (
				<>
					<input
						{...common}
						type="file"
						accept={field.accept}
						onChange={async (event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							const generation = ++uploadGeneration.current;
							set(field.id, "");
							setUploadName("");
							setUploading(true);
							setError("");
							try {
								const result = await runtime.uploadFile?.(source, file);
								if (generation !== uploadGeneration.current) return;
								if (result?.status === "accepted" && result.value) {
									set(field.id, result.value);
									setUploadName(file.name);
								} else
									setError(
										result?.message || "WAVファイルを読み込めませんでした。",
									);
							} finally {
								if (generation === uploadGeneration.current)
									setUploading(false);
							}
						}}
					/>
					<small>{uploadName || field.help}</small>
				</>
			);
		if (field.control === "textarea")
			return (
				<textarea
					{...common}
					rows={field.id === "text" ? 5 : 3}
					maxLength={field.maxLength}
					value={values[field.id] ?? ""}
					onChange={(event) => set(field.id, event.target.value)}
				/>
			);
		if (field.control === "select")
			return (
				<select
					{...common}
					value={values[field.id] ?? ""}
					onChange={(event) => set(field.id, event.target.value)}
				>
					{field.options?.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			);
		return (
			<input
				{...common}
				type={field.control === "number" ? "number" : "text"}
				value={values[field.id] ?? ""}
				maxLength={field.maxLength}
				min={field.min}
				max={field.max}
				onChange={(event) => set(field.id, event.target.value)}
			/>
		);
	};
	if (!start?.form)
		return <p>{row.cells.state || "このサービスは個別に試せません。"}</p>;
	return (
		<form
			className="aui-service-input"
			aria-label="入力"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending(true);
				try {
					const receipt = await runtime.dispatch({
						id: crypto.randomUUID(),
						source,
						revision: runtime.snapshot[source]!.revision,
						action: "collection-action",
						values: {
							actionId: start.actionId,
							rowId: row.id,
							guard: start.guard ?? "",
							...values,
						},
					});
					onReceipt(receipt);
				} catch {
					setError("操作に失敗しました。もう一度お試しください。");
				} finally {
					setPending(false);
				}
			}}
		>
			<div className="aui-service-input-heading">
				<h3>入力</h3>
				<button
					type="button"
					disabled={busy || pending}
					onClick={() => {
						setValues((current) => ({
							...current,
							text: row.cells.sample ?? "",
							uploadId: "",
						}));
						uploadGeneration.current++;
						setUploading(false);
						setUploadName("");
						setError("");
					}}
				>
					サンプルを入力
				</button>
			</div>
			{fields.map((field) => (
				<label key={field.id} htmlFor={`service-input-${field.id}`}>
					{field.label}
					{renderInput(field)}
					{field.help && field.control !== "upload" && (
						<small>{field.help}</small>
					)}
				</label>
			))}
			{error && <p role="alert">{error}</p>}
			<small>
				送信先：{row.cells.sourceName}{" "}
				{row.cells.onDemand === "はい" ? "· 実行時に起動します" : ""}
			</small>
			<Button
				type="submit"
				disabled={
					busy ||
					pending ||
					uploading ||
					start.disabled ||
					invalidNumber ||
					(row.cells.kindCode !== "asr" && !values.text?.trim())
				}
			>
				▶{" "}
				{row.cells.kindCode === "image"
					? "画像を生成"
					: row.cells.kindCode === "music"
						? "楽曲を生成"
						: "簡単テストを実行"}
			</Button>
			{start.hint && <small>{start.hint}</small>}
		</form>
	);
}
