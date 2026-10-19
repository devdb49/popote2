"use strict";
/* Démarrage : ouvre le stockage local, puis premier lancement ou accueil. */
(async () => {
  try {
    await Store.open();
  } catch (e) {
    Kiosk.fatal(e.message || "Impossible d'ouvrir le stockage de l'iPad.");
    return;
  }
  Kiosk.sections();   // accueil : choix de la section

  // Hors ligne : le service worker garde une copie de l'application dans l'iPad.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", showVersion);
  }
  showVersion();
})();

// Numéro de version (x.y.z) : lu dans le nom du cache installé par le service worker
async function showVersion() {
  let v = "";
  try {
    const keys = (await caches.keys()).map((k) => /^popote-(\d+\.\d+\.\d+)$/.exec(k)?.[1]).filter(Boolean);
    const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
                            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
    v = keys.sort(cmp).pop() || "";
  } catch (_) {}
  document.querySelectorAll(".app-version").forEach((e) => { e.textContent = v ? "v" + v : "—"; });
}

// Le clavier de l'iPad se ferme quand on touche ailleurs que dans un champ de saisie
document.addEventListener("pointerdown", (ev) => {
  const a = document.activeElement;
  if (!a || !a.matches("input, textarea")) return;
  if (ev.target.closest("input, textarea, select, label")) return;
  a.blur();
}, true);
