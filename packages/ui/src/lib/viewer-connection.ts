export interface ViewerDisconnectLike {
    code?: string;
    reason?: string | null;
}

export function shouldStopViewerReconnect(data: ViewerDisconnectLike): boolean {
    return data.code === "snapshot_replay";
}
