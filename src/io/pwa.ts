// Offline install (PWA): production builds register public/sw.js, which caches the app shell,
// fonts and HDRI. The URL carries the build id so each build installs a fresh cache. Dev servers
// drop any worker left on the origin so Vite's modules are never served stale.

declare const __BUILD_ID__: string;

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?v=${__BUILD_ID__}`).catch((e: unknown) => {
        console.warn('Offline cache unavailable:', e);
      });
    });
  } else {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister()));
  }
}
