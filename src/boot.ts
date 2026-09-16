const PREFIX = "[Canvas for Cider]";

export function bootDiagnostics() {
  console.log(PREFIX, "boot diagnostics", {
    href: globalThis.location?.href ?? null,
    readyState: document.readyState,
    hasCiderApp: Boolean((globalThis as any).CiderApp),
    hasPluginSys: Boolean((globalThis as any).__PLUGINSYS__),
    hasPapi: Boolean((globalThis as any).__PLUGINSYS__?.PAPIInstance),
    mediaSession: Boolean((globalThis as any).navigator?.mediaSession),
  });

  const report = () => console.log(PREFIX, "boot DOM ready", {
    body: Boolean(document.body),
    title: document.title,
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  } else {
    report();
  }
}
