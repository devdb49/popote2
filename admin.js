"use strict";
/* Gestion sur la tablette : ardoises, paiements, boissons, stocks, journal, responsables, sauvegarde. */

const Admin = (() => {
  const $ = (id) => document.getElementById(id);
  const euro = (c) => (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const fmtDate = (iso, withTime = true) => iso ? new Date(iso).toLocaleString("fr-FR",
    withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" }) : "—";
  const BACKUP_WARN_DAYS = 7;

  function parseEuro(s) {
    s = String(s).replace(/[\s€]/g, "").replace(",", ".").replace(/^−/, "-");
    if (!/^[-+]?\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k !== null && k !== undefined) e.append(k);
    return e;
  }
  // Montants vus du côté de l'usager. En interne balance_cents > 0 = dette.
  // solde(balance) : + reste sur la carte, − à régler. move(amount) : + crédite la carte, − dépense.
  function money(v, signed) {
    const txt = (v < 0 ? "−" : signed && v > 0 ? "+" : "") + euro(Math.abs(v));
    return el("span", { class: "amt " + (v > 0 ? "credit" : v < 0 ? "owed" : "") }, txt);
  }
  const amt = (balance) => money(-balance, false);
  const move = (amount) => money(-amount, true);
  let toastT;
  function toast(msg) {
    $("toast").textContent = msg; $("toast").hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => $("toast").hidden = true, 2600);
  }

  // Toute action passe par ici : session expirée -> retour à la borne.
  async function call(fn) {
    try { return await fn(); }
    catch (e) { if (e.status === 401) { close(); } throw e; }
  }
  const quiet = (p) => p.catch((e) => { if (e.status !== 401) toast(e.message); });

  // Fichier vers l'extérieur : feuille de partage de l'iPad (Fichiers, AirDrop, Mail…)
  async function deliver({ filename, type, text }) {
    const file = new File([text], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      // seulement le fichier : un titre ou un texte serait enregistré à part, dans un fichier texte
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) { if (e.name === "AbortError") return false; }
    }
    const a = el("a", { href: URL.createObjectURL(file), download: filename });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return true;
  }

  // ---------------------------------------------------------------- Pavé des montants
  // Tous les champs en euros et les quantités (data-money, data-int pour un entier) s'ouvrent sur un pavé :
  // chiffres, virgule (montants), effacer — jamais le clavier de l'iPad.
  let np = null;
  function npShow() {
    const v = np.value;
    $("np-value").textContent = (v === "" || v === "-" ? (v || "0") : v) + (np.int ? "" : " €");
    $("np-value").classList.toggle("fresh", np.fresh && v !== "");
  }
  function openNumpad(input) {
    input.blur();                       // ceinture et bretelles : aucun clavier iPad
    const cur = String(input.value || "").replace(/[\s€]/g, "").replace(".", ",").replace(/^−/, "-");
    const int = input.hasAttribute("data-int");      // nombre entier (stock, quantité) : pas de virgule ni d'euros
    np = { input, int, value: (int ? /^-?\d*$/ : /^-?\d*(,\d{0,2})?$/).test(cur) ? cur : "", fresh: true,
           signed: input.hasAttribute("data-signed") };
    $("np-keys").querySelector(".np-dec").disabled = int;
    $("np-label").textContent = input.getAttribute("aria-label") || input.placeholder || "Montant";
    $("np-sign").hidden = !np.signed;
    npShow();
    $("numpad-dlg").showModal();
  }
  function npKey(k) {
    if (!np) return;
    let v = np.value;
    if (k === "ok") {
      const input = np.input, out = v.replace(/,$/, "");
      np = null; $("numpad-dlg").close();
      if (input.value !== out) {
        input.value = out === "-" ? "" : out;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    if (k === "cancel") { np = null; $("numpad-dlg").close(); return; }
    if (np.fresh && /^[\d,]$/.test(k)) v = v.startsWith("-") ? "-" : "";      // 1re touche : remplace l'ancien montant
    np.fresh = false;
    const neg = v.startsWith("-"), body = neg ? v.slice(1) : v;
    if (k === "del") v = v.slice(0, -1);
    else if (k === "clear") v = "";
    else if (k === "sign") { if (np.signed) v = neg ? body : "-" + body; }
    else if (k === ",") { if (!np.int && !body.includes(",")) v = (neg ? "-" : "") + (body || "0") + ","; }
    else if (/^\d$/.test(k)) {
      const [int, dec] = body.split(",");
      if (dec !== undefined ? dec.length < 2 : int.length < 6) {
        v = (neg ? "-" : "") + (int === "0" && dec === undefined ? k : body + k);
      }
    }
    np.value = v;
    npShow();
  }
  $("numpad-dlg").addEventListener("click", (ev) => { const k = ev.target.closest("[data-k]")?.dataset.k; if (k) npKey(k); });
  $("numpad-dlg").addEventListener("cancel", () => { np = null; });
  $("v-admin").addEventListener("click", (ev) => {
    const input = ev.target.closest("input[data-money]");
    if (input && !input.disabled) { ev.preventDefault(); openNumpad(input); }
  });
  // Clavier physique éventuel (Magic Keyboard) : les touches marchent aussi sur le pavé
  document.addEventListener("keydown", (ev) => {
    if (!np) return;
    const map = { Enter: "ok", Escape: "cancel", Backspace: "del", ".": ",", ",": ",", "-": "sign" };
    const k = /^\d$/.test(ev.key) ? ev.key : map[ev.key];
    if (k) { ev.preventDefault(); npKey(k); }
  });

  // ---------------------------------------------------------------- Ouverture / fermeture
  let tab = "users", watch = null;
  function open(startTab = "users") {
    const me = Store.currentAdmin();
    if (!me) return Kiosk.home();
    $("me").textContent = me.username;
    $("adm-section").textContent = Store.sectionName();
    $("v-admin").hidden = false;
    $("v-admin").scrollTop = 0;
    selectTab(startTab);
    clearInterval(watch);
    watch = setInterval(() => { if (!$("v-admin").hidden && !Store.currentAdmin()) close(); }, 10_000);
  }
  function close() {
    clearInterval(watch);
    for (const d of ["numpad-dlg", "user-dlg", "restock-dlg", "drink-dlg"]) if ($(d).open) $(d).close();
    Store.adminLogout();
    $("v-admin").hidden = true;
    Kiosk.home();
  }
  $("logout").addEventListener("click", close);
  // chaque geste prolonge la session responsable
  $("v-admin").addEventListener("pointerdown", () => Store.touchAdmin(), { passive: true });
  $("v-admin").addEventListener("input", () => Store.touchAdmin(), { passive: true });

  // ---------------------------------------------------------------- Onglets
  function selectTab(t) {
    tab = t;
    document.querySelectorAll("#v-admin .tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === t));
    document.querySelectorAll("#v-admin .panel").forEach((p) => p.hidden = p.id !== "t-" + t);
    refresh();
  }
  document.querySelectorAll("#v-admin .tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

  function refresh() {
    quiet(loadStats());
    quiet(({ users: loadUsers, drinks: loadDrinks, log: () => loadLog(true), compta: loadCompta, export: loadExport,
             backup: loadBackup })[tab]());
  }

  async function loadStats() {
    const s = await call(Store.stats);
    const cell = (val, label, cls = "") => el("div", { class: "stat " + cls }, el("b", { class: "num" }, val), el("span", {}, label));
    $("stats").replaceChildren(
      cell(String(s.users), `carte${s.users > 1 ? "s" : ""}`, "owed"),
      cell(String(s.today_qty), `consommations aujourd'hui (${euro(s.today_cents)})`),
      cell(euro(s.today_paid_cents), "encaissé aujourd'hui"),
      cell(String(s.low_stock), "produit(s) en stock bas", s.low_stock ? "warn" : ""),
      s.pending
        ? el("div", { class: "stat warn click", onclick: () => selectTab("users") },
            el("b", { class: "num" }, String(s.pending)), el("span", {}, `carte${s.pending > 1 ? "s" : ""} à valider`))
        : "",
    );
    const info = await call(Store.storageInfo);
    const days = info.last_backup ? (Date.now() - new Date(info.last_backup)) / 86_400_000 : Infinity;
    const warn = $("backup-warn");
    warn.hidden = days < BACKUP_WARN_DAYS || s.users === 0;
    if (!warn.hidden) {
      warn.replaceChildren(info.last_backup
        ? `Dernière sauvegarde il y a ${Math.floor(days)} jours. Les données n'existent que dans cet iPad.`
        : "Aucune sauvegarde n'a encore été faite. Les données n'existent que dans cet iPad.",
        el("button", { class: "btn btn-sm", type: "button", onclick: () => selectTab("backup") }, "Sauvegarder"));
    }
  }

  // ---------------------------------------------------------------- Ardoises
  let qTimer;
  $("user-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => quiet(loadUsers()), 200); });

  async function loadUsers() {
    const users = await call(() => Store.users($("user-q").value));
    $("users-body").replaceChildren(...users.map((u) => el("tr", { class: "click", onclick: () => quiet(openUser(u.id)) },
      el("td", {}, u.name),
      el("td", { class: "r" }, amt(u.balance_cents)),
      el("td", { class: "hide-sm" }, fmtDate(u.last_seen_at, false)),
      el("td", {}, !u.approved ? el("span", { class: "tag low" }, "à valider")
                 : !u.active ? el("span", { class: "tag bad" }, "désactivée")
                   : u.locked ? el("span", { class: "tag bad" }, "bloquée") : ""),
    )));
    $("users-empty").hidden = users.length > 0 || $("user-q").value !== "";
  }

  let cur = null, lastPayAccount = null;
  // Liste des comptes actifs dans un <select> (caisse en premier par défaut)
  function fillAccounts(sel, selected, { all = false, exclude = null } = {}) {
    const list = Store.accounts().filter((a) => a.active && a.id !== exclude);
    const typeLabel = (t) => Store.ACCOUNT_TYPES.find((x) => x.id === t)?.label || t;
    sel.replaceChildren(...(all ? [el("option", { value: "" }, "Tous les comptes")] : []),
      ...list.map((a) => el("option", { value: a.id, selected: a.id === selected },
        a.name.toLowerCase() === typeLabel(a.type).toLowerCase() ? a.name : `${a.name} (${typeLabel(a.type).toLowerCase()})`)));
    if (!all && !list.some((a) => a.id === selected)) {
      const caisse = list.find((a) => a.type === "caisse");
      if (caisse) sel.value = caisse.id;
    }
  }
  async function openUser(id) {
    cur = (await call(() => Store.users(""))).find((u) => u.id === id);
    if (!cur) return;
    $("u-name").textContent = cur.name;
    $("u-balance").replaceChildren("Solde de la carte : ", amt(cur.balance_cents));
    $("u-error").textContent = "";
    $("pay-form").reset(); $("adj-form").reset(); $("code-form").reset(); ucReset();
    $("rename-form").elements.name.value = cur.name;
    $("u-toggle").textContent = cur.active ? "Désactiver la carte" : "Réactiver la carte";
    $("u-locked").hidden = !cur.locked;
    $("u-pending").hidden = cur.approved;
    $("u-delete-zone").hidden = !cur.approved;   // une carte en attente se refuse
    $("pay-form").hidden = !cur.approved;
    $("pay-all").hidden = cur.balance_cents <= 0;
    fillAccounts($("pay-account"), lastPayAccount);
    const h = await call(() => Store.transactions({ user_id: id, limit: 15 }));
    $("u-history").replaceChildren(...h.items.map((t) => el("li", {},
      el("span", { class: t.cancelled ? "struck" : "" }, `${fmtDate(t.ts)} · ${describe(t)}`),
      t.amount_cents ? move(t.amount_cents) : "")));
    if (!h.items.length) $("u-history").append(el("li", { class: "muted" }, "Aucune opération."));
    if (!$("user-dlg").open) $("user-dlg").showModal();
  }
  $("u-close").addEventListener("click", () => $("user-dlg").close());

  async function userAction(fn, okMsg) {
    $("u-error").textContent = "";
    try { await call(fn); toast(okMsg); await openUser(cur.id); quiet(loadUsers()); quiet(loadStats()); }
    catch (e) { $("u-error").textContent = e.message; }
  }

  $("pay-all").addEventListener("click", () => {
    $("pay-form").elements.amount.value = (cur.balance_cents / 100).toFixed(2).replace(".", ",");
  });
  // Liquide → caisse ; chèque, virement, Wero, PayPal → banque (si un compte banque existe). Modifiable.
  $("pay-method").addEventListener("change", (ev) => {
    const type = ev.target.value === "Liquide" ? "caisse" : "banque";
    const acc = Store.accounts().find((a) => a.active && a.type === type);
    if (acc) $("pay-account").value = acc.id;
  });
  $("pay-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, c = parseEuro(f.amount.value);
    if (!c || c <= 0) { $("u-error").textContent = "Montant invalide (ex. 12,50)"; return; }
    lastPayAccount = Number(f.account.value) || null;
    if (!f.method.value) { $("u-error").textContent = "Choisissez le moyen de paiement"; return; }
    userAction(() => Store.payment(cur.id, c, f.method.value, lastPayAccount), `${euro(c)} crédités sur la carte (${f.method.value.toLowerCase()})`);
  });
  // Correction : montant positif, bouton + (crédite la carte) ou − (retire de la carte)
  // (la touche Entrée ne fait rien : il faut toucher + ou −)
  $("adj-form").addEventListener("submit", (ev) => ev.preventDefault());
  $("adj-form").addEventListener("click", (ev) => {
    const sign = ev.target.closest("[data-sign]")?.dataset.sign;
    if (!sign) return;
    const f = $("adj-form").elements, c = parseEuro(String(f.amount.value).replace(/^[+−-]/, ""));
    $("u-error").textContent = "";
    if (!(c > 0)) { $("u-error").textContent = "Montant invalide (ex. 2,50)"; return; }
    if (!f.note.value.trim()) { $("u-error").textContent = "Indiquez le motif de la correction"; return; }
    const plus = sign === "plus";
    // en interne balance_cents > 0 = dette : créditer la carte = diminuer la dette
    userAction(() => Store.adjust(cur.id, plus ? -c : c, f.note.value),
      plus ? `${euro(c)} crédités sur la carte` : `${euro(c)} retirés de la carte`);
  });

  // Nouveau code client : pavé numérique à 6 chiffres, « Valider le code » apparaît quand le code est complet
  const USER_CODE_LEN = 6;
  let ucCode = "";
  function ucRender() {
    $("uc-dots").querySelectorAll("span").forEach((s, i) => s.classList.toggle("on", i < ucCode.length));
    $("uc-ok").hidden = ucCode.length !== USER_CODE_LEN;
  }
  // Le pavé s'ouvre avec « Changer le code » et se referme après « Valider le code » (ou « Annuler »)
  function ucShow(open) {
    $("uc-pad").hidden = !open;
    $("uc-open").textContent = open ? "Annuler" : "Changer le code";
    ucCode = ""; ucRender();
  }
  function ucReset() { ucShow(false); }
  $("uc-open").addEventListener("click", () => { $("u-error").textContent = ""; ucShow($("uc-pad").hidden); });
  $("uc-keypad").addEventListener("click", (ev) => {
    const k = ev.target.closest("button")?.dataset.k;
    if (!k) return;
    $("u-error").textContent = "";
    if (k === "del") ucCode = ucCode.slice(0, -1);
    else if (k === "clear") ucCode = "";
    else if (ucCode.length < USER_CODE_LEN) ucCode += k;
    ucRender();
  });
  $("code-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (ucCode.length !== USER_CODE_LEN) return;
    const code = ucCode;
    ucReset();
    userAction(() => Store.userPatch(cur.id, { code }), "Code changé : communiquez-le à la personne");
  });
  $("rename-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    userAction(() => Store.userPatch(cur.id, { name: ev.target.elements.name.value }), "Identifiant modifié");
  });
  $("u-approve").addEventListener("click", () => userAction(() => Store.approveUser(cur.id), `Carte de ${cur.name} validée`));
  $("u-delete").addEventListener("click", async () => {
    const b = cur.balance_cents;
    const warn = b > 0 ? `\n\nATTENTION : ${euro(b)} restent à régler et seront effacés.`
               : b < 0 ? `\n\nATTENTION : son crédit de ${euro(-b)} sera perdu.` : "";
    if (!confirm(`Supprimer définitivement la carte de ${cur.name} ?${warn}`)) return;
    try {
      await call(() => Store.deleteUser(cur.id));
      $("user-dlg").close(); toast(`Carte de ${cur.name} supprimée`); quiet(loadUsers()); quiet(loadStats());
    } catch (e) { $("u-error").textContent = e.message; }
  });
  $("u-reject").addEventListener("click", async () => {
    if (!confirm(`Refuser la carte de ${cur.name} ? Elle sera supprimée et le nom redeviendra libre.`)) return;
    try {
      await call(() => Store.rejectUser(cur.id));
      $("user-dlg").close(); toast("Carte refusée"); quiet(loadUsers()); quiet(loadStats());
    } catch (e) { $("u-error").textContent = e.message; }
  });
  $("u-unlock").addEventListener("click", () => userAction(() => Store.userPatch(cur.id, { unlock: true }), "Carte débloquée"));
  $("u-toggle").addEventListener("click", () => {
    if (cur.active && !confirm(`Désactiver la carte de ${cur.name} ? Elle ne pourra plus commander.`)) return;
    userAction(() => Store.userPatch(cur.id, { active: !cur.active }), cur.active ? "Carte désactivée" : "Carte réactivée");
  });

  // ---------------------------------------------------------------- Boissons
  async function loadDrinks() {
    const drinks = await call(Store.drinks);
    $("drinks-empty").hidden = drinks.length > 0;
    const rows = [];
    let cat = null;
    for (const d of drinks) {
      if (d.category !== cat) {
        cat = d.category;
        const c = Store.CATEGORIES.find((x) => x.id === cat);
        rows.push(el("tr", { class: "cat-row", "data-cat": cat }, el("th", { colspan: 5 }, `${c?.emoji || ""} ${c?.label || ""}`)));
      }
      rows.push(drinkRow(d));
    }
    $("drinks-body").replaceChildren(...rows);
  }

  function drinkRow(d) {
    const save = async (patch, msg) => {
      try { await call(() => Store.drinkPatch(d.id, patch)); toast(msg); }
      catch (e) { toast(e.message); }
      quiet(loadDrinks()); quiet(loadStats());
    };
    const emoji = el("button", { class: "emoji-btn", type: "button", "aria-label": "Changer l'image" }, Store.emojiFor(d));
    emoji.addEventListener("click", () => pickEmoji((e) => save({ emoji: e }, "Image modifiée")));
    const name = el("input", { name: "name", value: d.name, maxlength: 40, "aria-label": "Nom" });
    const price = el("input", { class: "w-num", inputmode: "none", readonly: true, "data-money": true, "aria-label": "Prix en euros",
                                value: (d.price_cents / 100).toFixed(2).replace(".", ",") });
    name.addEventListener("change", () => name.value.trim() && save({ name: name.value }, "Nom modifié"));
    price.addEventListener("change", () => {
      const c = parseEuro(price.value);
      if (c === null || c < 0) { toast("Prix invalide (ex. 1,50)"); return quiet(loadDrinks()); }
      save({ price_cents: c }, `Prix de ${d.name} : ${euro(c)}`);
    });

    const catSel = el("select", { class: "w-cat", "aria-label": "Catégorie" },
      ...Store.CATEGORIES.map((c) => el("option", { value: c.id, selected: c.id === d.category }, c.label)));
    catSel.addEventListener("change", () => {
      const c = Store.CATEGORIES.find((x) => x.id === catSel.value);
      save({ category: catSel.value }, `${d.name} → ${c.label}`);
    });

    const qty = el("input", { inputmode: "none", readonly: true, "data-money": true, "data-int": true, "data-signed": true,
                              placeholder: "qté", "aria-label": `Quantité — ${d.name}` });
    const stockOp = async (kind) => {
      const n = parseInt(String(qty.value).replace("−", "-"), 10);
      if (!Number.isFinite(n) || (kind === "delta" && n === 0) || (kind === "set" && n < 0)) {
        toast("Quantité invalide"); return;
      }
      if (kind === "delta" && n > 0) return askRestock(d, n);
      try {
        await call(() => Store.drinkStock(d.id, kind === "delta" ? { delta: n } : { set: n }));
        toast(kind === "delta" ? `${n > 0 ? "+" : ""}${n} ${d.name}` : `Stock de ${d.name} : ${n}`);
      } catch (e) { toast(e.message); }
      quiet(loadDrinks()); quiet(loadStats());
    };

    const low = d.stock <= d.low_stock;
    return el("tr", { class: d.active ? "" : "off" },
      el("td", { class: "d-name" }, emoji, name, catSel),
      el("td", { class: "r" }, price),
      el("td", { class: "r" }, el("span", { class: low ? "tag " + (d.stock === 0 ? "bad" : "low") : "amt" }, String(d.stock))),
      el("td", {}, el("div", { class: "stock-cell" }, qty,
        el("button", { class: "btn btn-sm", type: "button", onclick: () => stockOp("delta"),
                       title: "Ajoute (ou retire avec -) la quantité saisie" }, "Ajouter"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => stockOp("set"),
                       title: "Remplace le stock par la quantité comptée" }, "Inventaire"))),
      el("td", { class: "r" }, el("button", { class: "btn btn-sm", type: "button", onclick: () => askDrink(d, save) },
        d.active ? "Retirer…" : "Remettre…")),
    );
  }

  // Retirer / remettre ou supprimer définitivement un produit
  let dd = null;
  function askDrink(d, save) {
    dd = { d, save };
    $("dd-title").textContent = `${Store.emojiFor(d)} ${d.name}`;
    $("dd-info").textContent = `${euro(d.price_cents)} · ${d.stock} en stock` + (d.active ? "" : " · retiré de la borne");
    $("dd-toggle-label").textContent = d.active ? "Retirer de la borne" : "Remettre sur la borne";
    $("dd-toggle-help").textContent = d.active
      ? "Le produit n'est plus proposé mais reste dans la liste, avec son prix et son stock. Vous pourrez le remettre."
      : "Le produit est à nouveau proposé sur la borne, avec son prix et son stock.";
    $("drink-dlg").showModal();
  }
  $("dd-cancel").addEventListener("click", () => { dd = null; $("drink-dlg").close(); });
  $("dd-toggle").addEventListener("click", () => {
    const { d, save } = dd; dd = null; $("drink-dlg").close();
    save({ active: !d.active }, d.active ? `${d.name} retiré de la borne` : `${d.name} remis sur la borne`);
  });
  $("dd-delete").addEventListener("click", async () => {
    const { d } = dd;
    if (!confirm(`Supprimer définitivement « ${d.name} » ?` + (d.stock ? `\nLes ${d.stock} en stock seront retirés.` : "")
                 + "\nCette action ne peut pas être annulée.")) return;
    dd = null; $("drink-dlg").close();
    try { await call(() => Store.drinkDelete(d.id)); toast(`${d.name} supprimé`); }
    catch (e) { toast(e.message); }
    quiet(loadDrinks()); quiet(loadStats());
  });

  // Réassort : quantité saisie dans le tableau, coût d'achat dans une petite fenêtre
  let rs = null, lastBuyAccount = null;
  function askRestock(d, n) {
    rs = { d, n };
    const f = $("restock-form").elements;
    $("restock-form").reset();
    $("rs-title").textContent = `Réassort : ${n} × ${d.name}`;
    $("rs-error").textContent = ""; $("rs-unit").textContent = "";
    fillAccounts($("rs-account"), lastBuyAccount);
    $("restock-dlg").showModal();
  }
  $("restock-form").elements.cost.addEventListener("input", (ev) => {
    const c = parseEuro(ev.target.value);
    $("rs-unit").textContent = c > 0 && rs ? `Soit ${euro(Math.round(c / rs.n))} par unité (vendu ${euro(rs.d.price_cents)}).` : "";
  });
  $("rs-cancel").addEventListener("click", () => { rs = null; $("restock-dlg").close(); });
  $("restock-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!rs) return;
    const f = ev.target.elements, raw = f.cost.value.trim(), c = raw ? parseEuro(raw) : null;
    if (raw && !(c > 0)) { $("rs-error").textContent = "Coût invalide (ex. 18,90) ou laissez vide"; return; }
    lastBuyAccount = Number(f.account.value) || null;
    const { d, n } = rs;
    try {
      await call(() => Store.drinkStock(d.id, { delta: n, ...(c ? { cost_cents: c, account_id: lastBuyAccount } : {}) }));
      rs = null; $("restock-dlg").close();
      toast(`+${n} ${d.name}` + (c ? ` · achat ${euro(c)} en comptabilité` : ""));
    } catch (e) { $("rs-error").textContent = e.message; return; }
    quiet(loadDrinks()); quiet(loadStats());
  });

  $("drink-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, c = parseEuro(f.price.value);
    const stock = f.stock.value === "" ? 0 : parseInt(f.stock.value, 10);
    $("drink-error").textContent = "";
    if (c === null || c < 0) { $("drink-error").textContent = "Prix invalide (ex. 1,50)"; return; }
    if (!Number.isFinite(stock) || stock < 0) { $("drink-error").textContent = "Stock invalide"; return; }
    try {
      if (!f.category.value) { $("drink-error").textContent = "Choisissez une catégorie"; return; }
      await call(() => Store.drinkCreate({ name: f.name.value, emoji: f.emoji.value, price_cents: c, stock,
                                           category: f.category.value }));
      const keep = f.category.value;
      toast(`${f.name.value} ajouté`); ev.target.reset(); f.category.value = keep; setNewEmoji("");
      quiet(loadDrinks()); quiet(loadStats());
    } catch (e) { $("drink-error").textContent = e.message; }
  });

  // Sélecteur d'image (emoji) : pas besoin du clavier emoji de l'iPad
  let emojiCb = null;
  function pickEmoji(cb) { emojiCb = cb; $("emoji-dlg").showModal(); }
  $("emoji-pick").addEventListener("click", (ev) => {
    const e = ev.target.closest("button")?.dataset.e;
    if (!e) return;
    $("emoji-dlg").close(); emojiCb?.(e);
  });
  $("emoji-auto").addEventListener("click", () => { $("emoji-dlg").close(); emojiCb?.(""); });
  $("emoji-close").addEventListener("click", () => $("emoji-dlg").close());

  // Formulaire d'ajout : image choisie, ou automatique d'après le nom et la catégorie
  function setNewEmoji(e) {
    const f = $("drink-form").elements;
    f.emoji.value = e;
    $("new-emoji").textContent = e || (f.name.value || f.category.value
      ? Store.suggestEmoji(f.name.value, f.category.value) : "＋");
    $("new-emoji").classList.toggle("auto", !e);
  }
  $("new-emoji").addEventListener("click", () => pickEmoji(setNewEmoji));
  ["name", "category"].forEach((n) => $("drink-form").elements[n].addEventListener("input", () => {
    if (!$("drink-form").elements.emoji.value) setNewEmoji("");
  }));

  // ---------------------------------------------------------------- Journal
  const KIND = { setting: "Réglage", card: "Carte", order: "Commande", payment: "Paiement", adjust: "Correction", stock: "Stock",
                 price: "Prix", cancel: "Annulation" };
  function describe(t) {
    switch (t.kind) {
      case "setting": return t.note;
      case "card":    return `${t.user_name} : ${t.note}`;
      case "order":   return `${t.user_name} — ${t.qty} × ${t.drink_name}`;
      case "payment": return `Recharge ${t.user_name}${t.note ? " (" + t.note + ")" : ""}`;
      case "adjust":  return `Correction ${t.user_name} — ${t.note || ""}`;
      case "stock":   return `${t.drink_name} : ${t.stock_delta > 0 ? "+" : ""}${t.stock_delta} (${t.note || "stock"})`;
      case "price":   return `${t.drink_name} : ${t.note}`;
      case "cancel":  return `${t.note}${t.user_name ? " — " + t.user_name : ""}${t.drink_name ? " · " + t.drink_name : ""}`;
      default:        return KIND[t.kind] || t.kind;
    }
  }

  let logOffset = 0;
  async function loadLog(reset) {
    if (reset) logOffset = 0;
    const r = await call(() => Store.transactions({
      kind: $("log-kind").value || undefined, date_from: $("log-from").value || undefined,
      date_to: $("log-to").value || undefined, limit: 50, offset: logOffset }));
    const rows = r.items.map((t) => el("tr", {},
      el("td", { class: "num" }, fmtDate(t.ts)),
      el("td", { class: t.cancelled ? "struck" : "" }, describe(t)),
      el("td", { class: "r" }, t.amount_cents ? move(t.amount_cents) : ""),
      el("td", { class: "hide-sm muted" }, t.admin || "borne"),
      el("td", { class: "r" }, ["order", "payment", "adjust"].includes(t.kind) && !t.cancelled
        ? el("button", { class: "btn btn-sm", type: "button", onclick: () => cancelTx(t) }, "Annuler") : ""),
    ));
    if (reset) $("log-body").replaceChildren(...rows); else $("log-body").append(...rows);
    logOffset += r.items.length;
    $("log-more").hidden = logOffset >= r.total;
  }
  async function cancelTx(t) {
    if (!confirm(`Annuler cette opération ?\n${describe(t)}\nLe solde${t.kind === "order" ? " et le stock seront corrigés" : " sera corrigé"}.`)) return;
    try { await call(() => Store.cancel(t.id)); toast("Opération annulée"); }
    catch (e) { toast(e.message); }
    quiet(loadLog(true)); quiet(loadStats());
  }
  ["log-kind", "log-from", "log-to"].forEach((id) => $(id).addEventListener("change", () => quiet(loadLog(true))));
  $("log-more").addEventListener("click", () => quiet(loadLog(false)));
  $("export-log").addEventListener("click", () =>
    quiet(call(() => Store.exportTransactions($("log-from").value || undefined, $("log-to").value || undefined)).then(deliver)));

  // ---------------------------------------------------------------- Comptabilité
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const typeLabel = (t) => Store.ACCOUNT_TYPES.find((x) => x.id === t)?.label || t;
  const catLabel = (c) => Store.LEDGER_CATS.find((x) => x.id === c)?.label || c;
  const plain = (c) => el("span", { class: "amt " + (c > 0 ? "credit" : c < 0 ? "owed" : "") }, (c < 0 ? "−" : "") + euro(Math.abs(c)));
  let ledgerAcc = null;

  function accHint(a) {
    if (a.type !== "responsable") return "argent de la popote";
    if (!a.balance_cents) return "à jour";
    return a.balance_cents > 0 ? "détient cet argent de la popote" : "a avancé : la popote lui doit";
  }
  async function loadCompta() {
    const s = await call(Store.accountingSummary);
    const tile = (val, label, cls = "") => el("div", { class: "stat " + cls }, el("b", { class: "num" }, val), el("span", {}, label));
    $("acc-summary").replaceChildren(
      tile(euro(s.treasury_cents), "trésorerie (tous les comptes)", "owed"),
      tile(euro(s.card_credits_cents), "déjà payé sur les cartes, pas encore consommé"),
      tile(euro(s.owed_to_admins_cents), "dû aux responsables (avances)", s.owed_to_admins_cents ? "warn" : ""),
      tile(euro(s.net_cents), "disponible réel (trésorerie − crédits des cartes" + (s.card_debts_cents ? " + découverts" : "") + ")"),
    );
    const active = s.accounts.filter((a) => a.active);
    $("acc-grid").replaceChildren(...active.map((a) => el("button", {
        type: "button", class: `acc-card t-${a.type}` + (ledgerAcc === a.id ? " sel" : ""),
        onclick: () => { ledgerAcc = ledgerAcc === a.id ? null : a.id; quiet(loadCompta()); } },
      el("span", { class: "acc-type" }, typeLabel(a.type)),
      el("span", { class: "acc-name" }, a.name),
      el("b", { class: "acc-bal" }, plain(a.balance_cents)),
      el("span", { class: "acc-hint" }, accHint(a)))));
    // formulaire d'écriture
    const f = $("entry-form").elements;
    if (!f.date.value) f.date.value = today();
    fillAccounts(f.account, Number(f.account.value) || null);
    syncEntryForm();
    // gestion des comptes
    $("acc-list").replaceChildren(...s.accounts.map((a) => {
      const name = el("input", { value: a.name, maxlength: 30, "aria-label": "Nom du compte" });
      name.addEventListener("change", () => accSave(a.id, { name: name.value }, "Compte renommé"));
      return el("li", { class: a.active ? "" : "off" }, name,
        el("span", { class: "tag" }, typeLabel(a.type)),
        el("span", { class: "r" }, plain(a.balance_cents)),
        el("button", { class: "btn btn-sm", type: "button",
          onclick: () => accSave(a.id, { active: !a.active }, a.active ? `${a.name} archivé` : `${a.name} réactivé`) },
          a.active ? "Archiver" : "Réactiver"));
    }));
    // écritures
    fillAccounts($("ledger-acc"), ledgerAcc, { all: true });
    $("ledger-acc").value = ledgerAcc || "";
    const rows = Store.ledger({ account_id: ledgerAcc || undefined, month: $("ledger-month").value || undefined });
    const name = (id) => s.accounts.find((a) => a.id === id)?.name || "?";
    $("ledger-body").replaceChildren(...rows.map((e) => {
      const sign = e.kind === "transfer" ? (ledgerAcc ? (e.to_account_id === ledgerAcc ? 1 : -1) : 0) : e.kind === "in" ? 1 : -1;
      const amount = sign === 0 ? el("span", { class: "amt" }, "⇄ " + euro(e.amount_cents)) : money(sign * e.amount_cents, true);
      return el("tr", { class: e.cancelled ? "off" : "" },
        el("td", { class: "num nowrap" }, new Date(e.date + "T12:00").toLocaleDateString("fr-FR", { dateStyle: "short" })),
        el("td", {}, el("span", { class: e.cancelled ? "struck" : "" }, e.label),
          el("span", { class: "e-cat" }, catLabel(e.cat) + (e.note ? " · " + e.note : "") + (e.cancelled ? " · annulée" : ""))),
        el("td", { class: "hide-sm muted" }, e.kind === "transfer" ? `${name(e.account_id)} → ${name(e.to_account_id)}` : name(e.account_id)),
        el("td", { class: "r" }, e.cancelled ? el("span", { class: "struck" }, euro(e.amount_cents)) : amount),
        el("td", { class: "r" }, !e.cancelled && e.cat !== "recharge"
          ? el("button", { class: "btn btn-sm", type: "button", onclick: () => ledgerCancel(e) }, "Annuler") : ""));
    }));
    $("ledger-empty").hidden = rows.length > 0;
  }
  async function accSave(id, patch, msg) {
    $("acc-error").textContent = "";
    try { await call(() => Store.accountPatch(id, patch)); toast(msg); }
    catch (e) { $("acc-error").textContent = e.message; }
    quiet(loadCompta());
  }
  async function ledgerCancel(e) {
    if (!confirm(`Annuler cette écriture ?\n${e.label} — ${euro(e.amount_cents)}\nElle reste visible, barrée, et ne compte plus dans les soldes.`)) return;
    try { await call(() => Store.ledgerCancel(e.id)); toast("Écriture annulée"); }
    catch (err) { toast(err.message); }
    quiet(loadCompta());
  }
  function syncEntryForm() {
    const f = $("entry-form").elements, kind = f.kind.value;
    const keep = f.cat.value;
    const cats = Store.LEDGER_CATS.filter((c) => c.kind === kind && !c.auto);
    f.cat.replaceChildren(...cats.map((c) => el("option", { value: c.id }, c.label)));
    if (cats.some((c) => c.id === keep)) f.cat.value = keep;
    f.cat.disabled = cats.length < 2;
    $("acc-to-wrap").hidden = kind !== "transfer";
    $("acc-from-label").textContent = kind === "in" ? "Sur le compte" : kind === "out" ? "Payé par" : "Du compte";
    if (kind === "transfer") fillAccounts(f.to, Number(f.to.value) || null, { exclude: Number(f.account.value) });
  }
  $("entry-form").addEventListener("change", (ev) => { if (["kind", "account"].includes(ev.target.name)) syncEntryForm(); });
  $("entry-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, c = parseEuro(f.amount.value);
    $("entry-error").textContent = "";
    if (!(c > 0)) { $("entry-error").textContent = "Montant invalide (ex. 45,80)"; return; }
    try {
      await call(() => Store.ledgerAdd({ kind: f.kind.value, cat: f.cat.value, date: f.date.value, label: f.label.value,
                                         amount_cents: c, account_id: Number(f.account.value), to_account_id: Number(f.to.value) || null,
                                         note: f.note.value }));
      toast(`Écriture enregistrée : ${euro(c)}`);
      f.amount.value = ""; f.label.value = ""; f.note.value = "";
    } catch (e) { $("entry-error").textContent = e.message; return; }
    quiet(loadCompta());
  });
  $("acc-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, raw = f.opening.value.trim(), c = raw ? parseEuro(raw) : 0;
    $("acc-error").textContent = "";
    if (c === null) { $("acc-error").textContent = "Solde initial invalide (ex. 150 ou -20,50)"; return; }
    try {
      const a = await call(() => Store.accountCreate({ name: f.name.value, type: f.type.value, opening_cents: c }));
      toast(`Compte « ${a.name} » créé`); ev.target.reset();
    } catch (e) { $("acc-error").textContent = e.message; return; }
    quiet(loadCompta());
  });
  $("ledger-acc").addEventListener("change", (ev) => { ledgerAcc = Number(ev.target.value) || null; quiet(loadCompta()); });
  $("ledger-month").addEventListener("change", () => quiet(loadCompta()));

  // ---------------------------------------------------------------- Export
  const period = () => ({ from: $("exp-from").value || undefined, to: $("exp-to").value || undefined });
  function setPreset(p) {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    const range = { month: [new Date(y, m, 1), new Date(y, m + 1, 0)], last: [new Date(y, m - 1, 1), new Date(y, m, 0)],
                    year: [new Date(y, 0, 1), new Date(y, 11, 31)], all: [null, null] }[p];
    $("exp-from").value = range[0] ? iso(range[0]) : ""; $("exp-to").value = range[1] ? iso(range[1]) : "";
    quiet(loadExport());
  }
  async function loadExport() {
    const { from, to } = period();
    const fmt = (s) => new Date(s + "T12:00").toLocaleDateString("fr-FR", { dateStyle: "long" });
    $("exp-period-txt").textContent = !from && !to ? "Toute la période enregistrée dans cet iPad."
      : `Du ${from ? fmt(from) : "début"} au ${to ? fmt(to) : "aujourd'hui"}.`;
    const { rows, total } = await call(() => Store.financeSummary(from, to));
    const line = (r, label, cls = "") => el("tr", { class: cls }, el("td", {}, label),
      ...["cards", "sales", "courses", "other_in", "costs"].map((k) => el("td", { class: "r num" }, euro(r[k]))),
      el("td", { class: "r" }, plain(r.profit)), el("td", { class: "r" }, plain(r.cash)));
    const MOIS = (k) => new Date(k + "-15").toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    $("fin-body").replaceChildren(...(rows.length ? [...rows.map((r) => line(r, MOIS(r.month))), line(total, "Total", "total")]
      : [el("tr", {}, el("td", { colspan: 8, class: "muted" }, "Rien sur cette période."))]));
  }
  $("exp-presets").addEventListener("click", (ev) => { const p = ev.target.closest("button")?.dataset.p; if (p) setPreset(p); });
  ["exp-from", "exp-to"].forEach((id) => $(id).addEventListener("change", () => quiet(loadExport())));
  const exportBtn = (id, fn) => $(id).addEventListener("click", () => { const { from, to } = period(); quiet(call(() => fn(from, to)).then(deliver)); });
  exportBtn("exp-ardoises", Store.exportBalances);
  exportBtn("exp-produits", Store.exportProducts);
  exportBtn("exp-finances", Store.exportFinances);
  exportBtn("exp-compta", Store.exportLedger);
  exportBtn("exp-journal", Store.exportTransactions);

  // ---------------------------------------------------------------- Code responsable
  // Pavé numérique dans une fenêtre : code à 8 chiffres saisi deux fois. Renvoie le code ou null.
  const CODE_LEN = 8;
  let cd = null;
  function askCode(title) {
    return new Promise((resolve) => {
      cd = { code: "", first: null, resolve };
      $("cd-title").textContent = title;
      $("cd-error").textContent = "";
      $("cd-dots").replaceChildren(...Array.from({ length: CODE_LEN }, () => document.createElement("span")));
      cdRender();
      $("code-dlg").showModal();
    });
  }
  function cdRender() {
    $("cd-label").textContent = cd.first === null ? "Choisissez un code à 8 chiffres" : "Confirmez le code";
    $("cd-dots").querySelectorAll("span").forEach((s, i) => s.classList.toggle("on", i < cd.code.length));
    $("cd-ok").disabled = cd.code.length !== CODE_LEN;
    $("cd-ok").textContent = cd.first === null ? "Suivant" : "Valider";
  }
  function cdFinish(value) {
    const r = cd?.resolve; cd = null;
    if ($("code-dlg").open) $("code-dlg").close();
    r?.(value);
  }
  $("cd-keypad").addEventListener("click", (ev) => {
    const k = ev.target.closest("button")?.dataset.k;
    if (!k || !cd) return;
    $("cd-error").textContent = "";
    if (k === "del") cd.code = cd.code.slice(0, -1);
    else if (k !== "ok") { if (cd.code.length < CODE_LEN) cd.code += k; }
    else if (cd.first === null) { cd.first = cd.code; cd.code = ""; }
    else if (cd.code !== cd.first) { cd.first = null; cd.code = ""; $("cd-error").textContent = "Les deux codes sont différents. Recommencez."; }
    else return cdFinish(cd.code);
    cdRender();
  });
  $("cd-cancel").addEventListener("click", () => cdFinish(null));
  $("code-dlg").addEventListener("cancel", () => cdFinish(null));
  // Un seul code par section, partagé par les personnes qui la gèrent
  $("do-code").addEventListener("click", async () => {
    const code = await askCode("Nouveau code responsable");
    if (!code) return;
    try { await call(() => Store.setMyCode(code)); toast("Code responsable changé"); }
    catch (e) { toast(e.message); }
  });

  // ---------------------------------------------------------------- Sauvegarde
  async function loadBackup() {
    const st = await call(Store.settings);
    $("backup-name").value = Store.defaultBackupName();
    $("secname-form").elements.name.value = st.section_name;
    const hf = $("hours-form").elements;
    const H = st.hours;
    hf.mode.value = H.mode; hf.open.value = H.open; hf.close.value = H.close;
    const DEF = { a: { open: "18:00", close: "21:30", open2: "22:00", close2: "23:30" },
                  b: { open: "12:00", close: "14:00", open2: "18:00", close2: "21:30" } };
    for (const k of ["a", "b"]) {
      const sl = { ...DEF[k], closed: false, split: false, ...(H[k] || {}) };
      hf[k + "_open"].value = sl.open; hf[k + "_close"].value = sl.close;
      hf[k + "_open2"].value = sl.open2 || DEF[k].open2; hf[k + "_close2"].value = sl.close2 || DEF[k].close2;
      hf[k + "_closed"].checked = !!sl.closed; hf[k + "_split"].checked = !!sl.split;
    }
    hf.today.value = (H.mode === "alternate" && Store.todaySlot()?.label) || "A";
    $("after-close-soft").checked = !!st.after_close_soft;
    syncHoursForm();
    $("overdraft-form").elements.amount.value = (st.overdraft_cents / 100).toFixed(2).replace(".", ",");
    const i = await call(Store.storageInfo);
    const parts = [i.last_backup ? `Dernière sauvegarde : ${fmtDate(i.last_backup)}.` : "Aucune sauvegarde pour l'instant."];
    if (i.usage) parts.push(`Espace utilisé : ${(i.usage / 1024).toFixed(0)} Ko.`);
    parts.push(i.persisted ? "Stockage protégé contre l'effacement automatique."
                           : "Stockage non protégé : lancez la borne depuis l'icône de l'écran d'accueil.");
    $("backup-info").textContent = parts.join(" ");
  }
  $("secname-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("backup-error").textContent = "";
    try {
      await call(() => Store.setSectionName(ev.target.elements.name.value));
      $("adm-section").textContent = Store.sectionName();
      toast(`Section renommée : ${Store.sectionName()}`);
    } catch (e) { $("backup-error").textContent = e.message; }
  });
  // Les heures ne servent qu'en mode « Selon les horaires »
  function syncHoursForm() {
    const f = $("hours-form").elements;
    $("hours-times").hidden = f.mode.value !== "schedule";
    $("hours-alt").hidden = f.mode.value !== "alternate";
    for (const k of ["a", "b"]) {
      const closed = f[k + "_closed"].checked;
      f[k + "_open"].disabled = f[k + "_close"].disabled = f[k + "_split"].disabled = closed;
      $(k + "-range2").hidden = closed || !f[k + "_split"].checked;
    }
    // Aperçu des 4 prochains jours
    const slot = (k) => f[k + "_closed"].checked ? "fermé"
      : `${f[k + "_open"].value} – ${f[k + "_close"].value}`
        + (f[k + "_split"].checked ? ` et ${f[k + "_open2"].value} – ${f[k + "_close2"].value}` : "");
    const days = ["aujourd'hui", "demain", "après-demain", "dans 3 jours"];
    const first = f.today.value || "A";
    $("alt-preview").textContent = days.map((d, i) => {
      const k = (i % 2 === 0) === (first === "A") ? "a" : "b";
      return `${d} : jour ${k.toUpperCase()} (${slot(k)})`;
    }).join(" ; ");
  }
  const daySlot = (f, k) => ({ open: f[k + "_open"].value, close: f[k + "_close"].value, closed: f[k + "_closed"].checked,
                               split: f[k + "_split"].checked, open2: f[k + "_open2"].value, close2: f[k + "_close2"].value });
  $("hours-form").addEventListener("change", syncHoursForm);
  $("after-close-soft").addEventListener("change", async (ev) => {
    const on = ev.target.checked;
    $("backup-error").textContent = "";
    try {
      await call(() => Store.setAfterCloseSoft(on));
      toast(on ? "Après la fermeture : softs et divers en vente, sans alcool" : "Après la fermeture : plus aucune vente");
    } catch (e) { ev.target.checked = !on; $("backup-error").textContent = e.message; }
  });
  $("hours-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    $("backup-error").textContent = "";
    try {
      const mode = f.mode.value;
      await call(() => Store.setHours({
        mode, open: f.open.value, close: f.close.value,
        a: daySlot(f, "a"), b: daySlot(f, "b"),
        todayIs: f.today.value || "A",
      }));
      toast(mode === "open" ? "Popote ouverte" : mode === "closed" ? "Popote fermée"
            : mode === "alternate" ? "Horaires un jour sur deux enregistrés"
            : `Commandes de ${f.open.value} à ${f.close.value}`);
    } catch (e) { $("backup-error").textContent = e.message; }
  });

  $("overdraft-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const c = parseEuro(ev.target.elements.amount.value || "0");
    $("backup-error").textContent = "";
    if (c === null || c < 0) { $("backup-error").textContent = "Montant invalide (ex. 0 ou 5,00)"; return; }
    try {
      await call(() => Store.setOverdraft(c));
      toast(c ? `Découvert autorisé : ${euro(c)}` : "Commandes limitées au solde de la carte");
      quiet(loadBackup());
    } catch (e) { $("backup-error").textContent = e.message; }
  });

  // Remise à zéro : confirmation en tapant un mot, pour éviter toute fausse manœuvre
  function confirmWord(text, word) {
    const r = prompt(`${text}\n\nCette action est définitive. Pour confirmer, tapez ${word} :`);
    return r !== null && r.trim().toUpperCase() === word;
  }
  $("do-reset").addEventListener("click", async () => {
    if (!confirmWord("Réinitialiser : toutes les cartes, les soldes et le journal seront effacés.\n"
                     + "Les produits, stocks, la comptabilité, le code responsable et les réglages sont gardés.", "REINITIALISER")) {
      toast("Réinitialisation annulée"); return;
    }
    try {
      const r = await call(Store.resetActivity);
      toast(`Remise à zéro faite : ${r.users} carte(s) effacée(s)`);
      refresh();
    } catch (e) { $("backup-error").textContent = e.message; }
  });
  $("do-wipe").addEventListener("click", async () => {
    if (!confirmWord("Tout effacer : cartes, soldes, journal, produits, stocks, réglages ET responsables.\n"
                     + "La borne reviendra à sa première mise en route.", "EFFACER")) {
      toast("Effacement annulé"); return;
    }
    try {
      await call(Store.wipeAll);
      clearInterval(watch);
      if ($("user-dlg").open) $("user-dlg").close();
      $("v-admin").hidden = true;
      Kiosk.setup();
    } catch (e) { $("backup-error").textContent = e.message; }
  });

  $("do-backup").addEventListener("click", async () => {
    $("backup-error").textContent = "";
    try {
      const file = await call(() => Store.backup($("backup-name").value));
      if (await deliver(file)) { await Store.markBackup(); toast("Sauvegarde créée"); quiet(loadBackup()); quiet(loadStats()); }
    } catch (e) { $("backup-error").textContent = e.message; }
  });
  $("restore-file").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    $("backup-error").textContent = "";
    if (!confirm(`Remplacer TOUTES les données de cet iPad par la sauvegarde « ${file.name} » ?\nCette action est définitive.`)) return;
    try {
      const r = await call(async () => Store.restore(await file.text()));
      alert(`Sauvegarde restaurée : ${r.users} cartes, ${r.drinks} produits, ${r.tx} opérations.\nReconnectez-vous avec un compte responsable de la sauvegarde.`);
      close();
    } catch (e) { $("backup-error").textContent = e.message; }
  });

  return { open, close };
})();
