export interface AppleArtworkAnalysis {
  duplicate: boolean;
  confidence: number;
  reason:
    | "matched"
    | "apple-artwork-not-detected"
    | "probe-failed"
    | "not-similar"
    | "insufficient-evidence"
    | "motion-video";
  appleArtworkUrl?: string;
}

const PROBE_TIMEOUT_MS = 2200;
const SAMPLE_POINTS = [0.05, 0.25, 0.5, 0.75, 0.95];

function normalizeMediaUrl(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isMediaUrl(value: string) {
  const candidate = String(value || "").trim();
  if (/^blob:/i.test(candidate)) return true;
  return /^https?:/i.test(candidate) && /\.(?:mp4|mov|m4v|m3u8)(?:[?#].*)?$/i.test(candidate);
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


function findStaticArtworkUrl(): string | null {
  const item = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.nowPlayingItem;
  const attrs = item?.attributes || item || {};
  const values = [
    attrs?.artwork?.url,
    attrs?.artworkUrl,
    attrs?.artworkURL,
    attrs?.artwork?.urlTemplate,
    ...(navigator.mediaSession?.metadata?.artwork || []).map((entry: any) => entry?.src),
  ];

  for (const raw of values) {
    const value = normalizeMediaUrl(raw)
      .replace(/\{w\}/gi, "1200")
      .replace(/\{h\}/gi, "1200")
      .replace(/\{f\}/gi, "jpg")
      .replace(/\{c\}/gi, "bb")
      .trim();
    if (/^https?:/i.test(value)) return value;
  }

  return null;
}

async function createImageProbe(url: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish(new Error("artwork probe timed out")), PROBE_TIMEOUT_MS);

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };

      image.onload = () => finish();
      image.onerror = () => finish(new Error("artwork image failed"));
      image.src = url;
    });

    return image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null;
  } catch {
    return null;
  }
}

function captureImageSignature(image: HTMLImageElement, canvas: HTMLCanvasElement): number[] | null {
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || image.naturalWidth < 1 || image.naturalHeight < 1) return null;

  try {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = (image.naturalWidth - side) / 2;
    const sy = (image.naturalHeight - side) / 2;
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(image, sx, sy, side, side, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const signature: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      signature.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    }
    return signature;
  } catch {
    return null;
  }
}

function frameMotion(frames: number[][]) {
  if (frames.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    total += 1 - frameSimilarity(frames[i - 1], frames[i]);
  }
  return total / (frames.length - 1);
}

function frameDiversity(frames: number[][]) {
  if (frames.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      total += 1 - frameSimilarity(frames[i], frames[j]);
      count++;
    }
  }
  return count ? total / count : 0;
}

const ANALYZER_MODEL = {
  w1: [
    3.10, 2.60, 2.00, 2.40, 1.80,
    1.20, 2.40, 1.80, 2.80, 2.10,
    2.40, 1.90, 2.30, 2.50, 1.70,
    1.40, 2.00, 1.30, 2.60, 2.20,
  ],
  b1: [-4.1, -4.0, -4.2, -4.3],
  w2: [1.10, 1.25, 1.15, 1.05],
  b2: -1.55,
};

function javascriptModelScore(features: number[]) {
  const hidden: number[] = [];
  for (let unit = 0; unit < 4; unit++) {
    let value = ANALYZER_MODEL.b1[unit];
    for (let i = 0; i < 5; i++) {
      value += features[i] * ANALYZER_MODEL.w1[unit * 5 + i];
    }
    hidden.push(Math.max(0, value));
  }

  const logit = ANALYZER_MODEL.b2 +
    hidden.reduce((sum, value, index) => sum + value * ANALYZER_MODEL.w2[index], 0);
  return 1 / (1 + Math.exp(-logit));
}

async function webNNModelScore(features: number[]): Promise<number | null> {
  const ml = (navigator as any).ml;
  const Builder = (globalThis as any).MLGraphBuilder;
  if (!ml?.createContext || typeof Builder !== "function") return null;

  try {
    const context = await ml.createContext({ powerPreference: "low-power" });
    const builder = new Builder(context);
    const input = builder.input("features", { dataType: "float32", shape: [1, 5] });
    const w1 = builder.constant(
      { dataType: "float32", shape: [5, 4] },
      new Float32Array(ANALYZER_MODEL.w1),
    );
    const b1 = builder.constant(
      { dataType: "float32", shape: [1, 4] },
      new Float32Array(ANALYZER_MODEL.b1),
    );
    const w2 = builder.constant(
      { dataType: "float32", shape: [4, 1] },
      new Float32Array(ANALYZER_MODEL.w2),
    );
    const b2 = builder.constant(
      { dataType: "float32", shape: [1, 1] },
      new Float32Array([ANALYZER_MODEL.b2]),
    );

    const hidden = builder.relu(builder.gemm(input, w1, { c: b1 }));
    const logit = builder.gemm(hidden, w2, { c: b2 });
    const one = builder.constant(
      { dataType: "float32", shape: [1, 1] },
      new Float32Array([1]),
    );
    const probability = builder.reciprocal(builder.add(one, builder.exp(builder.neg(logit))));
    const graph = await builder.build({ probability });

    if (typeof context.compute === "function") {
      const output = new Float32Array(1);
      await context.compute(
        graph,
        { features: Float32Array.from(features) },
        { probability: output },
      );
      return Number.isFinite(output[0]) ? Math.max(0, Math.min(1, output[0])) : null;
    }
  } catch {
    return null;
  }

  return null;
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

  collectObjectUrls(item, candidates, new Set<object>());

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
  const appleAnimatedUrl = findAppleAnimatedArtworkUrl();
  const staticArtworkUrl = findStaticArtworkUrl();

  if (!visibleApple && !appleAnimatedUrl && !staticArtworkUrl) {
    return {
      duplicate: false,
      confidence: 0,
      reason: "apple-artwork-not-detected",
    };
  }

  if (signal?.aborted) {
    return {
      duplicate: false,
      confidence: 0,
      reason: "probe-failed",
      appleArtworkUrl: staticArtworkUrl || appleAnimatedUrl || undefined,
    };
  }

  let appleVideo: HTMLVideoElement | null = visibleApple;
  let ownedAppleVideo = false;

  if (!appleVideo && appleAnimatedUrl) {
    appleVideo = await createProbe(appleAnimatedUrl);
    ownedAppleVideo = true;
  }

  const spotifyVideo = await createProbe(canvasUrl);
  if (!spotifyVideo) {
    appleVideo?.remove();
    return {
      duplicate: false,
      confidence: 0,
      reason: "probe-failed",
      appleArtworkUrl: staticArtworkUrl || appleAnimatedUrl || undefined,
    };
  }

  const artworkImage = staticArtworkUrl
    ? await createImageProbe(staticArtworkUrl)
    : null;

  try {
    const spotifyFrames = await captureFrames(spotifyVideo);
    if (!spotifyFrames || spotifyFrames.length < 4) {
      return {
        duplicate: false,
        confidence: 0,
        reason: "probe-failed",
        appleArtworkUrl: staticArtworkUrl || appleAnimatedUrl || undefined,
      };
    }

    let animatedSimilarity = 0;
    if (appleVideo) {
      const appleFrames = visibleApple
        ? await captureVisiblePlaybackFrames(appleVideo, signal)
        : await captureFrames(appleVideo);

      if (appleFrames?.length) {
        animatedSimilarity = sequenceSimilarity(appleFrames, spotifyFrames);
      }
    }

    const staticCanvas = document.createElement("canvas");
    const artworkSignature = artworkImage
      ? captureImageSignature(artworkImage, staticCanvas)
      : null;

    let staticSimilarity = 0;
    let coverPersistence = 0;
    if (artworkSignature) {
      const values = spotifyFrames
        .map(frame => frameSimilarity(frame, artworkSignature))
        .sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)] || 0;
      coverPersistence = values.filter(value => value >= 0.90).length / values.length;
      staticSimilarity = median * 0.70 +
        coverPersistence * 0.30;
    }

    const motion = frameMotion(spotifyFrames);
    const diversity = frameDiversity(spotifyFrames);
    const consistency = artworkSignature
      ? Math.max(
          0,
          1 - Math.sqrt(
            spotifyFrames
              .map(frame => frameSimilarity(frame, artworkSignature))
              .reduce((sum, value, _, values) => {
                const mean = values.reduce((a, b) => a + b, 0) / values.length;
                return sum + (value - mean) ** 2;
              }, 0) / spotifyFrames.length
          ) * 4,
        )
      : 0;

    const baseSimilarity = artworkSignature
      ? staticSimilarity
      : animatedSimilarity;

    const features = [
      baseSimilarity,
      1 - Math.min(1, motion * 4.5),
      artworkSignature ? consistency : Math.max(0, Math.min(1, animatedSimilarity)),
      1 - Math.min(1, diversity * 3.5),
      artworkSignature ? coverPersistence : Math.max(0, Math.min(1, animatedSimilarity)),
    ];

    const webnn = await webNNModelScore(features);
    const mlProbability = webnn ?? javascriptModelScore(features);

    // Static album-cover Canvas: very high visual persistence + low temporal
    // diversity/motion. Real MV Canvas: one cover-like frame is fine, but later
    // scenes must diverge enough to avoid suppression.
    const duplicate =
      Boolean(artworkSignature) &&
      staticSimilarity >= 0.90 &&
      coverPersistence >= 0.66 &&
      motion <= 0.095 &&
      diversity <= 0.125 &&
      mlProbability >= 0.60;

    const confidence = Math.max(
      0,
      Math.min(
        1,
        baseSimilarity * 0.50 +
        coverPersistence * 0.20 +
        (1 - Math.min(1, motion * 4.5)) * 0.12 +
        (1 - Math.min(1, diversity * 3.5)) * 0.08 +
        mlProbability * 0.10,
      ),
    );

    const reason: AppleArtworkAnalysis["reason"] = duplicate
      ? "matched"
      : motion >= 0.10 || diversity >= 0.15
        ? "motion-video"
        : confidence < 0.35
          ? "insufficient-evidence"
          : "not-similar";

    return {
      duplicate,
      confidence,
      reason,
      appleArtworkUrl: staticArtworkUrl || appleAnimatedUrl || undefined,
    };
  } catch {
    return {
      duplicate: false,
      confidence: 0,
      reason: "probe-failed",
      appleArtworkUrl: staticArtworkUrl || appleAnimatedUrl || undefined,
    };
  } finally {
    spotifyVideo.remove();
    if (ownedAppleVideo) appleVideo?.remove();
    artworkImage?.remove?.();
  }
}

export const artworkAnalysisInfo = {
  timeoutMs: PROBE_TIMEOUT_MS,
  samples: SAMPLE_POINTS.length,
  model: "5-feature MLP with WebNN acceleration and JavaScript fallback",
};
