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

const PROBE_TIMEOUT_MS = 2500;
const SAMPLE_COUNT = 3;
const LIVE_SAMPLE_DELAY_MS = 160;

type AppleArtworkSource = {
  video?: HTMLVideoElement;
  url?: string;
};

function isMediaUrl(value: string) {
  return /^(https?:|blob:)/i.test(value) &&
    /.(?:mp4|mov|m4v|m3u8)(?:[?#].*)?$/i.test(value);
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
  const selectors = [
    "video.animated-artwork-video",
    "video#animated-artwork",
  ];

  const candidates = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) candidates.add(el);
  }

  for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
    if (video.closest("canvascider-main-canvas")) continue;
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 160) continue;
    const ratio = rect.width / Math.max(rect.height, 1);
    if (ratio > 0.95 || ratio < 0.45) continue;

    const context = [
      video.className,
      video.getAttribute("aria-label") || "",
      video.getAttribute("data-testid") || "",
      video.getAttribute("sfc-name") || "",
      video.parentElement?.className || "",
      video.parentElement?.getAttribute("sfc-name") || "",
    ].join(" ").toLowerCase();

    if (/artwork|animated|motion|album|immersive/.test(context)) candidates.add(video);
  }

  return [...candidates]
    .filter(video => {
      const rect = video.getBoundingClientRect();
      return video.isConnected &&
        rect.width >= 120 &&
        rect.height >= 160 &&
        rect.width / Math.max(rect.height, 1) <= 0.95 &&
        video.readyState >= 2;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
}

function findAppleAnimatedArtwork(): AppleArtworkSource | null {
  const visible = visibleAppleArtworkVideos();
  const visibleVideo = visible[0];
  if (visibleVideo) {
    return {
      video: visibleVideo,
      url: visibleVideo.currentSrc || visibleVideo.src || undefined,
    };
  }

  const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.nowPlayingItem;
  const objectUrls: string[] = [];
  collectObjectUrls(store, objectUrls, new Set());
  const url = objectUrls.find(candidate => /motion|animated|artwork/i.test(candidate)) || objectUrls[0];
  return url ? { url } : null;
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

async function captureProbeFrames(video: HTMLVideoElement): Promise<number[][] | null> {
  const canvas = document.createElement("canvas");
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const signatures: number[][] = [];

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const fraction = i / Math.max(1, SAMPLE_COUNT - 1);
    const target = duration > 0
      ? Math.min(duration - 0.05, Math.max(0, duration * (0.12 + fraction * 0.76)))
      : 0;

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

async function captureLiveFrames(video: HTMLVideoElement): Promise<number[][] | null> {
  const canvas = document.createElement("canvas");
  const signatures: number[][] = [];

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const signature = captureSignature(video, canvas);
    if (!signature) return null;
    signatures.push(signature);
    if (i < SAMPLE_COUNT - 1) {
      await new Promise(resolve => window.setTimeout(resolve, LIVE_SAMPLE_DELAY_MS));
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
  const source = findAppleAnimatedArtwork();
  if (!source) {
    return { duplicate: false, confidence: 0, reason: "apple-artwork-not-detected" };
  }

  if (signal?.aborted) {
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: source.url };
  }

  let appleVideo: HTMLVideoElement | null = source.video || null;
  let probe: HTMLVideoElement | null = null;
  if (!appleVideo && source.url) {
    probe = await createProbe(source.url);
    appleVideo = probe;
  }

  if (!appleVideo) {
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: source.url };
  }

  const spotify = await createProbe(canvasUrl);
  if (!spotify) {
    probe?.remove();
    return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: source.url };
  }

  try {
    if (signal?.aborted) {
      return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: source.url };
    }

    const appleRatio = appleVideo.videoWidth / Math.max(appleVideo.videoHeight, 1);
    const spotifyRatio = spotify.videoWidth / Math.max(spotify.videoHeight, 1);
    const appleDuration = Number.isFinite(appleVideo.duration) ? appleVideo.duration : 0;
    const spotifyDuration = Number.isFinite(spotify.duration) ? spotify.duration : 0;

    const ratioClose = Math.abs(appleRatio - spotifyRatio) <= 0.16 ||
      (appleRatio <= 0.84 && spotifyRatio <= 0.84);
    const durationClose = appleDuration > 0 && spotifyDuration > 0
      ? Math.abs(appleDuration - spotifyDuration) <= 2.5
      : false;

    if (!ratioClose) {
      return { duplicate: false, confidence: 0.20, reason: "insufficient-evidence", appleArtworkUrl: source.url };
    }

    const [appleFrames, spotifyFrames] = source.video
      ? await Promise.all([
          captureLiveFrames(appleVideo),
          captureProbeFrames(spotify),
        ])
      : await Promise.all([
          captureProbeFrames(appleVideo),
          captureProbeFrames(spotify),
        ]);

    if (!appleFrames || !spotifyFrames) {
      return { duplicate: false, confidence: 0, reason: "probe-failed", appleArtworkUrl: source.url };
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
      appleArtworkUrl: source.url,
    };
  } finally {
    probe?.remove();
    spotify.remove();
  }
}

export const artworkAnalysisInfo = {
  // This feature is deliberately fail-open. When artwork cannot be inspected,
  // Canvas continues working normally.
  timeoutMs: PROBE_TIMEOUT_MS,
};
