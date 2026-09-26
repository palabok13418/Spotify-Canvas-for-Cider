import { defineCustomElement } from 'vue';
import {
  addCustomButton,
  addMainMenuEntry,
  createModal,
  definePluginContext,
} from './pluginkit';
import SpotifyNotesPanel from './components/SpotifyNotesPanel.vue';
import PluginConfig from './plugin.config';
import { handleOAuthMessage, isEnabled, setEnabled, startBridge } from './lib/sync';
import { MUS_API_BASE, openSpotifyAuth } from './lib/musApi';

const PanelElement = defineCustomElement(SpotifyNotesPanel, { shadowRoot: false });

export const CustomElements = {
  'spotify-notes-panel': PanelElement,
};

function openPanel(customElementName: (name: string) => string) {
  const { openDialog, dialogElement } = createModal({ escClose: true });
  const element = document.createElement(customElementName('spotify-notes-panel'));
  dialogElement.appendChild(element);
  openDialog();
}

function toggleMirroring() {
  const next = !isEnabled();
  setEnabled(next);

  const button = findSpotifyMirroringButton();
  if (button) {
    button.textContent = next ? 'Pause mirroring' : 'Resume mirroring';
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

function findSpotifyLoginButton(): HTMLElement | null {
  const selectors = [
    'button[title="Log in to Spotify"]',
    'button[aria-label="Log in to Spotify"]',
    '[role="button"][title="Log in to Spotify"]',
    '[role="button"][aria-label="Log in to Spotify"]',
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
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();

    return label === 'log in' || label === 'log in to spotify';
  }) ?? null;
}

function moveSpotifyLoginBeforeNotifications() {
  const loginButton = findSpotifyLoginButton();
  const notificationButton = findNotificationButton();

  if (!loginButton || !notificationButton) return false;
  if (loginButton === notificationButton) return true;

  const parent = notificationButton.parentElement;
  if (!parent) return false;

  if (loginButton.parentElement === parent) {
    if (loginButton.nextElementSibling !== notificationButton) {
      parent.insertBefore(loginButton, notificationButton);
    }
    return true;
  }

  parent.insertBefore(loginButton, notificationButton);
  return true;
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
      console.log('[Spotify Notes Bridge] mirroring button registered');
      moveSpotifyMirroringButtonBeforeNotifications();
    } catch (error) {
      console.warn('[Spotify Notes Bridge] waiting for Cider CustomButtons API', error);
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
        console.warn('[Spotify Notes Bridge] could not register mirroring button');
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
    const panelName = customElementName('spotify-notes-panel');

    if (!customElements.get(panelName)) {
      customElements.define(panelName, PanelElement);
    }

    addMainMenuEntry({
      label: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

    registerSpotifyMirroringButton();

    const musApiOrigin = new URL(MUS_API_BASE).origin;

    window.addEventListener('message', (event) => {
      if (event.origin !== musApiOrigin) return;
      if (event.data?.type !== 'musaudio_spotify_oauth') return;

      handleOAuthMessage(event.data.data);
    });

    // The bridge starts when the plugin loads. The panel is only a control surface.
    startBridge();
  },
});

export default plugin;
