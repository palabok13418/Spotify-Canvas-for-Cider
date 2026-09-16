export interface CanvasInfo {
  id: string | null;
  canvasUrl: string | null;
  trackUri: string | null;
}

export function getCanvases(
  spDc: string,
  trackUri: string
): Promise<{
  canvasesList: CanvasInfo[];
}>;
