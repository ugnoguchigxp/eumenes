import { Button } from "../Button";
import type { ObjectRecognitionWorkspaceProps } from "./types";

export function CaptureSaveNotice(
	props: Pick<
		ObjectRecognitionWorkspaceProps,
		| "captureSaveStatus"
		| "captureSaveCanResume"
		| "onCaptureSaveRecheck"
		| "onCaptureSaveResume"
	>,
) {
	const status = props.captureSaveStatus;
	if (!status) return null;
	return (
		<div role="status" className="recognition-message">
			{status === "queued"
				? "撮影画像をLARMに保存中です。"
				: status === "saved"
					? "撮影画像をLARMに保存しました。"
					: status === "failed"
						? "撮影画像をLARMに保存できませんでした。"
						: "撮影画像のLARMへの保存を確認できません。"}
			{status === "unconfirmed" && props.onCaptureSaveRecheck && (
				<Button variant="secondary" onClick={props.onCaptureSaveRecheck}>
					保存状態を再確認
				</Button>
			)}
			{props.captureSaveCanResume && props.onCaptureSaveResume && (
				<Button variant="secondary" onClick={props.onCaptureSaveResume}>
					保存を再開
				</Button>
			)}
		</div>
	);
}
