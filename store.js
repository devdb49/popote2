"use strict";
/* Moteur local de la Popote : toutes les données vivent dans l'iPad (IndexedDB).
 *
 * - "state" : un seul enregistrement {usagers, boissons, responsables, compteurs, méta}
 * - "tx"    : le journal, une ligne par opération (commande, paiement, stock…)
 * Chaque modification écrit l'état ET les lignes de journal dans UNE transaction
 * IndexedDB : soit tout est enregistré, soit rien (pas d'ardoise à moitié mise à jour).
 * Les modifications passent par une file d'attente : jamais deux en même temps.
 */
const Store = (() => {
  /* Sections : chacune a sa propre base (responsables, cartes, produits, stocks, journal).
   * La Section 1 reprend la base historique « popote » : rien n'est perdu à la mise à jour. */
  const SECTIONS = [
    { id: "1", db: "popote",    defaultName: "Section 1" },
    { id: "2", db: "popote-s2", defaultName: "Section 2" },
  ];
  let section = SECTIONS[0];
  const MAX_FAILS = 5, LOCK_MIN = 10;
  const USER_SESSION_MS = 3 * 60_000;     // session borne
  const ADMIN_IDLE_MS = 5 * 60_000;       // déconnexion responsable après 5 min sans action
  const PBKDF2_ITER = 150_000;

  let db = null, S = null, persisted = false;
  const sessions = new Map();             // jeton borne -> { uid, exp }
  let admin = null;                       // { id, username, last }

  // ------------------------------------------------------------- outils
  function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
  const nowIso = () => new Date().toISOString();
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64e = (u8) => btoa(String.fromCharCode(...u8));
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const clone = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  // Ouverture : mode "open" (ouvert), "closed" (fermé) — choisis par le responsable — ou "schedule" (horaires)
  // "alternate" : deux horaires A et B qui alternent chaque jour (A, B, A, B… sans tenir compte des semaines)
  const MODES = ["open", "closed", "schedule", "alternate"];
  const defaultHours = () => ({ mode: "open", open: "18:00", close: "21:30" });
  function emptyState() {
    return { v: 1, seq: { user: 0, drink: 0, admin: 0, tx: 0 }, users: [], drinks: [], admins: [],
             settings: { overdraft_cents: 0, hours: defaultHours() },
             meta: { created_at: nowIso(), last_backup: null, section_name: section.defaultName } };
  }

  // ------------------------------------------------------------- ouverture
  /* Ouverture d'une base de section, auto-réparatrice : si la base existe mais qu'il lui manque
   * ses tables (base vide laissée par le navigateur, mise à niveau interrompue…), on la remonte
   * d'une version pour recréer ce qui manque. Les données existantes ne sont jamais touchées. */
  const STORES = ["state", "tx"];
  function rawOpen(name, version) {
    return new Promise((res, rej) => {
      const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("state")) d.createObjectStore("state");
        if (!d.objectStoreNames.contains("tx")) d.createObjectStore("tx", { keyPath: "id" }).createIndex("user_id", "user_id");
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => d.close();      // laisse passer une réparation lancée ailleurs
        res(d);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("La borne est ouverte deux fois : fermez l'autre onglet ou l'autre fenêtre, puis relancez."));
    });
  }
  async function openDb(name) {
    let d = await rawOpen(name);
    if (STORES.every((n) => d.objectStoreNames.contains(n))) return d;
    const v = d.version + 1;
    d.close();
    d = await rawOpen(name, v);
    return d;
  }

  // Ouvre (ou change de) section. Les sessions borne et responsable sont fermées.
  async function open(sectionId = section.id) {
    if (!window.indexedDB) fail("Stockage local indisponible sur cet appareil.");
    if (!crypto.subtle) fail("La borne doit être ouverte en HTTPS (sécurité de l'iPad).");
    await chain;
    const target = SECTIONS.find((x) => x.id === sectionId) || SECTIONS[0];
    if (db && target === section) return;
    if (db) db.close();
    section = target;
    sessions.clear(); admin = null;
    db = await openDb(section.db);
    S = (await req(db.transaction("state").objectStore("state").get("main"))) || emptyState();
    const migrated = normalize(clone(S));
    if (migrated) await commit(migrated, []);
    try { persisted = navigator.storage?.persist ? await navigator.storage.persist() : false; } catch (_) {}
  }

  // Aperçu de toutes les sections pour l'écran de choix (nom, horaires, mise en route faite ?)
  async function sectionsOverview() {
    const out = [];
    for (const sec of SECTIONS) {
      let st = null;
      if (sec === section && S) st = S;
      else {
        try {
          const d = await openDb(sec.db);
          st = await req(d.transaction("state").objectStore("state").get("main"));
          d.close();
        } catch (e) { console.warn("Section " + sec.id + " illisible :", e); }
      }
      const hours = st?.settings?.hours || defaultHours();
      out.push({ id: sec.id, name: st?.meta?.section_name || sec.defaultName,
                 configured: !!st?.admins?.length, hours, open: isOpenAt(hours), status: describeHours(hours) });
    }
    return out;
  }

  // ------------------------------------------------------------- horaires
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
  const dayNum = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  // Horaire d'un jour donné : { open, close, closed, label } (label "A"/"B" en alternance)
  function slotFor(hours, date) {
    if (hours.mode === "alternate") {
      const diff = dayNum(date) - dayNum(fromYmd(hours.anchor));
      const isA = ((diff % 2) + 2) % 2 === 0;
      return { ...(isA ? hours.a : hours.b), label: isA ? "A" : "B" };
    }
    return { open: hours.open, close: hours.close, closed: false, label: null };
  }

  // Ouvert à cet instant ? Une plage peut passer minuit (ex. 20:00 → 01:00) : après minuit, c'est
  // l'horaire de la veille qui s'applique.
  function isOpenAt(hours, date = new Date()) {
    const mode = hours?.mode || (hours?.enabled ? "schedule" : "open");
    if (mode === "open") return true;
    if (mode === "closed") return false;
    hours = { ...hours, mode };
    const t = date.getHours() * 60 + date.getMinutes();
    const today = slotFor(hours, date);
    const yest = slotFor(hours, new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
    if (!yest.closed && toMin(yest.close) < toMin(yest.open) && t < toMin(yest.close)) return true;
    if (today.closed) return false;
    const o = toMin(today.open), c = toMin(today.close);
    if (o === c) return true;
    return o < c ? t >= o && t < c : t >= o;
  }
  // Texte d'état pour l'accueil : { open, text, hint }
  const hh = (t) => t.replace(":", " h ");
  const DAY_WORD = ["", "demain", "après-demain"];
  function describeHours(hours, date = new Date()) {
    const mode = hours?.mode || (hours?.enabled ? "schedule" : "open");
    if (mode === "open") return { open: true, text: "Ouvert", hint: "" };
    if (mode === "closed") return { open: false, text: "Fermé", hint: "La popote est fermée pour le moment." };
    hours = { ...hours, mode };
    const t = date.getHours() * 60 + date.getMinutes();
    if (isOpenAt(hours, date)) {
      const yest = slotFor(hours, new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
      const fromYest = !yest.closed && toMin(yest.close) < toMin(yest.open) && t < toMin(yest.close);
      const until = fromYest ? yest.close : slotFor(hours, date).close;
      return { open: true, text: `Ouvert jusqu'à ${hh(until)}`, hint: "" };
    }
    for (let k = 0; k <= 2; k++) {                     // prochaine ouverture
      const sl = slotFor(hours, new Date(date.getFullYear(), date.getMonth(), date.getDate() + k));
      if (sl.closed || (k === 0 && toMin(sl.open) <= t)) continue;
      const when = k === 0 ? `à ${hh(sl.open)}` : `${DAY_WORD[k]} à ${hh(sl.open)}`;
      return { open: false, text: `Fermé, ouverture ${when}`,
               hint: `Prochaines commandes ${k === 0 ? "aujourd'hui" : DAY_WORD[k]} de ${hh(sl.open)} à ${hh(sl.close)}.` };
    }
    return { open: false, text: "Fermé", hint: "La popote est fermée pour le moment." };
  }

  const todaySlot = (date = new Date()) => {
    const h = S.settings.hours;
    return h.mode === "schedule" || h.mode === "alternate" ? slotFor(h, date) : null;
  };
  const isOpenNow = () => isOpenAt(S.settings.hours);

  // Mise à niveau des données anciennes : noms passés en majuscules. Renvoie l'état modifié ou null.
  function normalize(st) {
    let changed = false;
    for (const u of st.users) {
      const n = cleanName(u.name);
      if (n !== u.name) { u.name = n; changed = true; }
    }
    for (const d of st.drinks) {
      if (!CAT_IDS.includes(d.category)) { d.category = guessCat(d.name); changed = true; }
      if (!d.emoji) { d.emoji = suggestEmoji(d.name, d.category); changed = true; }
    }
    if (!st.settings || !Number.isInteger(st.settings.overdraft_cents)) {
      st.settings = { overdraft_cents: 0 }; changed = true;
    }
    if (!st.settings.hours) { st.settings.hours = defaultHours(); changed = true; }
    if (!MODES.includes(st.settings.hours.mode)) {          // ancien réglage on/off → mode
      st.settings.hours = { mode: st.settings.hours.enabled ? "schedule" : "open",
                            open: st.settings.hours.open || "18:00", close: st.settings.hours.close || "21:30" };
      changed = true;
    }
    if (!st.meta) { st.meta = { created_at: nowIso(), last_backup: null }; changed = true; }
    if (!st.meta.section_name) { st.meta.section_name = section.defaultName; changed = true; }
    for (const a of st.admins) {
      const n = upper(a.username);
      if (n !== a.username) { a.username = n; changed = true; }
    }
    return changed ? st : null;
  }

  function commit(next, rows) {
    return new Promise((res, rej) => {
      const t = db.transaction(["state", "tx"], "readwrite");
      t.objectStore("state").put(next, "main");
      for (const r of rows) t.objectStore("tx").put(r);
      t.oncomplete = () => { S = next; res(); };
      t.onerror = t.onabort = () => rej(t.error || new Error("Écriture impossible sur l'iPad"));
    });
  }

  // File d'attente : chaque mutation travaille sur une copie, puis l'enregistre d'un bloc.
  let chain = Promise.resolve();
  function mutate(fn) {
    const run = async () => {
      const next = clone(S);
      const rows = [];
      const log = (row) => {
        next.seq.tx += 1;
        const r = { id: next.seq.tx, ts: nowIso(), user_id: null, user_name: null, drink_id: null,
                    drink_name: null, qty: null, unit_cents: null, amount_cents: 0, stock_delta: 0,
                    admin: admin ? admin.username : null, note: null, ref_id: null, cancelled: false, ...row };
        rows.push(r);
        return r;
      };
      const result = await fn(next, log, rows);
      await commit(next, rows);
      return result;
    };
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------- sécurité
  const enc = new TextEncoder();
  async function hashSecret(secret, saltB64) {
    const salt = saltB64 ? b64d(saltB64) : rnd(16);
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
    return { hash: b64e(new Uint8Array(bits)), salt: b64e(salt) };
  }
  async function verify(secret, hash, salt) {
    const h = (await hashSecret(secret, salt)).hash;
    let diff = h.length ^ hash.length;
    for (let i = 0; i < Math.min(h.length, hash.length); i++) diff |= h.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  }

  const upper = (s) => s.toLocaleUpperCase("fr-FR");
  // Les noms (usagers et responsables) sont enregistrés en MAJUSCULES.
  const cleanName = (n) => upper(String(n).replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim());
  const nameKey = (n) => cleanName(n).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const NAME_RE = /^[\p{L}\p{N} .'\-]{2,40}$/u;
  function weakCode(code) {
    if (new Set(code).size === 1) return true;
    const steps = new Set();
    for (let i = 0; i < 5; i++) steps.add((+code[i + 1] - +code[i] + 10) % 10);
    return steps.size === 1 && (steps.has(1) || steps.has(9));
  }
  const lockedMinutes = (until) => {
    if (!until) return 0;
    const ms = new Date(until) - Date.now();
    return ms > 0 ? Math.ceil(ms / 60000) : 0;
  };
  // Les cartes créées avant l'ajout de la validation n'ont pas le champ : elles sont validées.
  const isApproved = (u) => u.approved !== false;
  const euroTxt = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
  const lockTime = () => new Date(Date.now() + LOCK_MIN * 60000).toISOString();
  const token = () => b64e(rnd(24));

  // ============================================================= CATÉGORIES
  const CATEGORIES = [
    { id: "biere",  label: "Bières", emoji: "🍺" },
    { id: "soft",   label: "Softs",  emoji: "🥤" },
    { id: "divers", label: "Divers", emoji: "🥨" },
  ];
  const CAT_IDS = CATEGORIES.map((c) => c.id);
  const catRank = (c) => { const i = CAT_IDS.indexOf(c); return i < 0 ? 99 : i; };
  const checkCat = (c) => { if (!CAT_IDS.includes(c)) fail("Catégorie invalide", 422); };
  // Produits créés avant les catégories : classement d'après le nom (modifiable ensuite).
  function guessCat(name) {
    const n = nameKey(name);
    if (/biere|pression|blonde|brune|ambree|ipa|pils|lager|demi|kro|heineken|leffe|1664|despe|pelforth|chouffe|grim/.test(n)) return "biere";
    if (/chips|cacahu|saucis|barre|choco|bonbon|biscuit|gateau|snack|pretzel|olive|noix|amande|pistache|mars|twix|snickers|kinder|bounty|madeleine|sandwich|croque/.test(n)) return "divers";
    return "soft";
  }
  // Image (emoji) proposée d'après le nom, sinon celle de la catégorie.
  const EMOJI_RULES = [
    [/biere|pression|blonde|brune|ambree|ipa|pils|lager|demi|kro|heineken|leffe|1664|despe|pelforth|chouffe|grim/, "🍺"],
    [/vin|rouge|rose|blanc|bordeaux|cotes/, "🍷"], [/champagne|cremant|mousseux|prosecco/, "🥂"],
    [/pastis|ricard|whisky|rhum|vodka|gin|cognac|calva|digestif|aperitif|liqueur/, "🥃"],
    [/cafe|expresso|espresso/, "☕"], [/the|infusion|tisane/, "🍵"], [/chocolat chaud|cacao/, "☕"],
    [/eau|perrier|badoit|vittel|evian|cristaline|san pell/, "💧"], [/jus|orange|pomme|ananas|multifruit|oasis|tropico/, "🧃"],
    [/lait|milk/, "🥛"], [/citron|limonade|schweppes|lemon/, "🍋"], [/ice tea|icetea|the glace|lipton/, "🧋"],
    [/coca|pepsi|cola|fanta|sprite|orangina|soda|7up|red bull|monster|energ/, "🥤"],
    [/chips|pringles|crousti/, "🥔"], [/cacahu|arachide|noix|amande|pistache|apero/, "🥜"],
    [/saucis|chorizo|jambon|charcut|rosette|salami/, "🌭"], [/barre|choco|mars|twix|snickers|kinder|bounty|lion|kitkat|m&m/, "🍫"],
    [/bonbon|haribo|confiserie|sucette/, "🍬"], [/biscuit|cookie|gateau|madeleine|gaufre|brownie|crepe/, "🍪"],
    [/sandwich|croque|panini|wrap/, "🥪"], [/fromage|comte|emmental/, "🧀"], [/pizza/, "🍕"],
    [/pretzel|bretzel|crackers|tuc|curly/, "🥨"], [/olive/, "🫒"], [/pop ?corn/, "🍿"],
  ];
  function suggestEmoji(name, category) {
    const n = nameKey(name || "");
    for (const [re, e] of EMOJI_RULES) if (re.test(n)) return e;
    return CATEGORIES.find((c) => c.id === category)?.emoji || "🥤";
  }

  const byCat = (a, b) => catRank(a.category) - catRank(b.category) || a.sort - b.sort || a.name.localeCompare(b.name, "fr");

  // ============================================================= BORNE
  function kioskDrinks() {
    return S.drinks.filter((d) => d.active)
      .sort(byCat)
      .map(({ id, name, emoji, price_cents, stock, category }) => ({ id, name, emoji, price_cents, stock, category }));
  }

  async function recentFor(uid, limit = 5) {
    const rows = await req(db.transaction("tx").objectStore("tx").index("user_id").getAll(uid));
    return rows.filter((t) => ["order", "payment", "adjust", "cancel"].includes(t.kind)).reverse().slice(0, limit);
  }

  function openSession(uid) {
    for (const [k, v] of sessions) if (v.uid === uid || v.exp < Date.now()) sessions.delete(k);
    const t = token();
    sessions.set(t, { uid, exp: Date.now() + USER_SESSION_MS });
    return t;
  }
  function sessionUser(t) {
    const s = sessions.get(t);
    if (!s || s.exp < Date.now()) { sessions.delete(t); return null; }
    return s.uid;
  }

  async function register(name, code) {
    name = cleanName(name);
    if (!NAME_RE.test(name)) fail("Identifiant invalide (2 à 40 caractères : lettres, chiffres, espace, - ' .)", 422);
    if (!/^\d{6}$/.test(code)) fail("Le code doit faire 6 chiffres", 422);
    if (weakCode(code)) fail("Code trop simple : évitez 000000, 123456…", 422);
    const key = nameKey(name);
    const h = await hashSecret(code);
    return mutate((st) => {
      if (st.users.some((u) => u.name_key === key)) fail("Cet identifiant existe déjà. Choisissez-en un autre.", 409);
      st.seq.user += 1;
      const u = { id: st.seq.user, name, name_key: key, code_hash: h.hash, code_salt: h.salt, balance_cents: 0,
                  active: true, approved: false, failed_attempts: 0, locked_until: null,
                  created_at: nowIso(), last_seen_at: nowIso() };
      st.users.push(u);
      // pas de session : la carte doit d'abord être validée par un responsable
      return { pending: true, name };
    });
  }

  async function login(name, code) {
    const key = nameKey(name);
    const u0 = S.users.find((u) => u.name_key === key);
    if (!u0) { await hashSecret(code || "000000"); fail("Cet identifiant n'existe pas.", 404); }
    if (!u0.active) fail("Carte désactivée : voyez un responsable de la popote", 403);
    const mins = lockedMinutes(u0.locked_until);
    if (mins) fail(`Trop d'essais. Réessayez dans ${mins} min ou voyez un responsable.`, 423);
    const ok = /^\d{6}$/.test(code) && (await verify(code, u0.code_hash, u0.code_salt));
    const msg = await mutate((st) => {
      const u = st.users.find((x) => x.id === u0.id);
      if (ok) {
        u.failed_attempts = 0; u.locked_until = null; u.last_seen_at = nowIso();
        return null;
      }
      const fails = u.failed_attempts + 1;
      if (fails >= MAX_FAILS) { u.failed_attempts = 0; u.locked_until = lockTime();
        return `Trop d'essais : carte bloquée ${LOCK_MIN} min`; }
      u.failed_attempts = fails;
      return `Identifiant ou code incorrect (${MAX_FAILS - fails} essai(s) restant(s))`;
    });
    if (msg) fail(msg, 401);
    if (!isApproved(u0)) fail("Votre carte attend la validation d'un responsable. Vous pourrez commander dès qu'elle sera validée.", 403);
    const u = S.users.find((x) => x.id === u0.id);
    return { token: openSession(u.id), name: u.name, balance_cents: u.balance_cents,
             available_cents: S.settings.overdraft_cents - u.balance_cents, recent: await recentFor(u.id) };
  }

  function order(tok, drinkId, qty = 1) {
    return mutate((st, log) => {
      const uid = sessionUser(tok);
      if (!uid) fail("Session expirée, identifiez-vous à nouveau", 401);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) fail("Quantité invalide", 422);
      const u = st.users.find((x) => x.id === uid);
      if (!u || !u.active) fail("Carte désactivée", 403);
      if (!isApproved(u)) fail("Carte pas encore validée par un responsable", 403);
      const d = st.drinks.find((x) => x.id === drinkId && x.active);
      if (!d) fail("Produit indisponible", 404);
      if (d.stock < qty) fail(`Stock insuffisant (${d.stock} restant(s))`, 409);
      if (!isOpenAt(st.settings.hours)) {
        const h = st.settings.hours;
        const sl = h.mode === "schedule" || h.mode === "alternate" ? slotFor(h, new Date()) : null;
        fail(sl && !sl.closed ? `La popote est fermée. Commandes de ${sl.open} à ${sl.close}.` : "La popote est fermée.", 423);
      }
      const amount = d.price_cents * qty;
      // Pas de commande au-delà de ce qu'il reste sur la carte (+ découvert autorisé éventuel)
      const avail = st.settings.overdraft_cents - u.balance_cents;
      if (amount > avail) {
        fail(avail > 0 ? `Solde insuffisant : il vous reste ${euroTxt(avail)} sur votre carte.`
                       : "Solde insuffisant : rechargez votre carte auprès d'un responsable.", 402);
      }
      d.stock -= qty;
      u.balance_cents += amount;
      u.last_seen_at = nowIso();
      log({ kind: "order", user_id: uid, user_name: u.name, drink_id: d.id, drink_name: d.name, drink_cat: d.category, qty,
            unit_cents: d.price_cents, amount_cents: amount, stock_delta: -qty, admin: null });
      sessions.get(tok).exp = Date.now() + USER_SESSION_MS;
      return { ok: true, drink: d.name, emoji: d.emoji, qty, amount_cents: amount, balance_cents: u.balance_cents,
               available_cents: st.settings.overdraft_cents - u.balance_cents };
    });
  }

  function logout(tok) { sessions.delete(tok); }

  // ============================================================= RESPONSABLES
  const hasAdmins = () => S.admins.length > 0;

  function requireAdmin() {
    if (!admin || Date.now() - admin.last > ADMIN_IDLE_MS) { admin = null; fail("Session responsable expirée", 401); }
    const a = S.admins.find((x) => x.id === admin.id);
    if (!a || !a.active) { admin = null; fail("Compte désactivé", 401); }
    admin.last = Date.now();
    return admin;
  }
  const touchAdmin = () => { if (admin) admin.last = Date.now(); };
  const currentAdmin = () => { try { return requireAdmin(); } catch (_) { return null; } };

  const ADMIN_RE = /^[\p{L}\p{N}._\-]{2,40}$/u;

  async function createFirstAdmin(username, password) {
    if (hasAdmins()) fail("Un responsable existe déjà", 409);
    return adminCreate(username, password, true);
  }

  async function adminLogin(username, password) {
    const key = String(username).trim().toLowerCase();
    const a0 = S.admins.find((a) => a.username.toLowerCase() === key);
    if (!a0 || !a0.active) { await hashSecret(password || "x"); fail("Identifiants incorrects", 401); }
    const mins = lockedMinutes(a0.locked_until);
    if (mins) fail(`Compte bloqué, réessayez dans ${mins} min`, 423);
    const ok = await verify(password, a0.pw_hash, a0.pw_salt);
    await mutate((st) => {
      const a = st.admins.find((x) => x.id === a0.id);
      if (ok) { a.failed_attempts = 0; a.locked_until = null; return; }
      const f = a.failed_attempts + 1;
      if (f >= MAX_FAILS) { a.failed_attempts = 0; a.locked_until = lockTime(); } else a.failed_attempts = f;
    });
    if (!ok) fail("Identifiants incorrects", 401);
    admin = { id: a0.id, username: a0.username, last: Date.now() };
    return { username: a0.username, legacy: !a0.code8 };   // legacy : ancien mot de passe à remplacer
  }
  function adminLogout() { admin = null; }

  function stats() {
    requireAdmin();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = today.toISOString();
    return allTx().then((txs) => {
      let qty = 0, cents = 0, paid = 0;
      for (const t of txs) {
        if (t.ts < since || t.cancelled) continue;
        if (t.kind === "order") { qty += t.qty; cents += t.amount_cents; }
        if (t.kind === "payment") paid -= t.amount_cents;
      }
      const debtors = S.users.filter((u) => u.balance_cents > 0);
      return {
        debt_cents: debtors.reduce((s, u) => s + u.balance_cents, 0), debtors: debtors.length,
        today_qty: qty, today_cents: cents, today_paid_cents: paid,
        low_stock: S.drinks.filter((d) => d.active && d.stock <= d.low_stock).length, users: S.users.length,
        pending: S.users.filter((u) => !isApproved(u)).length,
      };
    });
  }

  // ---------- usagers
  function users(q = "") {
    requireAdmin();
    const k = nameKey(q);
    return S.users.filter((u) => u.name_key.includes(k))
      .sort((a, b) => isApproved(a) - isApproved(b) || b.balance_cents - a.balance_cents || a.name.localeCompare(b.name, "fr"))
      .map((u) => ({ id: u.id, name: u.name, balance_cents: u.balance_cents, active: u.active, approved: isApproved(u),
                     locked: lockedMinutes(u.locked_until) > 0, created_at: u.created_at, last_seen_at: u.last_seen_at }));
  }

  async function userPatch(id, p) {
    requireAdmin();
    let h = null;
    if (p.code !== undefined) {
      if (!/^\d{6}$/.test(p.code)) fail("Le code doit faire 6 chiffres", 422);
      if (weakCode(p.code)) fail("Code trop simple", 422);
      h = await hashSecret(p.code);
    }
    return mutate((st) => {
      const u = st.users.find((x) => x.id === id);
      if (!u) fail("Usager introuvable", 404);
      if (p.name !== undefined) {
        const name = cleanName(p.name);
        if (!NAME_RE.test(name)) fail("Identifiant invalide", 422);
        const key = nameKey(name);
        if (st.users.some((x) => x.name_key === key && x.id !== id)) fail("Cet identifiant existe déjà", 409);
        u.name = name; u.name_key = key;
      }
      if (p.active !== undefined) {
        u.active = !!p.active;
        if (!u.active) for (const [k, v] of sessions) if (v.uid === id) sessions.delete(k);
      }
      if (h) { u.code_hash = h.hash; u.code_salt = h.salt; u.failed_attempts = 0; u.locked_until = null; }
      if (p.unlock) { u.failed_attempts = 0; u.locked_until = null; }
      return { ok: true };
    });
  }

  function approveUser(id) {
    requireAdmin();
    return mutate((st, log) => {
      const u = st.users.find((x) => x.id === id);
      if (!u) fail("Usager introuvable", 404);
      if (isApproved(u)) fail("Carte déjà validée", 409);
      u.approved = true;
      log({ kind: "card", user_id: id, user_name: u.name, note: "Carte validée" });
      return { ok: true };
    });
  }

  function deleteUser(id) {
    requireAdmin();
    return mutate((st, log) => {
      const i = st.users.findIndex((x) => x.id === id);
      if (i < 0) fail("Usager introuvable", 404);
      const u = st.users[i];
      st.users.splice(i, 1);                     // le nom redevient libre
      for (const [k, v] of sessions) if (v.uid === id) sessions.delete(k);
      const b = u.balance_cents;
      const fmt = (c) => (Math.abs(c) / 100).toFixed(2).replace(".", ",") + " €";
      log({ kind: "card", user_id: id, user_name: u.name, amount_cents: -b,
            note: "Carte supprimée" + (b > 0 ? ` (ardoise de ${fmt(b)} effacée)` : b < 0 ? ` (crédit de ${fmt(b)} effacé)` : "") });
      return { ok: true };
    });
  }

  function rejectUser(id) {
    requireAdmin();
    return mutate((st, log) => {
      const i = st.users.findIndex((x) => x.id === id);
      if (i < 0) fail("Usager introuvable", 404);
      const u = st.users[i];
      if (isApproved(u)) fail("Une carte validée ne se refuse pas : désactivez-la", 409);
      st.users.splice(i, 1);   // le nom redevient libre
      log({ kind: "card", user_id: null, user_name: u.name, note: "Carte refusée et supprimée" });
      return { ok: true };
    });
  }

  function money(id, kind, amount, note) {
    requireAdmin();
    if (!Number.isInteger(amount) || Math.abs(amount) > 1_000_000) fail("Montant invalide", 422);
    return mutate((st, log) => {
      const u = st.users.find((x) => x.id === id);
      if (!u) fail("Usager introuvable", 404);
      u.balance_cents += amount;
      log({ kind, user_id: id, user_name: u.name, amount_cents: amount, note: (note || "").trim() || null });
      return { ok: true, balance_cents: u.balance_cents };
    });
  }
  function payment(id, cents, note) {
    if (!(cents > 0)) fail("Le montant payé doit être positif", 422);
    return money(id, "payment", -cents, note);
  }
  function adjust(id, cents, note) {
    if (!cents || !(note || "").trim()) fail("Montant non nul et motif obligatoires", 422);
    return money(id, "adjust", cents, note);
  }

  // ---------- boissons
  function drinks() {
    requireAdmin();
    return [...S.drinks].sort((a, b) => catRank(a.category) - catRank(b.category) || (b.active - a.active) || byCat(a, b));
  }
  const checkPrice = (c) => { if (!Number.isInteger(c) || c < 0 || c > 100_000) fail("Prix invalide", 422); };

  function drinkCreate({ name, emoji = "", price_cents, stock = 0, category }) {
    requireAdmin();
    name = String(name || "").trim();
    if (!name || name.length > 40) fail("Nom de produit invalide", 422);
    checkCat(category);
    checkPrice(price_cents);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) fail("Stock invalide", 422);
    return mutate((st, log) => {
      st.seq.drink += 1;
      const d = { id: st.seq.drink, name, emoji: String(emoji).trim().slice(0, 8) || suggestEmoji(name, category),
                  price_cents, stock, category,
                  low_stock: 5, sort: 0, active: true, created_at: nowIso() };
      st.drinks.push(d);
      if (stock) log({ kind: "stock", drink_id: d.id, drink_name: name, stock_delta: stock, note: "Stock initial" });
      return d;
    });
  }

  function drinkPatch(id, p) {
    requireAdmin();
    if (p.price_cents !== undefined) checkPrice(p.price_cents);
    return mutate((st, log) => {
      const d = st.drinks.find((x) => x.id === id);
      if (!d) fail("Boisson introuvable", 404);
      if (p.name !== undefined) { const n = String(p.name).trim(); if (!n || n.length > 40) fail("Nom invalide", 422); d.name = n; }
      if (p.category !== undefined) { checkCat(p.category); d.category = p.category; }
      if (p.emoji !== undefined) d.emoji = String(p.emoji).trim().slice(0, 8) || suggestEmoji(d.name, d.category);
      if (p.active !== undefined) d.active = !!p.active;
      if (p.low_stock !== undefined && Number.isInteger(p.low_stock) && p.low_stock >= 0) d.low_stock = p.low_stock;
      if (p.price_cents !== undefined && p.price_cents !== d.price_cents) {
        log({ kind: "price", drink_id: id, drink_name: d.name,
              note: `Prix ${(d.price_cents / 100).toFixed(2)} € → ${(p.price_cents / 100).toFixed(2)} €`.replace(/\./g, ",") });
        d.price_cents = p.price_cents;
      }
      return d;
    });
  }

  function drinkStock(id, { delta, set, note = "" }) {
    requireAdmin();
    if ((delta === undefined) === (set === undefined)) fail("Indiquez soit une variation, soit un stock exact", 422);
    return mutate((st, log) => {
      const d = st.drinks.find((x) => x.id === id);
      if (!d) fail("Boisson introuvable", 404);
      const dlt = delta !== undefined ? delta : set - d.stock;
      if (!Number.isInteger(dlt) || Math.abs(dlt) > 100_000) fail("Quantité invalide", 422);
      if (d.stock + dlt < 0) fail("Le stock ne peut pas devenir négatif", 422);
      if (dlt) {
        d.stock += dlt;
        log({ kind: "stock", drink_id: id, drink_name: d.name, stock_delta: dlt,
              note: note.trim() || (set !== undefined ? "Inventaire" : dlt > 0 ? "Réassort" : "Sortie de stock") });
      }
      return d;
    });
  }

  // ---------- journal
  const allTx = () => req(db.transaction("tx").objectStore("tx").getAll());
  const dayStart = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).toISOString(); };
  const dayEnd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(); };

  async function filteredTx({ user_id, kind, date_from, date_to } = {}) {
    let rows = user_id
      ? await req(db.transaction("tx").objectStore("tx").index("user_id").getAll(user_id))
      : await allTx();
    if (kind) rows = rows.filter((t) => t.kind === kind);
    if (date_from) { const f = dayStart(date_from); rows = rows.filter((t) => t.ts >= f); }
    if (date_to) { const e = dayEnd(date_to); rows = rows.filter((t) => t.ts <= e); }
    return rows;
  }

  async function transactions(f = {}) {
    requireAdmin();
    const rows = (await filteredTx(f)).sort((a, b) => b.id - a.id);
    const off = f.offset || 0, lim = Math.min(f.limit || 100, 500);
    return { total: rows.length, items: rows.slice(off, off + lim) };
  }

  async function cancel(id) {
    requireAdmin();
    return mutate(async (st, log, rows) => {
      // relu dans la file d'attente : deux annulations rapides ne peuvent pas passer
      const t0 = await req(db.transaction("tx").objectStore("tx").get(id));
      if (!t0) fail("Opération introuvable", 404);
      if (!["order", "payment", "adjust"].includes(t0.kind)) fail("Seules les commandes, paiements et corrections s'annulent", 422);
      if (t0.cancelled) fail("Déjà annulée", 409);
      const u = t0.user_id && st.users.find((x) => x.id === t0.user_id);
      if (u) u.balance_cents -= t0.amount_cents;
      const d = t0.drink_id && st.drinks.find((x) => x.id === t0.drink_id);
      if (d && t0.stock_delta) d.stock = Math.max(0, d.stock - t0.stock_delta);
      rows.push({ ...t0, cancelled: true });
      log({ kind: "cancel", user_id: t0.user_id, user_name: t0.user_name, drink_id: t0.drink_id,
            drink_name: t0.drink_name, qty: t0.qty, unit_cents: t0.unit_cents, amount_cents: -t0.amount_cents,
            stock_delta: -t0.stock_delta, note: `Annulation #${id}`, ref_id: id });
      return { ok: true };
    });
  }

  // ---------- exports
  const KIND_FR = { setting: "Réglage", card: "Carte", order: "Commande", payment: "Paiement", adjust: "Correction", stock: "Stock", price: "Prix", cancel: "Annulation" };
  const euro = (c) => (c === null || c === undefined) ? "" : (c / 100).toFixed(2).replace(".", ",");
  const cell = (v) => { v = v === null || v === undefined ? "" : String(v); return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const csv = (head, rows) => "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
  const fr = (iso, time = true) => iso ? new Date(iso).toLocaleString("fr-FR", time
    ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };

  async function exportTransactions(date_from, date_to) {
    requireAdmin();
    const rows = (await filteredTx({ date_from, date_to })).sort((a, b) => a.id - b.id);
    return {
      filename: `popote-journal-${stamp()}.csv`, type: "text/csv",
      text: csv(["N°", "Date", "Type", "Usager", "Produit", "Catégorie", "Qté", "Prix unitaire (€)", "Effet sur le solde (€)",
                 "Effet stock", "Responsable", "Note", "Annulée"],
        rows.map((t) => [t.id, fr(t.ts), KIND_FR[t.kind] || t.kind, t.user_name, t.drink_name,
                         CATEGORIES.find((c) => c.id === t.drink_cat)?.label || "", t.qty,
                         euro(t.unit_cents), t.amount_cents ? euro(-t.amount_cents) : "", t.stock_delta || "",
                         t.admin, t.note, t.cancelled ? "oui" : ""])),
    };
  }
  function exportBalances() {
    requireAdmin();
    const rows = [...S.users].sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return {
      filename: `popote-ardoises-${stamp()}.csv`, type: "text/csv",
      text: csv(["Nom", "Solde (€)", "Active", "Dernière visite"],
        rows.map((u) => [u.name, euro(-u.balance_cents), u.active ? "oui" : "non", fr(u.last_seen_at, false)])),
    };
  }

  // ---------- sauvegarde complète / restauration
  async function backup() {
    requireAdmin();
    const data = { format: "popote-backup", version: 1, exported_at: nowIso(), state: S, tx: await allTx() };
    const slug = nameKey(S.meta.section_name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { filename: `popote-${slug}-sauvegarde-${stamp()}.json`, type: "application/json", text: JSON.stringify(data) };
  }
  async function markBackup() {
    return mutate((st) => { st.meta.last_backup = nowIso(); });
  }
  async function restore(text) {
    requireAdmin();
    let data;
    try { data = JSON.parse(text); } catch (_) { fail("Fichier illisible", 422); }
    if (data?.format !== "popote-backup" || !data.state || !Array.isArray(data.tx)) fail("Ce n'est pas une sauvegarde de la Popote", 422);
    const st = data.state;
    if (!Array.isArray(st.users) || !Array.isArray(st.drinks) || !Array.isArray(st.admins) || !st.seq) fail("Sauvegarde incomplète", 422);
    if (!st.admins.some((a) => a.active)) fail("La sauvegarde ne contient aucun responsable actif", 422);
    normalize(st);
    await new Promise((res, rej) => {
      const t = db.transaction(["state", "tx"], "readwrite");
      t.objectStore("tx").clear();
      for (const r of data.tx) t.objectStore("tx").put(r);
      t.objectStore("state").put(st, "main");
      t.oncomplete = () => { S = st; res(); };
      t.onerror = t.onabort = () => rej(t.error || new Error("Restauration impossible"));
    });
    sessions.clear();
    admin = null;   // on se reconnecte avec les comptes de la sauvegarde
    return { users: st.users.length, drinks: st.drinks.length, tx: data.tx.length };
  }

  // ---------- réglages
  function settings() { requireAdmin(); return { ...clone(S.settings), section_name: S.meta.section_name }; }

  // a, b : { open, close, closed } ; todayIs : "A" ou "B" (aujourd'hui est un jour A ou B)
  function setHours({ mode, open, close, a, b, todayIs }) {
    requireAdmin();
    if (!MODES.includes(mode)) fail("Mode d'ouverture invalide", 422);
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    const checkSlot = (sl, label) => {
      if (sl.closed) return;
      if (!re.test(sl.open) || !re.test(sl.close)) fail(`Horaires ${label} invalides (format 18:00)`, 422);
      if (sl.open === sl.close) fail(`${label} : l'ouverture et la fermeture doivent être différentes`, 422);
    };
    if (mode === "schedule") checkSlot({ open, close }, "");
    if (mode === "alternate") {
      if (!a || !b) fail("Horaires A et B manquants", 422);
      checkSlot(a, "Jour A"); checkSlot(b, "Jour B");
      if (a.closed && b.closed) fail("Les jours A et B ne peuvent pas être fermés tous les deux", 422);
    }
    return mutate((st, log) => {
      const prev = st.settings.hours;
      const slot = (sl, def) => ({ open: re.test(sl?.open) ? sl.open : def.open, close: re.test(sl?.close) ? sl.close : def.close,
                                   closed: !!sl?.closed });
      const today = new Date();
      const anchor = todayIs === "B" ? ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) : ymd(today);
      st.settings.hours = {
        mode,
        open: re.test(open) ? open : prev.open, close: re.test(close) ? close : prev.close,
        a: slot(a || prev.a, { open: "18:00", close: "21:30" }),
        b: slot(b || prev.b, { open: "12:00", close: "14:00" }),
        anchor: mode === "alternate" ? anchor : (prev.anchor || ymd(today)),
      };
      const h = st.settings.hours, txt = (sl) => (sl.closed ? "fermé" : `${sl.open} – ${sl.close}`);
      log({ kind: "setting", note: mode === "open" ? "Popote ouverte (manuel)"
                                 : mode === "closed" ? "Popote fermée (manuel)"
                                 : mode === "schedule" ? `Ouverture selon les horaires : ${open} – ${close}`
                                 : `Un jour sur deux : jour A ${txt(h.a)}, jour B ${txt(h.b)} (aujourd'hui : jour ${todayIs === "B" ? "B" : "A"})` });
      return { ok: true };
    });
  }

  function setSectionName(name) {
    requireAdmin();
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 30) fail("Nom de section : 2 à 30 caractères", 422);
    return mutate((st, log) => {
      log({ kind: "setting", note: `Section renommée : ${st.meta.section_name} → ${name}` });
      st.meta.section_name = name;
      return { ok: true };
    });
  }
  function setOverdraft(cents) {
    requireAdmin();
    if (!Number.isInteger(cents) || cents < 0 || cents > 100_000) fail("Montant invalide (0 à 1000 €)", 422);
    return mutate((st, log) => {
      if (st.settings.overdraft_cents === cents) return { ok: true };
      log({ kind: "setting", note: cents ? `Découvert autorisé : ${euroTxt(cents)}` : "Découvert supprimé : commandes limitées au solde" });
      st.settings.overdraft_cents = cents;
      return { ok: true };
    });
  }

  // Remplace tout (état + journal) d'un seul bloc
  function replaceAll(st, rows) {
    return new Promise((res, rej) => {
      const t = db.transaction(["state", "tx"], "readwrite");
      t.objectStore("tx").clear();
      for (const r of rows) t.objectStore("tx").put(r);
      t.objectStore("state").put(st, "main");
      t.oncomplete = () => { S = st; res(); };
      t.onerror = t.onabort = () => rej(t.error || new Error("Écriture impossible sur l'iPad"));
    });
  }

  // Remise à zéro : cartes, soldes et journal effacés ; produits, stocks, responsables et réglages gardés.
  async function resetActivity() {
    const me = requireAdmin();
    await chain;                             // attendre les écritures en cours
    const st = clone(S);
    const n = st.users.length;
    st.users = [];
    st.seq.tx += 1;
    const row = { id: st.seq.tx, ts: nowIso(), kind: "setting", user_id: null, user_name: null, drink_id: null,
                  drink_name: null, qty: null, unit_cents: null, amount_cents: 0, stock_delta: 0, admin: me.username,
                  note: `Remise à zéro : ${n} carte(s), soldes et journal effacés`, ref_id: null, cancelled: false };
    await replaceAll(st, [row]);
    sessions.clear();
    return { users: n };
  }

  // Tout effacer : retour à la première mise en route.
  async function wipeAll() {
    requireAdmin();
    await chain;
    await replaceAll(emptyState(), []);   // nom de section par défaut, horaires désactivés
    sessions.clear();
    admin = null;
    return { ok: true };
  }

  async function storageInfo() {
    requireAdmin();
    let usage = null;
    try { usage = navigator.storage?.estimate ? (await navigator.storage.estimate()).usage : null; } catch (_) {}
    return { persisted, usage, last_backup: S.meta.last_backup, created_at: S.meta.created_at };
  }

  // ---------- comptes responsables
  // Code responsable : exactement 8 chiffres, sans suite évidente.
  function checkAdminCode(pw) {
    pw = String(pw || "");
    if (!/^\d{8}$/.test(pw)) fail("Le code responsable doit faire 8 chiffres", 422);
    const steps = new Set();
    for (let i = 0; i < pw.length - 1; i++) steps.add((+pw[i + 1] - +pw[i] + 10) % 10);
    if (steps.size === 1 && (steps.has(0) || steps.has(1) || steps.has(9))) fail("Code trop simple : évitez 00000000, 12345678…", 422);
  }
  async function adminCreate(username, password, first = false) {
    if (!first) requireAdmin();
    username = upper(String(username || "").trim());
    if (!ADMIN_RE.test(username)) fail("Identifiant : 2 à 40 lettres, chiffres, . _ -", 422);
    checkAdminCode(password);
    const h = await hashSecret(password);
    return mutate((st) => {
      if (st.admins.some((a) => a.username.toLowerCase() === username.toLowerCase())) fail("Identifiant déjà pris", 409);
      st.seq.admin += 1;
      st.admins.push({ id: st.seq.admin, username, pw_hash: h.hash, pw_salt: h.salt, code8: true, active: true,
                       failed_attempts: 0, locked_until: null, created_at: nowIso() });
      return { ok: true };
    });
  }
  // Le responsable connecté choisit son propre code (remplace un ancien mot de passe)
  async function setMyCode(code) {
    const me = requireAdmin();
    checkAdminCode(code);
    const h = await hashSecret(code);
    return mutate((st) => {
      const a = st.admins.find((x) => x.id === me.id);
      a.pw_hash = h.hash; a.pw_salt = h.salt; a.code8 = true;
      return { ok: true };
    });
  }

  function admins() {
    const me = requireAdmin();
    return [...S.admins].sort((a, b) => a.username.localeCompare(b.username, "fr"))
      .map((a) => ({ id: a.id, username: a.username, active: a.active, created_at: a.created_at, me: a.id === me.id }));
  }
  async function adminPatch(id, { password, active }) {
    const me = requireAdmin();
    let h = null;
    if (password !== undefined) {
      checkAdminCode(password);
      h = await hashSecret(password);
    }
    return mutate((st) => {
      const a = st.admins.find((x) => x.id === id);
      if (!a) fail("Responsable introuvable", 404);
      if (active === false) {
        if (id === me.id) fail("Vous ne pouvez pas désactiver votre propre compte", 422);
        a.active = false;
      } else if (active === true) { a.active = true; a.failed_attempts = 0; a.locked_until = null; }
      if (h) { a.pw_hash = h.hash; a.pw_salt = h.salt; a.code8 = true; a.failed_attempts = 0; a.locked_until = null; }
      return { ok: true };
    });
  }

  return {
    open, ADMIN_IDLE_MS, CATEGORIES, sectionsOverview,
    sectionId: () => section.id, sectionName: () => S.meta.section_name,
    hours: () => clone(S.settings.hours), isOpenNow, isOpenAt, todaySlot, setHours, setSectionName,
    describeHours, status: () => describeHours(S.settings.hours),
    // borne
    kioskDrinks, register, login, order, logout,
    // responsables
    hasAdmins, createFirstAdmin, adminLogin, adminLogout, currentAdmin, touchAdmin,
    stats, users, userPatch, approveUser, rejectUser, deleteUser, payment, adjust,
    drinks, drinkCreate, drinkPatch, drinkStock,
    transactions, cancel, exportTransactions, exportBalances,
    backup, markBackup, restore, storageInfo, settings, setOverdraft, resetActivity, wipeAll,
    emojiFor: (d) => d.emoji || suggestEmoji(d.name, d.category), suggestEmoji,
    overdraft: () => S.settings.overdraft_cents,
    admins, adminCreate, adminPatch, setMyCode,
  };
})();
