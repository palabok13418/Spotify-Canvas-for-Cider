import { defineCustomElement } from 'vue';
import {
  addCustomButton,
  addMainMenuEntry,
  createModal,
  definePluginContext,
} from './pluginkit';
import SpotifyNotesPanel from './components/SpotifyNotesPanel.vue';
import SpotifyLoginModal from './components/SpotifyLoginModal.vue';
import PluginConfig from './plugin.config';
import {
  handleOAuthMessage,
  isEnabled,
  setEnabled,
  setSpotifyLoginPromptHandler,
  startBridge,
} from './lib/sync';
import { MUS_API_BASE } from './lib/musApi';

const PREFIX = '[Spotify Notes Bridge]';
console.info(PREFIX, 'plugin entry loaded', {
  version: PluginConfig.version,
  musApiBase: MUS_API_BASE,
});

const PanelElement = defineCustomElement(SpotifyNotesPanel, { shadowRoot: false });
const LoginModalElement = defineCustomElement(SpotifyLoginModal, { shadowRoot: false });

export const CustomElements = {
  'spotify-notes-panel': PanelElement,
  'spotify-notes-login-modal': LoginModalElement,
};

let closeSpotifyLoginModal: (() => void) | null = null;
let spotifyLoginPopup: Window | null = null;
let spotifyLoginNonce = '';
let spotifyLoginModalOpen = false;
let spotifyLoginModalElement: HTMLElement | null = null;

function openSpotifyLoginModal() {
  if (spotifyLoginModalOpen) return true;

  const { openDialog, closeDialog, dialogElement } = createModal({
    escClose: true,
    noDefaultClass: true,
  });

  dialogElement.addEventListener('close', () => {
    closeSpotifyLoginModal = null;
    spotifyLoginModalOpen = false;
    spotifyLoginModalElement = null;
  }, { once: true });

  const element = document.createElement(customElementName('spotify-notes-login-modal'));
  spotifyLoginModalElement = element;
  element.addEventListener('spotify-login-start', () => {
    const opened = launchSpotifyOAuthLogin();
    if (!opened) {
      element.dispatchEvent(new CustomEvent('spotify-login-failed', { bubbles: true, composed: true }));
    }
  });
  element.addEventListener('spotify-login-cancel', () => {
    closeDialog();
    closeSpotifyLoginModal = null;
    spotifyLoginModalOpen = false;
    spotifyLoginModalElement = null;
  });

  dialogElement.appendChild(element);
  spotifyLoginModalOpen = true;
  closeSpotifyLoginModal = () => {
    try {
      closeDialog();
    } catch {}
    closeSpotifyLoginModal = null;
    spotifyLoginModalOpen = false;
    spotifyLoginModalElement = null;
  };

  openDialog();
  return true;
}

function createSpotifyLoginNonce() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }

    const bytes = new Uint8Array(32);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes.some((value) => value !== 0)) {
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }
  } catch (error) {
    console.error(PREFIX, 'unable to create the secure Spotify login nonce', {
      code: 'SPOTIFY_LOGIN_NONCE_GENERATION_FAILED',
      error: String(error),
    });
  }
  return '';
}

function launchSpotifyOAuthLogin() {
  const musApiOrigin = new URL(MUS_API_BASE).origin;

  if (spotifyLoginPopup && !spotifyLoginPopup.closed) {
    try {
      spotifyLoginPopup.focus();
    } catch {}
    return true;
  }

  const loginNonce = createSpotifyLoginNonce();
  if (!loginNonce) {
    console.error(PREFIX, 'Spotify login was blocked because a secure login nonce could not be generated', {
      code: 'SPOTIFY_LOGIN_NONCE_GENERATION_FAILED',
    });
    return false;
  }

  spotifyLoginNonce = loginNonce;

  const url = new URL('/api/spotify/auth', MUS_API_BASE);
  url.searchParams.set('origin', window.location.origin);
  url.searchParams.set('nonce', loginNonce);
  // Do not put the current Cider URL into the authorization request.
  // The signed state already binds the callback to this app origin.
  url.searchParams.set('reason', 'first-run-mirroring');

  const popup = window.open(
    url.toString(),
    'musapi-spotify-auth',
    'width=520,height=760,resizable=yes,scrollbars=yes'
  );

  if (!popup) {
    console.error(PREFIX, 'Spotify login popup was blocked by the host', {
      code: 'SPOTIFY_LOGIN_POPUP_BLOCKED',
      musApiOrigin,
    });
    return false;
  }

  spotifyLoginPopup = popup;
  console.info(PREFIX, 'Spotify sign-in handoff opened from the in-app Liquid Glass prompt', {
    provider: 'Spotify',
    secureFlow: 'oauth',
    credentialsStayWithProvider: true,
  });
  return true;
}

function openPanel(customElementName: (name: string) => string) {
  const { openDialog, dialogElement } = createModal({ escClose: true });
  const element = document.createElement(customElementName('spotify-notes-panel'));
  dialogElement.appendChild(element);
  openDialog();
}

function toggleMirroring() {
  const next = !isEnabled();
  console.info(PREFIX, 'mirroring toggle clicked', { enabled: next });
  setEnabled(next);

  const button = findSpotifyMirroringButton();
  if (button) {
    const label = next ? 'Pause mirroring' : 'Resume mirroring';
    button.textContent = label;
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
  }
}

function findSpotifyMirroringButton(): HTMLElement | null {
  const selectors = [
    'button[title="Pause mirroring"]',
    'button[title="Resume mirroring"]',
    '[role="button"][title="Pause mirroring"]',
    '[role="button"][title="Resume mirroring"]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"]'),
  );

  return candidates.find((element) => {
    const label = [
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();

    return label === 'pause mirroring' || label === 'resume mirroring';
  }) ?? null;
}

function findNotificationButton(): HTMLElement | null {
  const selectors = [
    'button[aria-label*="Notification" i]',
    'button[title*="Notification" i]',
    '[role="button"][aria-label*="Notification" i]',
    '[role="button"][title*="Notification" i]',
    'button[data-tooltip*="Notification" i]',
    '[role="button"][data-tooltip*="Notification" i]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"]'),
  );

  return candidates.find((element) => {
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return label.includes('notification');
  }) ?? null;
}

function registerSpotifyMirroringButton() {
  let registered = false;
  let attempts = 0;

  const tryRegister = () => {
    if (registered) return;

    const pluginSys = (globalThis as any).__PLUGINSYS__;

    if (!pluginSys?.Components?.CustomButtons?.addCustomButton) {
      return;
    }

    try {
      addCustomButton({
        element: isEnabled() ? 'Pause mirroring' : 'Resume mirroring',
        location: 'chrome-top/right',
        title: isEnabled() ? 'Pause mirroring' : 'Resume mirroring',
        menuElement: customElementName('spotify-notes-panel'),
        onClick: () => toggleMirroring(),
      });

      registered = true;
      console.info(PREFIX, 'mirroring button registered', {
        element: isEnabled() ? 'Pause mirroring' : 'Resume mirroring',
        location: 'chrome-top/right',
      });
      moveSpotifyMirroringButtonBeforeNotifications();
    } catch (error) {
      console.warn(PREFIX, 'waiting for Cider CustomButtons API', error);
    }
  };

  tryRegister();

  const registerTimer = window.setInterval(() => {
    tryRegister();

    if (registered) {
      window.clearInterval(registerTimer);
    } else {
      attempts += 1;
      if (attempts >= 80) {
        window.clearInterval(registerTimer);
        console.warn(PREFIX, 'could not register mirroring button after repeated attempts');
      }
    }
  }, 250);

  const observer = new MutationObserver(() => {
    if (registered) {
      moveSpotifyMirroringButtonBeforeNotifications();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.setTimeout(() => observer.disconnect(), 30000);
}

function moveSpotifyMirroringButtonBeforeNotifications() {
  const mirroringButton = findSpotifyMirroringButton();
  const notificationButton = findNotificationButton();

  if (!mirroringButton || !notificationButton) return false;
  if (mirroringButton === notificationButton) return true;

  const parent = notificationButton.parentElement;
  if (!parent) return false;

  if (mirroringButton.parentElement === parent) {
    if (mirroringButton.nextElementSibling !== notificationButton) {
      parent.insertBefore(mirroringButton, notificationButton);
    }
    return true;
  }

  parent.insertBefore(mirroringButton, notificationButton);
  return true;
}

const { plugin, customElementName } = definePluginContext({
  ...PluginConfig,
  CustomElements,

  setup() {
    console.info(PREFIX, 'plugin setup() called', {
      hasCiderApp: Boolean((globalThis as any).CiderApp),
      hasPluginSys: Boolean((globalThis as any).__PLUGINSYS__),
      hasAppleMusicStore: Boolean((globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore),
    });

    const panelName = customElementName('spotify-notes-panel');
    const loginModalName = customElementName('spotify-notes-login-modal');

    if (!customElements.get(panelName)) {
      customElements.define(panelName, PanelElement);
    }

    if (!customElements.get(loginModalName)) {
      customElements.define(loginModalName, LoginModalElement);
    }

    addMainMenuEntry({
      label: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

    console.info(PREFIX, 'main menu entry registered');
    registerSpotifyMirroringButton();

    setSpotifyLoginPromptHandler(() => openSpotifyLoginModal());

    const musApiOrigin = new URL(MUS_API_BASE).origin;

    window.addEventListener('message', (event) => {
      if (event.origin !== musApiOrigin) return;
      if (event.data?.type !== 'musaudio_spotify_oauth') return;

      if (!spotifyLoginPopup || event.source !== spotifyLoginPopup) {
        console.error(PREFIX, 'rejected Spotify OAuth callback message from an unexpected window', {
          code: 'SPOTIFY_OAUTH_MESSAGE_SOURCE_REJECTED',
        });
        return;
      }

      const payload = event.data?.data ?? {};
      const returnedNonce = String(payload?.loginNonce || '').trim();

      if (!spotifyLoginNonce || !returnedNonce || returnedNonce !== spotifyLoginNonce) {
        console.error(PREFIX, 'rejected Spotify OAuth callback because the login nonce did not match', {
          code: 'SPOTIFY_LOGIN_NONCE_MISMATCH',
          hasExpectedNonce: Boolean(spotifyLoginNonce),
          hasReturnedNonce: Boolean(returnedNonce),
        });
        return;
      }

      console.info(PREFIX, 'accepted Spotify OAuth callback message from the expected Mus-API window');
      spotifyLoginPopup = null;
      spotifyLoginNonce = '';

      if (payload?.ok) {
        closeSpotifyLoginModal?.();
      } else {
        spotifyLoginModalElement?.dispatchEvent(
          new CustomEvent('spotify-login-failed', { bubbles: true, composed: true })
        );
      }

      handleOAuthMessage(payload, returnedNonce);
    });

    // The bridge starts when the plugin loads. The panel is only a control surface.
    console.info(PREFIX, 'starting playback mirror bridge behind authentication gate');
    startBridge();
  },
});

export default plugin;
