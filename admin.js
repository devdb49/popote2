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
      try { await navigator.share({ files: [file], title: filename }); return true; }
      catch (e) { if (e.name === "AbortError") return false; }
    }
    const a = el("a", { href: URL.createObjectURL(file), download: filename });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return true;
  }

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
    if ($("user-dlg").open) $("user-dlg").close();
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
    quiet(({ users: loadUsers, drinks: loadDrinks, log: () => loadLog(true), admins: loadAdmins, backup: loadBackup })[tab]());
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
  $("export-ardoises").addEventListener("click", () => quiet(call(Store.exportBalances).then(deliver)));

  let cur = null;
  async function openUser(id) {
    cur = (await call(() => Store.users(""))).find((u) => u.id === id);
    if (!cur) return;
    $("u-name").textContent = cur.name;
    $("u-balance").replaceChildren("Solde de la carte : ", amt(cur.balance_cents));
    $("u-error").textContent = "";
    $("pay-form").reset(); $("adj-form").reset(); $("code-form").reset();
    $("rename-form").elements.name.value = cur.name;
    $("u-toggle").textContent = cur.active ? "Désactiver la carte" : "Réactiver la carte";
    $("u-locked").hidden = !cur.locked;
    $("u-pending").hidden = cur.approved;
    $("u-delete-zone").hidden = !cur.approved;   // une carte en attente se refuse
    $("pay-form").hidden = !cur.approved;
    $("pay-all").hidden = cur.balance_cents <= 0;
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
  $("pay-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, c = parseEuro(f.amount.value);
    if (!c || c <= 0) { $("u-error").textContent = "Montant invalide (ex. 12,50)"; return; }
    userAction(() => Store.payment(cur.id, c, f.note.value), `${euro(c)} crédités sur la carte`);
  });
  $("adj-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.elements, c = parseEuro(f.amount.value);
    if (!c) { $("u-error").textContent = "Montant invalide (ex. -2,00 ou 1,50)"; return; }
    // Saisie du point de vue de la carte : +3 = ajoute 3 € au solde (en interne : la dette diminue)
    userAction(() => Store.adjust(cur.id, -c, f.note.value),
      c > 0 ? `${euro(c)} ajoutés sur la carte` : `${euro(-c)} retirés de la carte`);
  });
  $("code-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    userAction(() => Store.userPatch(cur.id, { code: ev.target.elements.code.value }), "Code changé");
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
    const price = el("input", { class: "w-num", inputmode: "decimal", "aria-label": "Prix en euros",
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

    const qty = el("input", { inputmode: "numeric", placeholder: "qté", "aria-label": "Quantité" });
    const stockOp = async (kind) => {
      const n = parseInt(String(qty.value).replace("−", "-"), 10);
      if (!Number.isFinite(n) || (kind === "delta" && n === 0) || (kind === "set" && n < 0)) {
        toast("Quantité invalide"); return;
      }
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
      el("td", { class: "r" }, el("button", { class: "btn btn-sm", type: "button",
        onclick: () => save({ active: !d.active }, d.active ? `${d.name} retirée de la borne` : `${d.name} remise sur la borne`) },
        d.active ? "Retirer" : "Remettre")),
    );
  }

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

  // ---------------------------------------------------------------- Responsables
  async function loadAdmins() {
    const list = await call(Store.admins);
    $("admins-body").replaceChildren(...list.map((a) => el("tr", {},
      el("td", {}, a.username, a.me ? el("span", { class: "muted" }, " (vous)") : ""),
      el("td", { class: "hide-sm" }, fmtDate(a.created_at, false)),
      el("td", {}, a.active ? "" : el("span", { class: "tag bad" }, "désactivé")),
      el("td", { class: "r" },
        el("button", { class: "btn btn-sm", type: "button", onclick: () => changePw(a) }, "Changer le code"), " ",
        a.me ? "" : el("button", { class: "btn btn-sm" + (a.active ? " btn-danger" : ""), type: "button",
          onclick: () => toggleAdmin(a) }, a.active ? "Désactiver" : "Réactiver")),
    )));
  }
  async function changePw(a) {
    const pw = await askCode(`Code de ${a.username}`);
    if (!pw) return;
    try { await call(() => Store.adminPatch(a.id, { password: pw })); toast(`Code de ${a.username} changé`); }
    catch (e) { toast(e.message); }
  }

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
  async function toggleAdmin(a) {
    if (a.active && !confirm(`Désactiver ${a.username} ?`)) return;
    try { await call(() => Store.adminPatch(a.id, { active: !a.active })); }
    catch (e) { toast(e.message); }
    quiet(loadAdmins());
  }
  $("admin-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    $("admin-error").textContent = "";
    try {
      const name = f.username.value.trim();
      if (name.length < 2) { $("admin-error").textContent = "Saisissez l'identifiant du responsable"; return; }
      document.activeElement?.blur();
      const code = await askCode(`Code de ${name.toUpperCase()}`);
      if (!code) return;
      await call(() => Store.adminCreate(name, code));
      toast(`${name.toUpperCase()} ajouté`); ev.target.reset(); quiet(loadAdmins());
    } catch (e) { $("admin-error").textContent = e.message; }
  });

  // ---------------------------------------------------------------- Sauvegarde
  async function loadBackup() {
    const st = await call(Store.settings);
    $("secname-form").elements.name.value = st.section_name;
    const hf = $("hours-form").elements;
    const H = st.hours;
    hf.mode.value = H.mode; hf.open.value = H.open; hf.close.value = H.close;
    const a = H.a || { open: "18:00", close: "21:30", closed: false }, b = H.b || { open: "12:00", close: "14:00", closed: false };
    hf.a_open.value = a.open; hf.a_close.value = a.close; hf.a_closed.checked = a.closed;
    hf.b_open.value = b.open; hf.b_close.value = b.close; hf.b_closed.checked = b.closed;
    hf.today.value = (H.mode === "alternate" && Store.todaySlot()?.label) || "A";
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
    for (const k of ["a", "b"]) f[k + "_open"].disabled = f[k + "_close"].disabled = f[k + "_closed"].checked;
    // Aperçu des 4 prochains jours
    const slot = (k) => f[k + "_closed"].checked ? "fermé" : `${f[k + "_open"].value} – ${f[k + "_close"].value}`;
    const days = ["aujourd'hui", "demain", "après-demain", "dans 3 jours"];
    const first = f.today.value || "A";
    $("alt-preview").textContent = days.map((d, i) => {
      const k = (i % 2 === 0) === (first === "A") ? "a" : "b";
      return `${d} : jour ${k.toUpperCase()} (${slot(k)})`;
    }).join(" ; ");
  }
  $("hours-form").addEventListener("change", syncHoursForm);
  $("hours-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    $("backup-error").textContent = "";
    try {
      const mode = f.mode.value;
      await call(() => Store.setHours({
        mode, open: f.open.value, close: f.close.value,
        a: { open: f.a_open.value, close: f.a_close.value, closed: f.a_closed.checked },
        b: { open: f.b_open.value, close: f.b_close.value, closed: f.b_closed.checked },
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
                     + "Les produits, stocks, responsables et réglages sont gardés.", "REINITIALISER")) {
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
      const file = await call(Store.backup);
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
