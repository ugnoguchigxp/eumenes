import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../design-system";
import { queryRoots } from "../../queryKeys";

type Client = Pick<
	EumenesClient,
	"identity" | "memoryStatus" | "setMemoryEnabled"
>;

export function MemoryConnectionPanel({ client }: { client: Client }) {
	const cache = useQueryClient();
	const queryKey = [queryRoots.memoryStatus, client.identity];
	const query = useQuery({
		queryKey,
		queryFn: () => client.memoryStatus(),
		retry: false,
	});
	const pending = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function change(enabled: boolean) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			await cache.cancelQueries({ queryKey });
			const saved = await client.setMemoryEnabled(enabled);
			cache.setQueryData(queryKey, saved);
		} catch {
			setError(
				"変更を確認できませんでした。接続状態を読み直してから、もう一度お試しください。",
			);
			await query.refetch();
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	const status = query.data;
	return (
		<Card>
			<CardHeader>
				<CardTitle>会話への接続</CardTitle>
			</CardHeader>
			<CardContent>
				<p>
					保存した好みや事実、会話の目的・決定・未解決事項を回答の参考にします。
				</p>
				<p>
					<output aria-live="polite">
						{busy
							? "切り替え中…"
							: query.isError
								? "接続状態を確認できません"
								: !status
									? "接続状態を確認中…"
									: !status.enabled
										? "非接続"
										: status.healthy
											? "接続中"
											: "利用停止中（接続設定はオン）"}
					</output>
				</p>
				{status && !query.isError && (
					<Button
						variant="secondary"
						disabled={busy || (!status.enabled && !status.healthy)}
						onClick={() => void change(!status.enabled)}
					>
						{status.enabled ? "メモリーを切断" : "メモリーを接続"}
					</Button>
				)}
				<p className="hint">
					切断しても保存した記憶は残り、再接続すると利用を再開します。
					切断前の記憶を使って生成中の回答は採用されません。
					会話履歴は引き続き使われます。
				</p>
				{status && !status.healthy && !query.isError && (
					<p role="alert">
						保存した記憶の整合性を確認できないため、現在は利用していません。
					</p>
				)}
				{error && <p role="alert">{error}</p>}
				{query.isError && (
					<p role="alert">メモリーの接続状態を読み込めません。</p>
				)}
				<Button
					variant="secondary"
					disabled={busy || query.isFetching}
					onClick={() => void query.refetch()}
				>
					接続状態を読み直す
				</Button>
			</CardContent>
		</Card>
	);
}
