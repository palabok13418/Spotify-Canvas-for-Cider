import { ref, watch, type Ref } from 'vue';

type PluginDefinition = {
  setup(): void;
  name: string;
  identifier: string;
  ce_prefix?: string;
  description: string;
  version: string;
  author: string;
  repo: string;
  SettingsElement?: string;
  CustomElements?: Record<string, unknown>;
  pluginKitVersion?: string | number;
};

type MenuItem = {
  label: string;
  icon?: string;
  onClick: (item?: any) => void;
};

type CustomButtonOptions = {
  location: 'chrome-top/right' | 'mojave/player/right';
  element: string;
  menuElement?: string;
  ctxMenuElement?: string;
  title: string;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
};

type CreateModalOptions = {
  escClose?: boolean;
  className?: string[];
  noDefaultClass?: boolean;
  element?: HTMLElement;
};

function ciderPluginSys(): any {
  const host = (globalThis as any).__PLUGINSYS__;
  if (!host) throw new Error('Cider Plugin API is unavailable.');
  return host;
}

function ciderApp(): any {
  const app = (globalThis as any).CiderApp;
  if (!app) throw new Error('CiderApp is unavailable.');
  return app;
}

export function addMainMenuEntry(item: MenuItem): () => void {
  const menu = ciderPluginSys()?.Components?.MainMenu;
  if (!menu?.addMenuItem) throw new Error('Cider main menu API is unavailable.');
  const registered = menu.addMenuItem(item);
  return () => {
    try { menu.removeMenuItem?.(registered); } catch {}
  };
}

export function addCustomButton(opts: CustomButtonOptions): void {
  const buttons = ciderPluginSys()?.Components?.CustomButtons;
  if (!buttons?.addCustomButton) throw new Error('Cider custom button API is unavailable.');
  buttons.addCustomButton(opts);
}

export function createModal(opts: CreateModalOptions = {}) {
  const dialogElement = document.createElement('dialog');
  if (opts.element) dialogElement.appendChild(opts.element);

  const closeDialog = () => {
    try { dialogElement.close(); } catch {}
    dialogElement.remove();
  };

  const openDialog = () => {
    document.body.appendChild(dialogElement);
    if (typeof dialogElement.showModal === 'function') {
      dialogElement.showModal();
    } else {
      dialogElement.setAttribute('open', '');
    }
  };

  if (!opts.noDefaultClass) {
    dialogElement.classList.add('plugin-base-modal');
  }
  for (const className of opts.className ?? []) {
    dialogElement.classList.add(className);
  }
  if (opts.escClose) {
    dialogElement.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog();
    });
  }

  return { openDialog, closeDialog, dialogElement };
}

export function definePluginContext(options: PluginDefinition) {
  const plugin = { ...options, pluginKitVersion: 4 } as PluginDefinition;
  const customElementName = (name: string) =>
    `${options.ce_prefix ?? options.identifier}-${name}`;

  function setupConfig<T extends Record<string, any>>(defaults: T): Ref<T> {
    const configApi = ciderApp()?.config;
    if (!configApi) throw new Error('Cider configuration API is unavailable.');

    const configRoot = configApi.getRef ? configApi.getRef() : configApi;
    configRoot.plugins ??= {};

    const existing = configRoot.plugins[options.identifier];
    const initial = { ...defaults } as T;

    if (existing && typeof existing === 'object') {
      for (const key of Object.keys(defaults) as Array<keyof T>) {
        const value = (existing as any)[key];
        const fallback = defaults[key];
        if (value == null) continue;
        if (typeof value === typeof fallback) {
          (initial as any)[key] = value;
        }
      }
    }

    configRoot.plugins[options.identifier] = { ...initial };
    const cfgRef = ref(initial) as Ref<T>;

    watch(
      cfgRef,
      (value) => {
        const next: Record<string, any> = {};
        for (const key of Object.keys(defaults)) {
          const current = (value as any)[key];
          const fallback = (defaults as any)[key];
          if (typeof current === typeof fallback && current !== undefined) {
            next[key] = current;
          } else {
            next[key] = fallback;
          }
        }
        configRoot.plugins[options.identifier] = next;
      },
      { deep: true }
    );

    return cfgRef;
  }

  return {
    plugin,
    customElementName,
    setupConfig,
    useCPlugin: () => plugin,
  };
}
