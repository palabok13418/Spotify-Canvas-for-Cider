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

const PROBE_TIMEOUT_MS = 2200;
const SAMPLE_POINTS = [0.05, 0.25, 0.5, 0.75, 0.95];

function normalizeMediaUrl(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isMediaUrl(value: string) {
  return /^(https?:|blob:)/i.test(value) &&
    /\.(?:mp4|mov|m4v|m3u8)(?:[?#].*)?$/i.test(value);
}

function collectObjectUrls(value: unknown, output: string[], seen: Set<object>, depth = 0) {
  if (depth > 8 || output.length >= 32 || value === null || value === undefined) return;

  if (typeof value === "string") {
    const candidate = normalizeMediaUrl(value);
    if (isMediaUrl(candidate) && !output.includes(candidate)) output.push(candidate);
    return;
  }

  if (typeof value !== "object") return;
  const object = value as object;
  if (seen.has(object)) return;
  seen.add(object);

  if (Array.isArray(value)) {
    for (const child of value) collectObjectUrls(child, output, seen, depth + 1);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string") {
      const candidate = normalizeMediaUrl(child);
      if (/motionDetailTall|motionDetailPortrait|animated|motion|editorialVideo/i.test(key) && isMediaUrl(candidate)) {
        if (!output.includes(candidate)) output.push(candidate);
      }
      continue;
    }
    collectObjectUrls(child, output, seen, depth + 1);
  }
}

function tallArtworkRatio(rect: DOMRect | { width: number; height: number }) {
  return rect.width / Math.max(rect.height, 1);
}

function visibleAppleArtworkVideos(): HTMLVideoElement[] {
  return [...document.querySelectorAll<HTMLVideoElement>("video")]
    .filter(video => {
      if (video.closest("canvascider-main-canvas") || video.classList.contains("canvascider-analysis-probe")) return false;
      const rect = video.getBoundingClientRect();
      if (rect.width < 110 || rect.height < 160) return false;

      const ratio = tallArtworkRatio(rect);
      if (ratio > 0.92 || ratio < 0.42) return false;

      const context = [
        video.id,
        typeof video.className === "string" ? video.className : "",
        video.getAttribute("aria-label") || "",
        video.getAttribute("data-testid") || "",
        video.getAttribute("sfc-name") || "",
        video.parentElement?.className || "",
        video.parentElement?.getAttribute("sfc-name") || "",
      ].join(" ").toLowerCase();

      return /animated.?artwork|animated artwork|motion|artwork|album|immersive/.test(context);
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
}

function findAppleAnimatedArtworkVideo() {
  return visibleAppleArtworkVideos()[0] || null;
}

export function findAppleAnimatedArtworkUrl(): string | null {
  const item = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.nowPlayingItem;
  const candidates: string[] = [];

  const attrs = item?.attributes || item || {};
  const editorialVideo = attrs?.editorialVideo;
  const preferred = [
    editorialVideo?.motionDetailTall?.video,
    editorialVideo?.motionDetailPortrait?.video,
    editorialVideo?.motionDetailSquare?.video,
  ];

  for (const value of preferred) {
    const url = normalizeMediaUrl(value);
    if (isMediaUrl(url) && !candidates.includes(url)) candidates.push(url);
  }

  collectObjectUrls(item, candidates, new Set());

  const visible = findAppleAnimatedArtworkVideo();
  const visibleSource = visible ? normalizeMediaUrl(visible.currentSrc || visible.src) : "";
  if (isMediaUrl(visibleSource)) return visibleSource;

  return candidates[0] || null;
}

function waitForMediaEvent(
  media: HTMLMediaElement,
  event: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    if ((event === "loadedmetadata" && media.readyState >= 1) ||
        (event === "canplay" && media.readyState >= 3)) {
      resolve(true);
      return;
    }

    let settled = false;
    const onEvent = () => finish(true);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      media.removeEventListener(event, onEvent);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    media.addEventListener(event, onEvent, { once: true });
  });
}

async function createProbe(url: string): Promise<HTMLVideoElement | null> {
  if (!isMediaUrl(url)) return null;
  const video = document.createElement("video");
  video.className = "canvascider-analysis-probe";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText =
    "position:fixed!important;left:-10000px!important;top:-10000px!important;" +
    "width:2px!important;height:2px!important;opacity:0!important;pointer-events:none!important;";
  document.body.appendChild(video);

  video.src = url;
  try { video.load(); } catch {}

  if (!await waitForMediaEvent(video, "loadedmetadata", PROBE_TIMEOUT_MS) ||
      !await waitForMediaEvent(video, "canplay", PROBE_TIMEOUT_MS)) {
    video.remove();
    return null;
  }

  return video;
}

function captureSignature(video: HTMLVideoElement, canvas: HTMLCanvasElement): number[] | null {
  const width = 32;
  const height = 32;
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
    if (!video.isConnected) return null;
    const target = duration > 0
      ? Math.min(Math.max(duration - 0.05, 0), Math.max(0, duration * point))
      : 0;

    try {
      if (Math.abs(video.currentTime - target) > 0.04) {
        const seekPromise = waitForMediaEvent(video, "seeked", PROBE_TIMEOUT_MS);
        video.currentTime = target;
        if (!await seekPromise) return null;
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

async function captureVisiblePlaybackFrames(
  video: HTMLVideoElement,
  signal?: AbortSignal,
): Promise<number[][] | null> {
  const canvas = document.createElement("canvas");
  const signatures: number[][] = [];

  // Never seek Cider's real animated-artwork video. Sampling its current playback
  // position avoids jumping the user's artwork or fighting Cider's player.
  for (let i = 0; i < SAMPLE_POINTS.length; i++) {
    if (signal?.aborted || !video.isConnected) return null;

    const signature = captureSignature(video, canvas);
    if (!signature) return null;
    signatures.push(signature);

    if (i < SAMPLE_POINTS.length - 1) {
      await new Promise(resolve => window.setTimeout(resolve, 110));
    }
  }

  return signatures;
}

function frameSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let error = 0;
  for (let i = 0; i < a.length; i++) error += Math.abs(a[i] - b[i]);
  return Math.max(0, 1 - error / a.length);
}

function sequenceSimilarity(a: number[][], b: number[][]) {
  if (!a.length || !b.length) return 0;
  const ab = a.map(frame => Math.max(...b.map(other => frameSimilarity(frame, other))));
  const ba = b.map(frame => Math.max(...a.map(other => frameSimilarity(frame, other))));
  const all = [...ab, ...ba];
  return all.reduce((sum, value) => sum + value, 0) / all.length;
}

function similarityConfidence(
  visualSimilarity: number,
  appleVideo: HTMLVideoElement,
  canvasVideo: HTMLVideoElement,
) {
  const appleRatio = tallArtworkRatio({ width: appleVideo.videoWidth, height: appleVideo.videoHeight });
  const canvasRatio = tallArtworkRatio({ width: canvasVideo.videoWidth, height: canvasVideo.videoHeight });
  const ratioClose =
    Math.abs(appleRatio - canvasRatio) <= 0.16 ||
    (appleRatio <= 0.84 && canvasRatio <= 0.84);

  const appleDuration = Number.isFinite(appleVideo.duration) ? appleVideo.duration : 0;
  const canvasDuration = Number.isFinite(canvasVideo.duration) ? canvasVideo.duration : 0;
  const durationClose = appleDuration > 0 && canvasDuration > 0
    ? Math.abs(appleDuration - canvasDuration) <= 2.5
    : false;

  return {
    ratioClose,
    durationClose,
    confidence: Math.min(
      1,
      visualSimilarity * 0.78 +
      (durationClose ? 0.12 : 0) +
      (ratioClose ? 0.10 : 0),
    ),
  };
}

export async function analyzeCanvasAgainstAppleArtwork(
  canvasUrl: string,
  signal?: AbortSignal,
): Promise<AppleArtworkAnalysis> {
  const visibleApple = findAppleAnimatedArtworkVideo();
  const appleUrl = findAppleAnimatedArtworkUrl();

  if (!visibleApple && !appleUrl) {
    return {
      duplicate: false,
      confidence: 0,
      reason: "apple-artwork-not-detected",
    };
  }

  if (signal?.aborted) {
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: appleUrl || undefined };
  }

  let appleVideo = visibleApple;
  let spotifyVideo: HTMLVideoElement | null = null;

  if (!appleVideo && appleUrl) appleVideo = await createProbe(appleUrl);
  if (signal?.aborted || !appleVideo) {
    appleVideo?.remove();
    return {
      duplicate: false,
      confidence: 0,
      reason: signal?.aborted ? "probe-failed" : "insufficient-evidence",
      appleArtworkUrl: appleUrl || undefined,
    };
  }

  spotifyVideo = await createProbe(canvasUrl);
  if (!spotifyVideo) {
    if (!visibleApple) appleVideo.remove();
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: appleUrl || undefined };
  }

  try {
    const appleFrames = visibleApple
      ? await captureVisiblePlaybackFrames(appleVideo, signal)
      : await captureFrames(appleVideo);
    const spotifyFrames = await captureFrames(spotifyVideo);

    if (!appleFrames || !spotifyFrames) {
      return {
        duplicate: false,
        confidence: 0,
        reason: "probe-failed",
        appleArtworkUrl: appleUrl || undefined,
      };
    }

    const visualSimilarity = sequenceSimilarity(appleFrames, spotifyFrames);
    const metrics = similarityConfidence(visualSimilarity, appleVideo, spotifyVideo);

    // Require strong visual agreement. Aspect ratio and duration only reinforce
    // a visual match; they never declare two unrelated videos identical.
    const duplicate = metrics.ratioClose &&
      visualSimilarity >= 0.90 &&
      metrics.confidence >= 0.92;

    return {
      duplicate,
      confidence: metrics.confidence,
      reason: duplicate ? "matched" : "not-similar",
      appleArtworkUrl: appleUrl || undefined,
    };
  } catch {
    return {
      duplicate: false,
      confidence: 0,
      reason: "probe-failed",
      appleArtworkUrl: appleUrl || undefined,
    };
  } finally {
    spotifyVideo.remove();
    if (!visibleApple) appleVideo.remove();
  }
}

export const artworkAnalysisInfo = {
  timeoutMs: PROBE_TIMEOUT_MS,
  samples: SAMPLE_POINTS.length,
};
