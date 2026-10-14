import { useState } from "react";
import { Button } from "../Button";
import { Card, CardHeader, CardTitle, CardContent } from "../Card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import { RecordList } from "./RecordList";
import { SavedProcedures } from "./SavedProcedures";
import type { RecordsWorkspaceProps } from "./types";
import "./RecordsWorkspace.css";

/** Presentation only. Keeping both panels mounted preserves expanded rows and scroll. */
export function RecordsWorkspace({
	title = "記録",
	compact = false,
	tabs,
	busy,
	message,
	dataDescription,
	dataError,
	onRefresh,
	onQuery,
	onProcedureState,
	onProcedureDelete,
	onDownload,
}: RecordsWorkspaceProps) {
	const [selected, setSelected] = useState(tabs[0]?.id ?? "");
	const active = tabs.some((tab) => tab.id === selected)
		? selected
		: (tabs[0]?.id ?? "");
	return (
		<Card className={`ds-records-workspace${compact ? " ds-records-workspace-compact" : ""}`}>
			<CardHeader className="ds-records-header">
				<div className="ds-records-heading">
					<CardTitle className="ds-records-title">{title}</CardTitle>
					<Button size={compact ? "sm" : "default"} variant="secondary" disabled={busy} onClick={onRefresh}>
						記録を更新
					</Button>
				</div>
			</CardHeader>
			<CardContent className="ds-records-content">
				<Tabs value={active} onValueChange={setSelected}>
					<TabsList aria-label="記録の種類">
						{tabs.map((tab) => (
							<TabsTrigger key={tab.id} value={tab.id}>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
					{tabs.map((tab) => (
						<TabsContent
							key={tab.id}
							value={tab.id}
							forceMount
							hidden={active !== tab.id}
						>
							{tab.description && <p className="ds-records-hint">{tab.description}</p>}
							<div>
								<RecordList
									tab={tab}
									detailMode={compact ? "modal" : "inline"}
									busy={busy}
									onQuery={(query) => onQuery(tab.id, query)}
								/>
								{tab.procedures !== undefined && (
									<details className="ds-records-fold">
										<summary>保存済みの取得手順</summary>
										<p className="ds-records-hint">
											同じ依頼で参照するページです。値は毎回取得し直します。
										</p>
										<SavedProcedures
											items={tab.procedures}
											page={tab.proceduresPage}
											error={tab.proceduresError}
											onQuery={onQuery}
											busy={busy}
											onProcedureState={onProcedureState}
											onProcedureDelete={onProcedureDelete}
										/>
									</details>
								)}
							</div>
						</TabsContent>
					))}
				</Tabs>
				<output aria-live="polite">{message}</output>
				{!compact && <details className="ds-records-fold">
					<summary>データと診断</summary>
					{dataDescription.map((text) => (
						<p key={text}>{text}</p>
					))}
					{dataError && <p role="alert">{dataError}</p>}
					<Button variant="secondary" disabled={busy} onClick={onDownload}>
						診断データを保存
					</Button>
					<p className="ds-records-hint">
						APIキー・会話本文・録音は含めません。
					</p>
				</details>}
			</CardContent>
		</Card>
	);
}
