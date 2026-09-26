import { defineCustomElement } from 'vue';
import { addCustomButton, addMainMenuEntry, createModal, definePluginContext } from '@ciderapp/pluginkit';
import SpotifyNotesPanel from './components/SpotifyNotesPanel.vue';
import PluginConfig from './plugin.config';
import { handleOAuthMessage, startBridge } from './lib/sync';
import { MUS_API_BASE } from './lib/musApi';

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

    addCustomButton({
      element: '♫',
      location: 'chrome-top/right',
      title: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

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
