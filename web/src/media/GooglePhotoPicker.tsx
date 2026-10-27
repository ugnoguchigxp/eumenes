import { useEffect, useRef, useState } from "react";
import { Button, ImageGrid, type ImageGridItem } from "@eumenes/design-system";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import type {
	PhotosView,
	GoogleAccountView,
} from "../../../api/domains/google-accounts/contracts";
import { ApiError } from "../../../client/transport";
import { settleImageImport } from "./upload-image";

const photoMessage = (error: unknown) =>
	error instanceof ApiError && error.message === "photos_authorization_required"
		? "写真を選ぶにはGoogleフォトへの追加の許可が必要です。"
		: error instanceof ApiError && error.message === "photos_permission_denied"
			? "Googleフォトへのアクセスが拒否されました。Google Cloud側でPhotos Picker APIとアクセス権を確認してください。"
			: error instanceof ApiError && error.status === 410
				? "写真選択の有効期限が切れました。選択を解除してもう一度選んでください。"
				: "Googleフォトの操作を完了できませんでした。接続を確認して再確認してください。";

type Props = {
	client: EumenesClient;
	onSelect: (image: ImageGridItem) => void;
};
/** Only Google grants/selection live here. Imported images enter the shared image library. */
export function GooglePhotoPicker({ client, onSelect }: Props) {
	const account = useQuery({
		queryKey: ["google-photo-account", client.identity],
		queryFn: () => client.googleAccount(),
		refetchInterval: 2000,
	});
	return (
		<GooglePhotoPickerAccount
			key={`${client.identity}:${account.data?.revision}:${account.data?.photosAuthorized}`}
			client={client}
			onSelect={onSelect}
			account={account}
		/>
	);
}
function GooglePhotoPickerAccount({
	client,
	onSelect,
	account,
}: Props & { account: UseQueryResult<GoogleAccountView, Error> }) {
	const [session, setSession] = useState<PhotosView | null>();
	const [selected, setSelected] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [attempt, setAttempt] = useState<{
		id: string;
		itemId: string;
		retry?: boolean;
	}>();
	const active = useRef<AbortController | null>(null);
	const stop = () => {
		active.current?.abort();
		active.current = null;
	};
	useEffect(() => () => active.current?.abort(), []);
	const authorized = account.data?.photosAuthorized;
	const revision = account.data?.revision;
	useEffect(() => {
		const controller = new AbortController();
		stop();
		if (authorized)
			void client
				.googlePhotos(controller.signal)
				.then((s) => {
					if (!controller.signal.aborted) setSession(s);
				})
				.catch((e) => {
					if (!controller.signal.aborted) setMessage(photoMessage(e));
				});
		return () => controller.abort();
	}, [client, authorized, revision]);
	useEffect(() => {
		if (session?.status !== "pending") return;
		const controller = new AbortController();
		const timer = setTimeout(
			() => {
				void client
					.readGooglePhotos(session.handle, controller.signal)
					.then((s) => {
						if (!controller.signal.aborted) setSession(s);
					})
					.catch((e) => {
						if (!controller.signal.aborted) setMessage(photoMessage(e));
					});
			},
			Math.max(1000, session.pollAfterMs),
		);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [client, session]);
	async function authorize() {
		if (!account.data) return;
		const popup = window.open("about:blank", "_blank");
		if (popup) popup.opener = null;
		setBusy(true);
		setMessage("");
		try {
			const { url } = await client.connectGooglePhotos(account.data.revision);
			const destination = new URL(url);
			if (destination.origin !== "https://accounts.google.com")
				throw new Error("invalid_authorization_url");
			if (popup) popup.location.href = destination.href;
			else
				setMessage(
					"ブラウザーのポップアップを許可して、写真選択を許可してください。",
				);
			await account.refetch();
		} catch (e) {
			popup?.close();
			setMessage(photoMessage(e));
		} finally {
			setBusy(false);
		}
	}
	async function begin() {
		stop();
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setMessage("");
		try {
			const s = await client.startGooglePhotos(controller.signal);
			if (!controller.signal.aborted) {
				setSession(s);
				setSelected(undefined);
				setAttempt(undefined);
			}
		} catch (e) {
			if (!controller.signal.aborted) setMessage(photoMessage(e));
		} finally {
			if (active.current === controller) {
				active.current = null;
				setBusy(false);
			}
		}
	}
	async function cancel() {
		stop();
		setBusy(false);
		if (!session) return;
		try {
			await client.cancelGooglePhotos(session.handle);
			setSession(null);
			setSelected(undefined);
			setAttempt(undefined);
			setMessage("");
		} catch (e) {
			setMessage(photoMessage(e));
		}
	}
	async function refresh() {
		if (!session) return;
		try {
			setSession(await client.readGooglePhotos(session.handle));
			setMessage("");
		} catch (e) {
			setMessage(photoMessage(e));
		}
	}
	async function importPhoto() {
		if (!session || !selected) return;
		stop();
		const controller = new AbortController();
		active.current = controller;
		const id =
			!attempt || attempt.retry || attempt.itemId !== selected
				? crypto.randomUUID()
				: attempt.id;
		setAttempt({ id, itemId: selected });
		setBusy(true);
		setMessage("写真を取り込んでいます…");
		try {
			const result = await settleImageImport(
				client,
				id,
				() =>
					client.importGooglePhoto(
						id,
						session.handle,
						selected,
						controller.signal,
					),
				controller.signal,
			);
			if (controller.signal.aborted || active.current !== controller) return;
			setMessage(result.message);
			if (result.status === "accepted" && result.value) {
				// The persisted image no longer depends on the short-lived Google session.
				void client.cancelGooglePhotos(session.handle).catch(() => {});
				onSelect({
					id: result.value,
					title: "Googleフォトから取り込んだ画像",
					thumbnailUrl: `/api/images/${encodeURIComponent(result.value)}/content`,
				});
			} else if (result.canRetry)
				setAttempt({ id, itemId: selected, retry: true });
		} catch (e) {
			if (!controller.signal.aborted) setMessage(photoMessage(e));
		} finally {
			if (active.current === controller) {
				active.current = null;
				setBusy(false);
			}
		}
	}
	if (account.isPending) return <output>Google連携を確認しています。</output>;
	if (account.isError)
		return (
			<p role="alert">
				Google連携を確認できません。
				<Button onClick={() => void account.refetch()}>再確認</Button>
			</p>
		);
	return (
		<section aria-label="Googleフォトの写真選択">
			<p>
				Googleフォトで選んだ写真だけを取得し、WebPに変換してLARMへ保存します。
			</p>
			{!authorized ? (
				<Button
					disabled={busy || account.data.pending || !account.data.configured}
					onClick={() => void authorize()}
				>
					{account.data.pending
						? "Googleの許可を待っています…"
						: "写真選択を許可"}
				</Button>
			) : session ? (
				<>
					{session.status === "pending" && (
						<p>
							<a
								href={session.pickerUri}
								target="_blank"
								rel="noopener noreferrer"
							>
								Googleフォトを開いて写真を選ぶ
							</a>
						</p>
					)}
					{session.status === "expired" && (
						<p>
							写真選択の有効期限が切れました。選択を解除してもう一度選んでください。
						</p>
					)}
					<ImageGrid
						mode="select"
						images={session.items}
						selectedId={selected}
						disabled={busy}
						onSelect={(id) => {
							stop();
							setSelected(id);
							setAttempt(undefined);
						}}
					/>
					{session.status === "ready" && (
						<Button
							disabled={!selected || busy}
							onClick={() => void importPhoto()}
						>
							{busy
								? "取込結果を確認中…"
								: attempt?.retry
									? "もう一度取り込む"
									: attempt
										? "取込状態を再確認"
										: "この写真を取り込む"}
						</Button>
					)}
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => void refresh()}
					>
						選択状態を再確認
					</Button>
					<Button variant="outline" onClick={() => void cancel()}>
						写真選択を解除
					</Button>
				</>
			) : (
				<Button
					disabled={busy || session === undefined}
					onClick={() => void begin()}
				>
					Googleフォトで選ぶ
				</Button>
			)}
			{message && <output>{message}</output>}
		</section>
	);
}
