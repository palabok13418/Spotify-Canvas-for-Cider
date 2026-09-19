export interface AppleArtworkAnalysis {
  duplicate: boolean;
  confidence: number;
  reason:
    | "matched"
    | "apple-artwork-not-detected"
    | "probe-failed"
    | "not-similar"
    | "insufficient-evidence";
  appleArtworkUrl?: string;
}

const PREFIX = "[Canvas for Cider] Artwork Analysis";
const PROBE_TIMEOUT_MS = 2500;
const SAMPLE_POINTS = [0.08, 0.5, 0.92];

function isMediaUrl(value: string) {
  return /^(https?:|blob:)/i.test(value) &&
    /\.(?:mp4|mov|m4v|m3u8)(?:[?#].*)?$/i.test(value);
}

function looksLikeArtworkKey(key: string) {
  return /animated|motion|artwork|video|asset/i.test(key) && !/audio|preview|podcast/i.test(key);
}

function collectObjectUrls(value: unknown, output: string[], seen: Set<unknown>, depth = 0) {
  if (depth > 7 || output.length >= 20 || value === null || value === undefined) return;

  if (typeof value === "string") {
    const candidate = value.trim();
    if (isMediaUrl(candidate) && !output.includes(candidate)) output.push(candidate);
    return;
  }

  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectObjectUrls(item, output, seen, depth + 1);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && looksLikeArtworkKey(key) && isMediaUrl(child)) {
      if (!output.includes(child)) output.push(child);
      continue;
    }
    if (typeof child === "object" && child !== null) {
      collectObjectUrls(child, output, seen, depth + 1);
    }
  }
}

function visibleAppleArtworkVideos(): HTMLVideoElement[] {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("video")];
  return videos
    .filter(video => {
      if (video.closest("canvascider-main-canvas") || video.classList.contains("canvascider-analysis-probe")) return false;
      const rect = video.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 160) return false;
      const ratio = rect.width / Math.max(rect.height, 1);
      if (ratio > 0.92 || ratio < 0.45) return false;

      const context = [
        video.className,
        video.getAttribute("aria-label") || "",
        video.getAttribute("data-testid") || "",
        video.getAttribute("sfc-name") || "",
        video.parentElement?.className || "",
        video.parentElement?.getAttribute("sfc-name") || "",
      ].join(" ").toLowerCase();

      return /artwork|animated|motion|album|immersive/.test(context);
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
}

export function findAppleAnimatedArtworkUrl(): string | null {
  const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.nowPlayingItem;
  const objectUrls: string[] = [];
  collectObjectUrls(store, objectUrls, new Set());

  const visible = visibleAppleArtworkVideos();
  for (const video of visible) {
    const source = video.currentSrc || video.src;
    if (isMediaUrl(source)) return source;
  }

  return objectUrls.find(url => /motion|animated|artwork/i.test(url)) || objectUrls[0] || null;
}

function waitForMediaEvent(media: HTMLMediaElement, event: string, timeoutMs: number) {
  return new Promise<boolean>(resolve => {
    if ((event === "loadedmetadata" && media.readyState >= 1) ||
        (event === "canplay" && media.readyState >= 3)) {
      resolve(true);
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      media.removeEventListener(event, onEvent);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    media.addEventListener(event, onEvent, { once: true });
  });
}

async function createProbe(url: string): Promise<HTMLVideoElement | null> {
  const video = document.createElement("video");
  video.className = "canvascider-analysis-probe";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText = "position:fixed!important;left:-10000px!important;top:-10000px!important;width:2px!important;height:2px!important;opacity:0!important;pointer-events:none!important;";
  document.body.appendChild(video);

  video.src = url;
  try { video.load(); } catch {}

  const metadataReady = await waitForMediaEvent(video, "loadedmetadata", PROBE_TIMEOUT_MS);
  const playable = metadataReady && await waitForMediaEvent(video, "canplay", PROBE_TIMEOUT_MS);
  if (!playable) {
    video.remove();
    return null;
  }

  return video;
}

function captureSignature(video: HTMLVideoElement, canvas: HTMLCanvasElement): number[] | null {
  const width = 24;
  const height = 24;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || video.videoWidth < 1 || video.videoHeight < 1) return null;

  try {
    ctx.drawImage(video, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const signature: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      signature.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    }
    return signature;
  } catch {
    return null;
  }
}

async function captureFrames(video: HTMLVideoElement): Promise<number[][] | null> {
  const canvas = document.createElement("canvas");
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const signatures: number[][] = [];

  for (const point of SAMPLE_POINTS) {
    const target = duration > 0 ? Math.min(duration - 0.05, Math.max(0, duration * point)) : 0;
    try {
      if (Math.abs(video.currentTime - target) > 0.04) {
        video.currentTime = target;
        const seeked = await waitForMediaEvent(video, "seeked", PROBE_TIMEOUT_MS);
        if (!seeked) return null;
      }
      const signature = captureSignature(video, canvas);
      if (!signature) return null;
      signatures.push(signature);
    } catch {
      return null;
    }
  }

  return signatures;
}

function frameSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let error = 0;
  for (let i = 0; i < a.length; i++) error += Math.abs(a[i] - b[i]);
  const meanError = error / a.length;
  return Math.max(0, 1 - meanError);
}

function sequenceSimilarity(a: number[][], b: number[][]) {
  if (!a.length || !b.length) return 0;
  const rowBestA = a.map(frame => Math.max(...b.map(other => frameSimilarity(frame, other))));
  const rowBestB = b.map(frame => Math.max(...a.map(other => frameSimilarity(frame, other))));
  const mean = [...rowBestA, ...rowBestB].reduce((sum, value) => sum + value, 0) / (rowBestA.length + rowBestB.length);
  return mean;
}

export async function analyzeCanvasAgainstAppleArtwork(
  canvasUrl: string,
  signal?: AbortSignal
): Promise<AppleArtworkAnalysis> {
  const appleArtworkUrl = findAppleAnimatedArtworkUrl();
  if (!appleArtworkUrl) {
    return { duplicate: false, confidence: 0, reason: "apple-artwork-not-detected" };
  }

  if (signal?.aborted) {
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl };
  }

  const [apple, spotify] = await Promise.all([
    createProbe(appleArtworkUrl),
    createProbe(canvasUrl),
  ]);

  if (!apple || !spotify) {
    apple?.remove();
    spotify?.remove();
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl };
  }

  try {
    if (signal?.aborted) {
      return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl };
    }

    const appleRatio = apple.videoWidth / Math.max(apple.videoHeight, 1);
    const spotifyRatio = spotify.videoWidth / Math.max(spotify.videoHeight, 1);
    const appleDuration = Number.isFinite(apple.duration) ? apple.duration : 0;
    const spotifyDuration = Number.isFinite(spotify.duration) ? spotify.duration : 0;

    // Apple Music's tall album motion asset is a 3:4 profile. Matching Canvas
    // may have been cropped for Spotify, so aspect ratio is a supporting signal,
    // not a hard requirement.
    const ratioClose = Math.abs(appleRatio - spotifyRatio) <= 0.16 ||
      (appleRatio <= 0.84 && spotifyRatio <= 0.84);
    const durationClose = appleDuration > 0 && spotifyDuration > 0
      ? Math.abs(appleDuration - spotifyDuration) <= 2.5
      : false;

    if (!ratioClose) {
      return { duplicate: false, confidence: 0.25, reason: "insufficient-evidence", appleArtworkUrl };
    }

    const [appleFrames, spotifyFrames] = await Promise.all([
      captureFrames(apple),
      captureFrames(spotify),
    ]);

    if (!appleFrames || !spotifyFrames) {
      return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl };
    }

    const visualSimilarity = sequenceSimilarity(appleFrames, spotifyFrames);
    const confidence = Math.min(
      1,
      visualSimilarity * 0.78 +
      (durationClose ? 0.12 : 0) +
      (ratioClose ? 0.10 : 0)
    );

    const duplicate = confidence >= 0.90 && visualSimilarity >= 0.88;
    return {
      duplicate,
      confidence,
      reason: duplicate ? "matched" : "not-similar",
      appleArtworkUrl,
    };
  } finally {
    apple.remove();
    spotify.remove();
  }
}

export const artworkAnalysisInfo = {
  // Kept small and local because this feature is deliberately fail-open:
  // when artwork cannot be inspected, Canvas still works normally.
  timeoutMs: PROBE_TIMEOUT_MS,
};
