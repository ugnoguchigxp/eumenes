/** Shown while a request waits for LARM to free memory (the record state stays "queued"). */
export const capacityWaitingMessage =
	"LARMの空きを待っています。ほかの処理が終わりしだい始めます。";
/** Shown when the 30-minute wait limit passed (error code `larm_capacity_timeout`). */
export const capacityTimeoutMessage =
	"LARMの空きを待ちましたが、待てる時間内に空かなかったため中止しました。";
export type CapacityWait = { startedAt: number; count: number };
export const isCapacityWaiting = (item: {
	state: string;
	capacityWait?: CapacityWait;
}) => item.state === "queued" && !!item.capacityWait;
