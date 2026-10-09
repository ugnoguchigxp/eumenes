import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import type { ClaimRow } from "../../../../../api/domains/world/contracts";
import { Button } from "../../../design-system";
import { useConversation } from "../../../domains/conversation";
import {
	isWorldOff,
	useWorldClaims,
	useWorldForgets,
	useWorldStatus,
	worldKey,
} from "../../../domains/world/hooks";
import { ClaimDrawer, type ReasonMessage } from "./ClaimDrawer";
import { ClaimTable } from "./ClaimTable";
import { ForgetList } from "./ForgetList";
import "./world.css";

type Client = Pick<
	EumenesClient,
	| "identity"
	| "conversation"
	| "worldStatus"
	| "worldClaims"
	| "worldClaim"
	| "worldForgets"
	| "correctWorldClaim"
	| "retractWorldClaim"
	| "forgetWorldClaim"
>;

const CONVERSATION_ID = "main";
const REASON_CHOICES = 20;

/**
 * World screen (P5-02): what World currently holds, on what grounds, and the
 * explicit ways to correct, retract or forget it. It is data from the ledger
 * and requests to it: the screen decides nothing, draws no graph and edits no
 * edge. It is a settings page: it is never read aloud.
 */
export function WorldPanel({ client }: { client: Client }) {
	const cache = useQueryClient();
	const status = useWorldStatus(client);
	const [scopeChoice, setScopeChoice] = useState<string | undefined>();
	const scopeKey = scopeChoice ?? status.data?.scopes[0]?.scopeKey;
	const listable = status.data?.usable === true;
	const claims = useWorldClaims(client, scopeKey, listable);
	const forgets = useWorldForgets(client, scopeKey, status.isSuccess);
	const conversation = useConversation(client, CONVERSATION_ID);
	const [open, setOpen] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	const opener = useRef<HTMLElement | null>(null);

	const reasons: ReasonMessage[] = useMemo(
		() =>
			(conversation.data?.messages ?? [])
				.filter((m) => m.role === "user")
				.slice(-REASON_CHOICES)
				.reverse()
				.map((m) => ({ id: m.id, text: m.text })),
		[conversation.data],
	);
	const close = () => {
		setOpen(null);
		opener.current?.focus();
	};
	const reload = () =>
		cache.invalidateQueries({ queryKey: worldKey(client.identity) });

	if (status.isPending)
		return <output aria-live="polite">Worldの状態を確認中…</output>;
	if (isWorldOff(status.error))
		return <p>Worldはこの環境でオフです。何も記録せず、会話にも使いません。</p>;
	if (status.isError)
		return (
			<div>
				<p role="alert">Worldの状態を読み込めません。</p>
				<Button variant="secondary" onClick={() => void status.refetch()}>
					読み直す
				</Button>
			</div>
		);
	const world = status.data;
	const pendingForget = (forgets.data?.forgets ?? []).some(
		(f) => f.display !== "complete",
	);

	return (
		<div className="world-panel">
			<p className="world-muted">
				Worldが覚えている主張を、根拠・条件・出典の版とあわせて確認できます。
				ここで行う操作はあなたの明示的な指示として記録され、画面の表示だけを変えることはありません。
			</p>
			{world.scopes.length > 1 && (
				<label className="world-field">
					Scope
					<select
						value={scopeKey}
						onChange={(e) => {
							setScopeChoice(e.target.value);
							setOpen(null);
							setNotice("");
						}}
					>
						{world.scopes.map((s) => (
							<option key={s.scopeKey} value={s.scopeKey}>
								{s.scopeKey}
							</option>
						))}
					</select>
				</label>
			)}
			{!world.enabled && (
				<output>
					Worldは現在オフです（忘却の保護だけが動いています）。主張の一覧と訂正は使えません。
				</output>
			)}
			{world.enabled && !world.usable && (
				<output>Worldを利用できる状態ではありません。</output>
			)}
			{notice && <output>{notice}</output>}
			{listable && (
				<section className="world-section" aria-label="主張の一覧">
					<div className="world-section-head">
						<h3>主張の一覧</h3>
						<Button
							variant="secondary"
							disabled={claims.isFetching}
							onClick={() => void reload()}
						>
							読み直す
						</Button>
					</div>
					{claims.isPending && <p>読み込み中…</p>}
					{claims.isError &&
						(pendingForget ? (
							<output>忘却の処理が終わるまで、一覧を表示できません。</output>
						) : (
							<p role="alert">
								一覧を表示できません。読み直しても表示されない場合は、時間をおいてください。
							</p>
						))}
					{claims.data && !claims.isError && (
						<>
							{!claims.data.complete && (
								<output>
									読み取りの上限に達したため、一部の主張が表示されていません。表示がないことは「存在しない」ではありません。
								</output>
							)}
							{claims.data.stopped > 0 && (
								<output>
									出典が変わったため利用を止めている主張が{claims.data.stopped}
									件あります。
								</output>
							)}
							{claims.data.items.length === 0 ? (
								<p>表示できる主張はありません。</p>
							) : (
								<ClaimTable
									rows={claims.data.items}
									selected={open}
									onOpen={(row: ClaimRow, el) => {
										opener.current = el;
										setNotice("");
										setOpen(row.id);
									}}
								/>
							)}
						</>
					)}
				</section>
			)}
			{open !== null && (
				<ClaimDrawer
					key={open}
					client={client}
					scopeKey={scopeKey}
					claimId={open}
					reasons={reasons}
					onClose={close}
					onPick={(row) => setOpen(row.id)}
					onDone={(message) => {
						setNotice(message);
						setOpen(null);
					}}
				/>
			)}
			{forgets.data ? <ForgetList forgets={forgets.data.forgets} /> : null}
			{forgets.isError && <p role="alert">忘却の状況を読み込めません。</p>}
		</div>
	);
}
