import { Button, ConfirmModal } from "@eumenes/design-system";
import { useState } from "react";
import type { ArtifactEvent, FormResource } from "./contracts";
import type { AppStorageRecord, AppStorageView } from "./ui-studio-contracts";

type Send = (
	action: ArtifactEvent["action"],
	values: ArtifactEvent["values"],
) => void;

function formValue(value: unknown): string | boolean {
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) return JSON.stringify(value);
	return value == null ? "" : String(value);
}

export function storageDefaults(
	storage: AppStorageView,
	form: FormResource,
	record: AppStorageRecord | null,
) {
	const defaults: FormResource["defaults"] = {};
	for (const field of form.fields) {
		const name = storage.inputs[field.id];
		if (name && record && Object.hasOwn(record.values, name))
			defaults[field.id] = formValue(record.values[name]);
		else if (field.type === "boolean") defaults[field.id] = false;
	}
	return defaults;
}

export function storageRecordValues(
	storage: AppStorageView,
	submitted: ArtifactEvent["values"],
	record: AppStorageRecord | null,
) {
	const values = { ...record?.values };
	for (const { name, type } of storage.columns) {
		const field = Object.keys(storage.inputs).find(
			(id) => storage.inputs[id] === name,
		);
		if (!field) continue;
		const raw = submitted[field];
		delete values[name];
		if (raw === undefined || raw === "") continue;
		values[name] =
			type === "boolean"
				? raw === true
				: type === "integer" || type === "number"
					? Number(raw)
					: type === "array" && typeof raw === "string"
						? JSON.parse(raw)
						: raw;
	}
	return values;
}

export function AppStorageRecords({
	appId,
	revision,
	storage,
	selected,
	onSelect,
	pending,
	send,
}: {
	appId: string;
	revision: number;
	storage: AppStorageView;
	selected: AppStorageRecord | null;
	onSelect(record: AppStorageRecord | null): void;
	pending: boolean;
	send: Send;
}) {
	const [deleting, setDeleting] = useState<AppStorageRecord | null>(null);
	if (storage.error)
		return (
			<output className="aui-ui-notice">
				保存した記録を開けません。{storage.error}
			</output>
		);
	if (!storage.operations.includes("list")) return null;
	const canEdit = storage.operations.includes("update");
	const canDelete = storage.operations.includes("delete");
	const page = (value: number) =>
		send("ui-storage-page", { page: String(value) });
	return (
		<section className="aui-ui-storage" aria-label="保存した記録">
			<div className="aui-ui-studio-actions">
				<h3>保存した記録</h3>
				{selected && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onSelect(null)}
					>
						{storage.operations.includes("create")
							? "新しい記録を入力"
							: "記録の編集を閉じる"}
					</Button>
				)}
			</div>
			{storage.rows.length ? (
				<ul className="aui-ui-storage-rows">
					{storage.rows.map((row) => (
						<li key={row.id}>
							<dl>
								{storage.columns.map(({ name, label }) => (
									<div key={name}>
										<dt>{label}</dt>
										<dd>{String(formValue(row.values[name])) || "—"}</dd>
									</div>
								))}
							</dl>
							<div className="aui-ui-studio-actions">
								{canEdit && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={pending}
										aria-pressed={selected?.id === row.id}
										onClick={() => onSelect(row)}
									>
										編集
									</Button>
								)}
								{canDelete && (
									<Button
										type="button"
										variant="outline-destructive"
										size="sm"
										disabled={pending}
										onClick={() => setDeleting(row)}
									>
										記録を削除
									</Button>
								)}
							</div>
						</li>
					))}
				</ul>
			) : (
				<p>このページに記録はありません。</p>
			)}
			{(storage.page > 0 || storage.hasMore) && (
				<div className="aui-ui-studio-actions" aria-label="記録一覧のページ">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending || storage.page === 0}
						onClick={() => page(storage.page - 1)}
					>
						前へ
					</Button>
					<span>{storage.page + 1}ページ</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending || !storage.hasMore}
						onClick={() => page(storage.page + 1)}
					>
						次へ
					</Button>
				</div>
			)}
			<ConfirmModal
				open={!!deleting}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="この記録を削除しますか"
				description="削除した記録は元に戻せません。"
				confirmText="削除する"
				cancelText="やめる"
				variant="destructive"
				onConfirm={() => {
					if (deleting) {
						send("ui-storage-record", {
							appId,
							revision: String(revision),
							collection: storage.collection,
							record: JSON.stringify({
								operation: "delete",
								id: deleting.id,
								expectedRevision: deleting.revision,
							}),
						});
						if (selected?.id === deleting.id) onSelect(null);
					}
					setDeleting(null);
				}}
				onCancel={() => setDeleting(null)}
			/>
		</section>
	);
}
