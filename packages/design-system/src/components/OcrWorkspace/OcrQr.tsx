import { Button } from "../Button";
import type { OcrWorkspaceProps } from "./types";
export function OcrQr(props: OcrWorkspaceProps & { itemId: string }) {
	const qr = props.qr;
	return (
		<section className="ocr-qr" aria-label="QRコード">
			<h3>QRコード</h3>
			{props.qrError ? (
				<p role="alert">{props.qrError}</p>
			) : !qr ? (
				<p>未実行</p>
			) : (
				<>
					{["queued", "running", "cancelling"].includes(qr.state) && (
						<p role="status">
							{qr.state === "cancelling" ? "取消中" : "QRコードを読取り中"}{" "}
							<Button
								size="sm"
								variant="outline"
								disabled={qr.state === "cancelling"}
								onClick={() => props.onQrCancel?.(props.itemId, qr.id)}
							>
								QR読取りを中止
							</Button>
						</p>
					)}
					{qr.state === "cancelled" && <p>QR読取りを取り消しました。</p>}
					{qr.state === "failed" && (
						<p role="alert">QRコードの読取りに失敗しました。</p>
					)}
					{qr.state === "completed" &&
						(!qr.items?.length ? (
							<p>読み取れるQRコードは見つかりませんでした。</p>
						) : (
							<ol>
								{qr.items.map((item, index) => (
									<li key={index}>
										{item.text === null ? (
											<p>
												文字列として表示できないQRコードです（{item.contentType}
												）。
											</p>
										) : (
											<pre>{item.text}</pre>
										)}
										<div className="ocr-qr-actions">
											<Button
												size="sm"
												variant="outline"
												onClick={() =>
													props.onQrEvidence?.(props.itemId, qr.id, index)
												}
											>
												QRの位置を見る
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={item.text === null}
												onClick={() => props.onCopy?.(item.text!)}
											>
												QRの内容をコピー
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={item.text === null}
												onClick={() =>
													props.onQrIncorporate?.(props.itemId, qr.id, index)
												}
											>
												QRの内容を会話に追加
											</Button>
										</div>
									</li>
								))}
							</ol>
						))}
				</>
			)}
		</section>
	);
}
