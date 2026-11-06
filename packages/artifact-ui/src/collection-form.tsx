import { Button, Input, Textarea } from "@eumenes/design-system";
import { useEffect, useId, useRef, useState } from "react";
import type { CollectionFormField } from "./collection-contracts";
import { useInputStatus } from "./input-status";
import { useArtifactRuntime } from "./runtime";

export function CollectionForm({
	source,
	label,
	fields,
	initial: start,
	busy,
	draft = false,
	notice,
	onSubmit,
}: {
	source: string;
	label: string;
	/** Why the last send did not go through (the dialog stays open). */
	notice?: string;
	fields: CollectionFormField[];
	initial?: Record<string, string | boolean>;
	busy: boolean;
	draft?: boolean;
	onSubmit: (values: Record<string, string | boolean>) => Promise<boolean>;
}) {
	const runtime = useArtifactRuntime();
	const prefix = useId();
	const reportEditing = useInputStatus(source, prefix);
	const uploadGeneration = useRef(0);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState("");
	const [uploadName, setUploadName] = useState("");
	useEffect(
		() => () => {
			uploadGeneration.current++;
		},
		[],
	);
	const initial = () =>
		Object.fromEntries(
			fields.map((f) => [
				f.id,
				start?.[f.id] ??
					(f.control === "toggle"
						? f.defaultValue === "true"
						: (f.defaultValue ?? "")),
			]),
		) as Record<string, string | boolean>;
	const [values, setValues] = useState(initial);
	const edited = JSON.stringify(values) !== JSON.stringify(initial());
	useEffect(() => {
		reportEditing(
			draft && edited
				? `「${label}」に入力中の内容があります。先に「${label}」を押して下書きに追加してください。`
				: null,
		);
	}, [draft, edited, label, reportEditing]);
	const set = (id: string, value: string | boolean) =>
		setValues((old) => ({ ...old, [id]: value }));
	const input = (field: CollectionFormField) => {
		const id = `${prefix}-${field.id}`;
		const value = values[field.id];
		switch (field.control) {
			case "upload":
				return (
					<>
						<input
							id={id}
							type="file"
							accept={field.accept}
							disabled={busy || uploading}
							onChange={async (event) => {
								const file = event.target.files?.[0];
								if (!file) return;
								const generation = ++uploadGeneration.current;
								set(field.id, "");
								setUploadName("");
								setUploadError("");
								setUploading(true);
								try {
									const result = await runtime.uploadFile?.(source, file);
									if (generation !== uploadGeneration.current) return;
									if (result?.status === "accepted" && result.value) {
										set(field.id, result.value);
										setUploadName(file.name);
									} else
										setUploadError(
											result?.message || "ファイルを読み込めませんでした。",
										);
								} catch {
									if (generation === uploadGeneration.current)
										setUploadError("ファイルを読み込めませんでした。");
								} finally {
									if (generation === uploadGeneration.current)
										setUploading(false);
								}
							}}
						/>
						{uploadName && <small>{uploadName}</small>}
					</>
				);
			case "textarea":
				return (
					<Textarea
						id={id}
						value={String(value)}
						maxLength={field.maxLength}
						onChange={(e) => set(field.id, e.target.value)}
					/>
				);
			case "select":
				return (
					<select
						id={id}
						value={String(value)}
						onChange={(e) => set(field.id, e.target.value)}
					>
						{/* The visible state matches the value: nothing is chosen yet. */}
						{!field.options?.some((o) => o.value === "") &&
							String(value) === "" && (
								<option value="">選択してください</option>
							)}
						{field.options?.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				);
			case "toggle":
				return (
					<input
						id={id}
						type="checkbox"
						checked={value === true}
						onChange={(e) => set(field.id, e.target.checked)}
					/>
				);
			default:
				return (
					<Input
						id={id}
						type={
							field.control === "secret"
								? "password"
								: field.control === "number"
									? "number"
									: "text"
						}
						autoComplete="off"
						value={String(value)}
						maxLength={field.maxLength}
						onChange={(e) => set(field.id, e.target.value)}
					/>
				);
		}
	};
	return (
		<form
			className="aui-stack"
			aria-label={label}
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit(values).then((ok) => {
					// Secrets never stay in the form after a send.
					if (ok) setValues(initial());
				});
			}}
		>
			{draft && (
				<p>
					① 入力して「{label}
					」を押し、下書きに追加します。②「設定の変更をすべて保存」で保存します。
				</p>
			)}
			{fields
				.filter(
					(field) =>
						!field.when ||
						field.when.in.includes(values[field.when.key] as never),
				)
				.map((field) => (
					<label key={field.id} htmlFor={`${prefix}-${field.id}`}>
						{field.label}
						{field.required && "（必須）"}
						{input(field)}
						{field.help && <small>{field.help}</small>}
					</label>
				))}
			{notice && <p role="alert">{notice}</p>}
			{uploadError && <p role="alert">{uploadError}</p>}
			<Button type="submit" disabled={busy || uploading}>
				{label}
			</Button>
		</form>
	);
}
