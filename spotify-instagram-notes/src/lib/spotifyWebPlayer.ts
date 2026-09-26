const PREFIX = '[Spotify Notes Bridge]';
const WINDOW_NAME = 'cider-spotify-notes-web-player';
const BASE_URL = 'https://open.spotify.com';

let playerWindow: Window | null = null;
let concealTimer = 0;
let currentTrackId = '';
let currentPlaying = false;

function log(message: string, details?: unknown) {
  if (details === undefined) console.info(PREFIX, message);
  else console.info(PREFIX, message, details);
}

function warn(message: string, details?: unknown) {
  if (details === undefined) console.warn(PREFIX, message);
  else console.warn(PREFIX, message, details);
}

function trackIdFromUri(uri: string) {
  const match = String(uri || '').match(/^spotify:track:([A-Za-z0-9]+)$/);
  return match?.[1] || '';
}

function trackUrl(trackId: string) {
  // Use Spotify's normal Web Player track URL with a share token. Current
  // Spotify Web Player behavior can autoplay a track opened this way when the
  // authenticated Web Player session is already active.
  const url = new URL(`/track/${encodeURIComponent(trackId)}`, BASE_URL);
  url.searchParams.set('si', crypto.randomUUID());
  return url.toString();
}

function concealWindow() {
  clearWindowReference();

  if (!playerWindow || playerWindow.closed) return;

  try {
    // Browsers only permit scripts to reposition/resize a window they opened.
    // Keep the Web Player at the smallest practical size and outside the
    // visible desktop so it does not become a second player surface.
    playerWindow.resizeTo?.(1, 1);
    playerWindow.moveTo?.(-32000, -32000);
    playerWindow.blur?.();
    window.focus?.();
  } catch {}

  // Some hosts restore popup bounds after navigation. Re-apply the concealment
  // while the background player is alive.
  if (!concealTimer) {
    concealTimer = window.setInterval(() => {
      if (!playerWindow || playerWindow.closed) {
        window.clearInterval(concealTimer);
        concealTimer = 0;
        return;
      }
      try {
        playerWindow.resizeTo?.(1, 1);
        playerWindow.moveTo?.(-32000, -32000);
        playerWindow.blur?.();
      } catch {}
    }, 750);
  }
}

function clearWindowReference() {
  if (playerWindow && playerWindow.closed) {
    playerWindow = null;
    if (concealTimer) {
      window.clearInterval(concealTimer);
      concealTimer = 0;
    }
  }
}

export function isSpotifyWebPlayerAvailable() {
  clearWindowReference();
  return Boolean(playerWindow && !playerWindow.closed);
}

export function ensureSpotifyWebPlayer() {
  clearWindowReference();

  if (playerWindow && !playerWindow.closed) {
    return playerWindow;
  }

  const features = [
    'popup=yes',
    'show=false',
    'skipTaskbar=true',
    'width=2',
    'height=2',
    'left=-32000',
    'top=-32000',
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'resizable=no',
    'scrollbars=no',
  ].join(',');

  try {
    playerWindow = window.open(BASE_URL, WINDOW_NAME, features);

    if (!playerWindow) {
      warn('Spotify Web Player background window was blocked by the host');
      return null;
    }

    playerWindow.addEventListener?.('beforeunload', () => {
      playerWindow = null;
      currentTrackId = '';
      currentPlaying = false;
      if (concealTimer) {
        window.clearInterval(concealTimer);
        concealTimer = 0;
      }
    });

    concealWindow();
    window.setTimeout(() => muteSpotifyWebPlayer(), 1500);

    log('Spotify Web Player background session opened', {
      concealed: true,
      size: '1x1',
      position: 'off-screen',
    });
    return playerWindow;
  } catch (error) {
    playerWindow = null;
    warn('failed to open Spotify Web Player background session', error);
    return null;
  }
}

export function startSpotifyWebPlayerSession() {
  return Boolean(ensureSpotifyWebPlayer());
}

export function muteSpotifyWebPlayer() {
  clearWindowReference();

  if (!playerWindow || playerWindow.closed) {
    warn('cannot mute Spotify Web Player because the background window is unavailable');
    return false;
  }

  let attempted = false;

  try {
    // Best-effort: ask the Spotify page whether it handles a bridge message.
    // The page remains cross-origin, so this is intentionally non-invasive.
    playerWindow.postMessage(
      { type: 'cider-spotify-mute-request', key: 'm' },
      'https://open.spotify.com',
    );
    attempted = true;
  } catch (error) {
    warn('Spotify Web Player rejected the mute message', error);
  }

  try {
    // Some Chromium hosts permit focus/keyboard routing to a popup opened by
    // the current page. This does not access Spotify's DOM and is harmless if
    // the host ignores synthetic keyboard events.
    playerWindow.focus?.();
    playerWindow.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        bubbles: true,
        cancelable: true,
      }),
    );
    playerWindow.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'm',
        code: 'KeyM',
        bubbles: true,
        cancelable: true,
      }),
    );
    attempted = true;
  } catch (error) {
    warn('Spotify Web Player keyboard mute attempt was blocked by the browser', error);
  } finally {
    try {
      playerWindow.blur?.();
      window.focus?.();
    } catch {}
  }

  log('requested Spotify Web Player mute', {
    attempted,
    note: 'cross-origin browser security may prevent the page from accepting the synthetic M shortcut',
  });

  return attempted;
}

export function playSpotifyWebTrack(uri: string, positionMs = 0) {
  const trackId = trackIdFromUri(uri);
  if (!trackId) {
    warn('cannot open Spotify Web Player track because the Spotify URI is invalid', { uri });
    return false;
  }

  const win = ensureSpotifyWebPlayer();
  if (!win) return false;

  currentTrackId = trackId;
  currentPlaying = true;

  try {
    win.location.href = trackUrl(trackId);
    concealWindow();
    window.setTimeout(() => muteSpotifyWebPlayer(), 1800);

    log('Spotify Web Player navigated to track', {
      trackId,
      positionMs: Math.max(0, Math.floor(positionMs)),
      note: positionMs > 0 ? 'exact seek is not available through the public Web Player page interface' : null,
    });

    return true;
  } catch (error) {
    warn('failed to navigate Spotify Web Player to track', error);
    return false;
  }
}

export function pauseSpotifyWebPlayer() {
  clearWindowReference();

  if (!playerWindow || playerWindow.closed) {
    currentPlaying = false;
    return false;
  }

  // Cross-origin script access to Spotify's DOM is intentionally not used.
  // Navigating the background media page away from the track stops its media.
  try {
    playerWindow.location.href = 'about:blank';
    concealWindow();
    currentPlaying = false;
    log('Spotify Web Player background session paused');
    return true;
  } catch (error) {
    warn('failed to pause Spotify Web Player background session', error);
    return false;
  }
}

export function stopSpotifyWebPlayerSession() {
  clearWindowReference();

  if (playerWindow && !playerWindow.closed) {
    try {
      playerWindow.close();
    } catch {}
  }

  playerWindow = null;
  if (concealTimer) {
    window.clearInterval(concealTimer);
    concealTimer = 0;
  }
  currentTrackId = '';
  currentPlaying = false;
  log('Spotify Web Player background session closed');
}

export function getSpotifyWebPlayerState() {
  clearWindowReference();

  return {
    available: Boolean(playerWindow && !playerWindow.closed),
    trackId: currentTrackId || null,
    playing: currentPlaying,
  };
}
