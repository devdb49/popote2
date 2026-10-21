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
  const defaultAccount = () => ({ id: 1, name: "Caisse", type: "caisse", active: true, created_at: nowIso() });
  function emptyState() {
    return { v: 1, seq: { user: 0, drink: 0, admin: 0, tx: 0, account: 1, entry: 0 }, users: [], drinks: [], admins: [],
             accounts: [defaultAccount()], ledger: [],
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
                 configured: !!st?.admins?.length, hours, open: isOpenAt(hours), status: saleStatus(st?.settings || { hours }) });
    }
    return out;
  }

  // ------------------------------------------------------------- horaires
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
  const dayNum = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  // Horaire d'un jour donné : { open, close, closed, split, open2, close2, label, ranges }
  // (label "A"/"B" en alternance ; ranges : les plages d'ouverture du jour, 0, 1 ou 2)
  function slotFor(hours, date) {
    let sl;
    if (hours.mode === "alternate") {
      const diff = dayNum(date) - dayNum(fromYmd(hours.anchor));
      const isA = ((diff % 2) + 2) % 2 === 0;
      sl = { ...(isA ? hours.a : hours.b), label: isA ? "A" : "B" };
    } else sl = { open: hours.open, close: hours.close, closed: false, label: null };
    sl.ranges = rangesOf(sl);
    return sl;
  }
  function rangesOf(sl) {
    if (!sl || sl.closed) return [];
    const r = [{ open: sl.open, close: sl.close }];
    if (sl.split && sl.open2 && sl.close2) r.push({ open: sl.open2, close: sl.close2 });
    return r;
  }
  const wraps = (r) => toMin(r.close) < toMin(r.open);                 // passe minuit
  const inRange = (r, t) => {
    const o = toMin(r.open), c = toMin(r.close);
    if (o === c) return true;
    return o < c ? t >= o && t < c : t >= o;
  };
  const dayOffset = (date, k) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + k);
  // Plage en cours à cet instant (celle de la veille si elle passe minuit), ou null
  function currentRange(hours, date) {
    const t = date.getHours() * 60 + date.getMinutes();
    const y = slotFor(hours, dayOffset(date, -1)).ranges.find((r) => wraps(r) && t < toMin(r.close));
    return y || slotFor(hours, date).ranges.find((r) => inRange(r, t)) || null;
  }

  // Ouvert à cet instant ? Une plage peut passer minuit (ex. 20:00 → 01:00) : après minuit, c'est
  // l'horaire de la veille qui s'applique.
  function isOpenAt(hours, date = new Date()) {
    const mode = hours?.mode || (hours?.enabled ? "schedule" : "open");
    if (mode === "open") return true;
    if (mode === "closed") return false;
    return !!currentRange({ ...hours, mode }, date);
  }
  // Texte d'état pour l'accueil : { open, text, hint }
  const hh = (t) => t.replace(":", " h ");
  const DAY_WORD = ["", "demain", "après-demain"];
  const rangesText = (rs) => rs.map((r) => `de ${hh(r.open)} à ${hh(r.close)}`).join(" et ");
  function describeHours(hours, date = new Date()) {
    const mode = hours?.mode || (hours?.enabled ? "schedule" : "open");
    if (mode === "open") return { open: true, text: "Ouvert", hint: "" };
    if (mode === "closed") return { open: false, text: "Fermé", hint: "La popote est fermée pour le moment." };
    hours = { ...hours, mode };
    const t = date.getHours() * 60 + date.getMinutes();
    const cur = currentRange(hours, date);
    if (cur) return { open: true, text: `Ouvert jusqu'à ${hh(cur.close)}`, hint: "" };
    for (let k = 0; k <= 2; k++) {                     // prochaine ouverture
      const next = slotFor(hours, dayOffset(date, k)).ranges.filter((r) => k > 0 || toMin(r.open) > t);
      if (!next.length) continue;
      const when = k === 0 ? `à ${hh(next[0].open)}` : `${DAY_WORD[k]} à ${hh(next[0].open)}`;
      return { open: false, text: `Fermé, ouverture ${when}`,
               hint: `Prochaines commandes ${k === 0 ? "aujourd'hui" : DAY_WORD[k]} ${rangesText(next)}.` };
    }
    return { open: false, text: "Fermé", hint: "La popote est fermée pour le moment." };
  }

  // Après la fermeture, on peut continuer à vendre les softs et les divers, mais pas l'alcool
  const ALCOHOL_CATS = ["biere"];
  const isAlcohol = (d) => ALCOHOL_CATS.includes(d.category);
  // Seulement hors horaires (modes Horaires / Un jour sur deux) : « Fermé » arrête toutes les ventes
  const softAfterHours = (settings) => !!settings?.after_close_soft && ["schedule", "alternate"].includes(settings?.hours?.mode);
  function saleStatus(settings, date = new Date()) {
    const st = describeHours(settings?.hours, date);
    if (st.open || !softAfterHours(settings)) return { ...st, soft_only: false };
    return { open: false, soft_only: true, text: st.text.replace(/^Fermé/, "Fermé au bar"),
             hint: "Plus d'alcool : les softs et les divers restent en vente."
               + (st.hint.startsWith("Prochaines commandes") ? st.hint.replace("Prochaines commandes", " Bières à nouveau servies") : "") };
  }
  const canSell = (d, settings = S.settings) => isOpenAt(settings.hours) || (softAfterHours(settings) && !isAlcohol(d));

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
    if (!Array.isArray(st.accounts) || !st.accounts.length) { st.accounts = [defaultAccount()]; changed = true; }
    if (!Array.isArray(st.ledger)) { st.ledger = []; changed = true; }
    if (!Number.isInteger(st.seq.account)) { st.seq.account = Math.max(0, ...st.accounts.map((a) => a.id)); changed = true; }
    if (!Number.isInteger(st.seq.entry)) { st.seq.entry = Math.max(0, ...st.ledger.map((e) => e.id)); changed = true; }
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
      if (!canSell(d, st.settings)) {
        if (softAfterHours(st.settings)) fail("Plus d'alcool après la fermeture : seuls les softs et les divers sont servis.", 423);
        const h = describeHours(st.settings.hours);
        fail(h.hint.startsWith("Prochaines") ? `La popote est fermée. ${h.hint}` : "La popote est fermée.", 423);
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

  /* Un seul responsable par section : pas d'identifiant, un code à 8 chiffres partagé par les
   * personnes qui gèrent la section. (Les comptes créés avant gardent leur code jusqu'au premier
   * « Changer le code », qui ne laisse plus qu'un seul code.) */
  const ADMIN_NAME = "RESPONSABLE";

  async function createFirstAdmin(code) {
    if (hasAdmins()) fail("Le responsable de cette section existe déjà", 409);
    return adminCreate(ADMIN_NAME, code, true);
  }

  async function adminLogin(code) {
    const mins = lockedMinutes(S.meta.admin_locked_until);
    if (mins) fail(`Trop d'essais. Réessayez dans ${mins} min.`, 423);
    let found = null;
    for (const a of S.admins.filter((x) => x.active)) {
      if (await verify(String(code || ""), a.pw_hash, a.pw_salt)) { found = a; break; }
    }
    if (!found) await hashSecret(code || "x");             // même durée, trouvé ou non
    const msg = await mutate((st) => {
      if (found) { st.meta.admin_fails = 0; st.meta.admin_locked_until = null; return null; }
      const f = (st.meta.admin_fails || 0) + 1;
      if (f >= MAX_FAILS) { st.meta.admin_fails = 0; st.meta.admin_locked_until = lockTime();
        return `Code incorrect. Trop d'essais : gestion bloquée ${LOCK_MIN} min.`; }
      st.meta.admin_fails = f;
      return `Code incorrect (${MAX_FAILS - f} essai(s) restant(s))`;
    });
    if (msg) fail(msg, 401);
    admin = { id: found.id, username: ADMIN_NAME, last: Date.now() };
    return { username: ADMIN_NAME, legacy: !found.code8 };
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
      .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base", numeric: true }))   // ordre alphabétique
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

  function money(id, kind, amount, note, accountId) {
    requireAdmin();
    if (!Number.isInteger(amount) || Math.abs(amount) > 1_000_000) fail("Montant invalide", 422);
    return mutate((st, log) => {
      const u = st.users.find((x) => x.id === id);
      if (!u) fail("Usager introuvable", 404);
      const acc = kind === "payment" ? payAccount(st, accountId) : null;
      u.balance_cents += amount;
      const t = log({ kind, user_id: id, user_name: u.name, amount_cents: amount, note: (note || "").trim() || null });
      // L'argent reçu entre dans la comptabilité, sur le compte choisi (caisse par défaut)
      if (acc) addEntry(st, { kind: "in", cat: "recharge", amount_cents: -amount, account_id: acc.id,
                              label: `Recharge carte ${u.name}`, note: t.note, ref_tx: t.id });
      return { ok: true, balance_cents: u.balance_cents };
    });
  }
  function payment(id, cents, note, accountId) {
    if (!(cents > 0)) fail("Le montant payé doit être positif", 422);
    return money(id, "payment", -cents, note, accountId);
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

  // cost_cents (facultatif) : prix payé pour un réassort, sorti du compte account_id (comptabilité)
  function drinkStock(id, { delta, set, note = "", cost_cents, account_id }) {
    requireAdmin();
    if ((delta === undefined) === (set === undefined)) fail("Indiquez soit une variation, soit un stock exact", 422);
    if (cost_cents !== undefined && cost_cents !== null) {
      if (!(delta > 0)) fail("Un coût d'achat ne s'indique que pour un réassort", 422);
      checkAmount(cost_cents);
    }
    return mutate((st, log) => {
      const d = st.drinks.find((x) => x.id === id);
      if (!d) fail("Boisson introuvable", 404);
      const dlt = delta !== undefined ? delta : set - d.stock;
      if (!Number.isInteger(dlt) || Math.abs(dlt) > 100_000) fail("Quantité invalide", 422);
      if (d.stock + dlt < 0) fail("Le stock ne peut pas devenir négatif", 422);
      const acc = cost_cents ? accountFor(st, account_id) : null;
      if (dlt) {
        d.stock += dlt;
        const t = log({ kind: "stock", drink_id: id, drink_name: d.name, stock_delta: dlt,
              note: note.trim() || (set !== undefined ? "Inventaire" : dlt > 0 ? "Réassort" : "Sortie de stock")
                    + (cost_cents ? ` (achat ${euroTxt(cost_cents)})` : "") });
        if (acc) addEntry(st, { kind: "out", cat: "courses", amount_cents: cost_cents, account_id: acc.id,
                                label: `Achat ${d.name} × ${dlt}`, drink_id: id, qty: dlt, ref_tx: t.id });
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
      for (const e of st.ledger) if (e.ref_tx === id && !e.cancelled) { e.cancelled = true; e.cancelled_at = nowIso(); }
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
  const inPeriod = (date, from, to) => (!from || date >= from) && (!to || date <= to);
  const periodTag = (from, to) => (from || to ? `-${(from || "debut").replace(/-/g, "")}-${(to || "auj").replace(/-/g, "")}` : "");
  const live = (txs) => txs.filter((t) => !t.cancelled);

  // Ardoises : solde actuel + totaux rechargés / consommés sur la période
  async function exportBalances(date_from, date_to) {
    requireAdmin();
    const txs = live(await filteredTx({ date_from, date_to }));
    const tot = new Map();
    for (const t of txs) {
      if (!t.user_id) continue;
      const o = tot.get(t.user_id) || { paid: 0, used: 0, n: 0 };
      if (t.kind === "payment") o.paid -= t.amount_cents;
      if (t.kind === "order") { o.used += t.amount_cents; o.n += t.qty; }
      tot.set(t.user_id, o);
    }
    const rows = [...S.users].sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return {
      filename: `popote-ardoises-${stamp()}${periodTag(date_from, date_to)}.csv`, type: "text/csv",
      text: csv(["Nom", "État", "Solde (€)", "Rechargé (€)", "Consommé (€)", "Consommations", "Créée le", "Dernière visite"],
        rows.map((u) => { const o = tot.get(u.id) || { paid: 0, used: 0, n: 0 };
          return [u.name, !isApproved(u) ? "à valider" : u.active ? "active" : "désactivée", euro(-u.balance_cents),
                  euro(o.paid), euro(o.used), o.n, fr(u.created_at, false), fr(u.last_seen_at, false)]; })),
    };
  }

  // Coût d'achat unitaire moyen par produit, d'après les réassorts payés (comptabilité)
  function unitCosts(from, to) {
    const m = new Map();
    for (const e of S.ledger) {
      if (e.cancelled || e.cat !== "courses" || !e.drink_id || !e.qty || !inPeriod(e.date, from, to)) continue;
      const o = m.get(e.drink_id) || { cents: 0, qty: 0 };
      o.cents += e.amount_cents; o.qty += e.qty; m.set(e.drink_id, o);
    }
    return m;
  }
  async function exportProducts(date_from, date_to) {
    requireAdmin();
    const sold = new Map();
    for (const t of live(await filteredTx({ kind: "order", date_from, date_to }))) {
      const o = sold.get(t.drink_id) || { qty: 0, cents: 0 };
      o.qty += t.qty; o.cents += t.amount_cents; sold.set(t.drink_id, o);
    }
    const costs = unitCosts(), bought = unitCosts(date_from, date_to);
    const rows = [...S.drinks].sort(byCat);
    return {
      filename: `popote-produits-${stamp()}${periodTag(date_from, date_to)}.csv`, type: "text/csv",
      text: csv(["Catégorie", "Produit", "Prix de vente (€)", "Coût d'achat moyen (€)", "Marge par unité (€)", "Stock",
                 "Seuil stock bas", "Sur la borne", "Vendus", "Ventes (€)", "Achetés", "Achats (€)", "Valeur du stock au prix d'achat (€)"],
        rows.map((d) => {
          const s = sold.get(d.id) || { qty: 0, cents: 0 }, b = bought.get(d.id) || { qty: 0, cents: 0 };
          const c = costs.get(d.id), unit = c && c.qty ? Math.round(c.cents / c.qty) : null;
          return [CATEGORIES.find((x) => x.id === d.category)?.label || "", d.name, euro(d.price_cents), euro(unit),
                  unit === null ? "" : euro(d.price_cents - unit), d.stock, d.low_stock, d.active ? "oui" : "non",
                  s.qty, euro(s.cents), b.qty, euro(b.cents), unit === null ? "" : euro(unit * d.stock)];
        })),
    };
  }

  // Finances par mois : achats de cartes, consommations, achats de produits, bénéfice
  async function financeSummary(date_from, date_to) {
    requireAdmin();
    const months = new Map();
    const M = (k) => { if (!months.has(k)) months.set(k, { cards: 0, sales: 0, courses: 0, other_in: 0, costs: 0, cash_in: 0, cash_out: 0 }); return months.get(k); };
    for (const t of live(await filteredTx({ date_from, date_to }))) {
      const k = ymd(new Date(t.ts)).slice(0, 7);
      if (t.kind === "payment") M(k).cards -= t.amount_cents;
      if (t.kind === "order") M(k).sales += t.amount_cents;
    }
    for (const e of S.ledger) {
      if (e.cancelled || e.cat === "ouverture" || e.kind === "transfer" || !inPeriod(e.date, date_from, date_to)) continue;
      const m = M(e.date.slice(0, 7));
      if (e.cat === "courses") m.courses += e.amount_cents;
      else if (e.kind === "in" && e.cat !== "recharge") m.other_in += e.amount_cents;
      else if (e.kind === "out") m.costs += e.amount_cents;
      if (e.kind === "in") m.cash_in += e.amount_cents; else m.cash_out += e.amount_cents;
    }
    const rows = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, m]) => ({ month: k, ...m,
      profit: m.sales + m.other_in - m.courses - m.costs, cash: m.cash_in - m.cash_out }));
    const total = rows.reduce((t, r) => { for (const f of ["cards", "sales", "courses", "other_in", "costs", "profit", "cash"]) t[f] += r[f]; return t; },
                              { month: "Total", cards: 0, sales: 0, courses: 0, other_in: 0, costs: 0, profit: 0, cash: 0 });
    return { rows, total };
  }
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const monthFr = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
  async function exportFinances(date_from, date_to) {
    const { rows, total } = await financeSummary(date_from, date_to);
    const line = (r, label) => [label, euro(r.cards), euro(r.sales), euro(r.courses), euro(r.other_in), euro(r.costs), euro(r.profit), euro(r.cash)];
    return {
      filename: `popote-finances-${stamp()}${periodTag(date_from, date_to)}.csv`, type: "text/csv",
      text: csv(["Mois", "Achats de cartes (€)", "Consommations (€)", "Achats de produits (€)", "Autres recettes (€)",
                 "Frais et autres dépenses (€)", "Bénéfice (€)", "Trésorerie : entrées − sorties (€)"],
        [...rows.map((r) => line(r, monthFr(r.month))), line(total, "Total")]),
    };
  }

  // ---------- comptabilité : comptes (caisse, banque, responsables) et écritures
  const ACCOUNT_TYPES = [
    { id: "caisse", label: "Caisse" }, { id: "banque", label: "Banque" }, { id: "responsable", label: "Responsable" },
  ];
  const LEDGER_CATS = [
    { id: "recharge", kind: "in", label: "Recharge de cartes", auto: true },
    { id: "recette", kind: "in", label: "Autre recette (subvention, don…)" },
    { id: "courses", kind: "out", label: "Achat de produits (courses)" },
    { id: "frais", kind: "out", label: "Frais et matériel" },
    { id: "depense", kind: "out", label: "Autre dépense" },
    { id: "transfert", kind: "transfer", label: "Transfert entre comptes" },
    { id: "ouverture", kind: "in", label: "Solde d'ouverture", auto: true },
  ];
  const checkAmount = (c) => { if (!Number.isInteger(c) || c <= 0 || c > 10_000_000) fail("Montant invalide", 422); };
  const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
  function accountFor(st, id) {
    const a = st.accounts.find((x) => x.id === Number(id));
    if (!a) fail("Compte introuvable", 404);
    if (!a.active) fail(`Le compte « ${a.name} » est archivé`, 422);
    return a;
  }
  const payAccount = (st, id) => (id ? accountFor(st, id) : st.accounts.find((a) => a.active && a.type === "caisse")
                                       || st.accounts.find((a) => a.active) || null);
  function addEntry(st, e) {
    st.seq.entry += 1;
    const row = { id: st.seq.entry, ts: nowIso(), date: e.date || ymd(new Date()), kind: e.kind, cat: e.cat,
                  label: e.label, amount_cents: e.amount_cents, account_id: e.account_id, to_account_id: e.to_account_id || null,
                  note: e.note || null, ref_tx: e.ref_tx || null, drink_id: e.drink_id || null, qty: e.qty || null,
                  cancelled: false, cancelled_at: null };
    st.ledger.push(row);
    return row;
  }
  // Effet d'une écriture sur un compte (+ entre, − sort)
  function effect(e, accId) {
    if (e.cancelled) return 0;
    if (e.kind === "in") return e.account_id === accId ? e.amount_cents : 0;
    if (e.kind === "out") return e.account_id === accId ? -e.amount_cents : 0;
    return (e.to_account_id === accId ? e.amount_cents : 0) - (e.account_id === accId ? e.amount_cents : 0);
  }
  function accounts() {
    requireAdmin();
    return S.accounts.map((a) => ({ ...a, balance_cents: S.ledger.reduce((s, e) => s + effect(e, a.id), 0),
                                    entries: S.ledger.filter((e) => e.account_id === a.id || e.to_account_id === a.id).length }))
      .sort((a, b) => (b.active - a.active) || ACCOUNT_TYPES.findIndex((t) => t.id === a.type) - ACCOUNT_TYPES.findIndex((t) => t.id === b.type)
                      || a.name.localeCompare(b.name, "fr"));
  }
  // Vue d'ensemble : trésorerie, avoirs des clients sur leurs cartes, découverts
  function accountingSummary() {
    const acc = accounts();
    const treasury = acc.reduce((s, a) => s + a.balance_cents, 0);
    const credits = S.users.reduce((s, u) => s + Math.max(0, -u.balance_cents), 0);   // déjà payé, pas encore consommé
    const debts = S.users.reduce((s, u) => s + Math.max(0, u.balance_cents), 0);      // découverts à récupérer
    const owed = acc.filter((a) => a.type === "responsable" && a.balance_cents < 0).reduce((s, a) => s - a.balance_cents, 0);
    return { accounts: acc, treasury_cents: treasury, card_credits_cents: credits, card_debts_cents: debts,
             owed_to_admins_cents: owed, net_cents: treasury - credits + debts };
  }
  function accountCreate({ name, type, opening_cents = 0 }) {
    requireAdmin();
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 30) fail("Nom de compte invalide", 422);
    if (!ACCOUNT_TYPES.some((t) => t.id === type)) fail("Type de compte invalide", 422);
    if (!Number.isInteger(opening_cents) || Math.abs(opening_cents) > 10_000_000) fail("Solde d'ouverture invalide", 422);
    return mutate((st) => {
      if (st.accounts.some((a) => nameKey(a.name) === nameKey(name))) fail("Un compte porte déjà ce nom", 409);
      st.seq.account += 1;
      const a = { id: st.seq.account, name, type, active: true, created_at: nowIso() };
      st.accounts.push(a);
      if (opening_cents) addEntry(st, { kind: opening_cents > 0 ? "in" : "out", cat: "ouverture", account_id: a.id,
                                        amount_cents: Math.abs(opening_cents), label: `Solde d'ouverture — ${name}` });
      return a;
    });
  }
  function accountPatch(id, { name, active }) {
    requireAdmin();
    return mutate((st) => {
      const a = st.accounts.find((x) => x.id === id);
      if (!a) fail("Compte introuvable", 404);
      if (name !== undefined) {
        const n = String(name).replace(/\s+/g, " ").trim();
        if (!n || n.length > 30) fail("Nom de compte invalide", 422);
        if (st.accounts.some((x) => x.id !== id && nameKey(x.name) === nameKey(n))) fail("Un compte porte déjà ce nom", 409);
        a.name = n;
      }
      if (active === false) {
        const bal = st.ledger.reduce((s, e) => s + effect(e, id), 0);
        if (bal) fail(`Solde non nul (${euroTxt(bal)}) : videz le compte par un transfert avant de l'archiver`, 422);
        if (st.accounts.filter((x) => x.active && x.id !== id).length === 0) fail("Il faut garder au moins un compte actif", 422);
        a.active = false;
      } else if (active === true) a.active = true;
      return { ...a };
    });
  }
  function ledgerAdd({ kind, cat, date, label, amount_cents, account_id, to_account_id, note }) {
    requireAdmin();
    const c = LEDGER_CATS.find((x) => x.id === cat);
    if (!c || c.auto || c.kind !== kind) fail("Catégorie invalide", 422);
    checkAmount(amount_cents);
    date = date || ymd(new Date());
    if (!ymdRe.test(date)) fail("Date invalide", 422);
    label = String(label || "").replace(/\s+/g, " ").trim().slice(0, 80) || c.label;
    return mutate((st) => {
      const from = accountFor(st, account_id);
      let to = null;
      if (kind === "transfer") {
        to = accountFor(st, to_account_id);
        if (to.id === from.id) fail("Choisissez deux comptes différents", 422);
      }
      return addEntry(st, { kind, cat, date, label, amount_cents, account_id: from.id, to_account_id: to?.id,
                            note: String(note || "").trim().slice(0, 200) || null });
    });
  }
  function ledgerCancel(id) {
    requireAdmin();
    return mutate((st) => {
      const e = st.ledger.find((x) => x.id === id);
      if (!e) fail("Écriture introuvable", 404);
      if (e.cancelled) fail("Écriture déjà annulée", 409);
      if (e.cat === "recharge") fail("Cette recharge vient d'un paiement : annulez le paiement dans le Journal", 422);
      e.cancelled = true; e.cancelled_at = nowIso();
      return { ok: true };
    });
  }
  function ledger({ account_id, month, date_from, date_to } = {}) {
    requireAdmin();
    return S.ledger.filter((e) => (!account_id || e.account_id === account_id || e.to_account_id === account_id)
                                  && (!month || e.date.startsWith(month)) && inPeriod(e.date, date_from, date_to))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  }
  function exportLedger(date_from, date_to) {
    requireAdmin();
    const name = (id) => S.accounts.find((a) => a.id === id)?.name || "";
    const rows = ledger({ date_from, date_to }).reverse();
    const KIND = { in: "Entrée", out: "Sortie", transfer: "Transfert" };
    return {
      filename: `popote-comptabilite-${stamp()}${periodTag(date_from, date_to)}.csv`, type: "text/csv",
      text: csv(["N°", "Date", "Type", "Catégorie", "Libellé", "Compte", "Vers le compte", "Entrée (€)", "Sortie (€)",
                 "Transfert (€)", "Note", "Annulée", "Saisie le"],
        rows.map((e) => [e.id, fr(fromYmd(e.date).toISOString(), false), KIND[e.kind], LEDGER_CATS.find((c) => c.id === e.cat)?.label,
                         e.label, name(e.account_id), name(e.to_account_id),
                         e.kind === "in" ? euro(e.amount_cents) : "", e.kind === "out" ? euro(e.amount_cents) : "",
                         e.kind === "transfer" ? euro(e.amount_cents) : "", e.note, e.cancelled ? "oui" : "", fr(e.ts)])),
    };
  }

  // ---------- sauvegarde complète / restauration
  // Nom de fichier proposé par défaut pour la sauvegarde (modifiable par le responsable)
  function defaultBackupName() {
    const slug = nameKey(S.meta.section_name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `popote-${slug}-${stamp()}`;
  }
  async function backup(name) {
    requireAdmin();
    const data = { format: "popote-backup", version: 1, exported_at: nowIso(), state: S, tx: await allTx() };
    // on garde le nom tel que saisi ; seuls les caractères interdits dans un nom de fichier sont remplacés
    let base = String(name || "").replace(/\.json$/i, "").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60);
    if (!base) base = defaultBackupName();
    return { filename: `${base}.json`, type: "application/json", text: JSON.stringify(data) };
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

  // a, b : { open, close, closed, split, open2, close2 } (split : deuxième plage le même jour) ; todayIs : "A" ou "B" (aujourd'hui est un jour A ou B)
  function setHours({ mode, open, close, a, b, todayIs }) {
    requireAdmin();
    if (!MODES.includes(mode)) fail("Mode d'ouverture invalide", 422);
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    const checkSlot = (sl, label) => {
      if (sl.closed) return;
      if (!re.test(sl.open) || !re.test(sl.close)) fail(`Horaires ${label} invalides (format 18:00)`, 422);
      if (sl.open === sl.close) fail(`${label} : l'ouverture et la fermeture doivent être différentes`, 422);
      if (!sl.split) return;
      if (!re.test(sl.open2) || !re.test(sl.close2)) fail(`${label} : horaires de la 2e plage invalides (format 18:00)`, 422);
      if (sl.open2 === sl.close2) fail(`${label} : la 2e plage doit avoir une ouverture et une fermeture différentes`, 422);
      if (toMin(sl.close) < toMin(sl.open)) fail(`${label} : avec deux plages, la 1re doit se terminer avant minuit`, 422);
      if (toMin(sl.open2) < toMin(sl.close)) fail(`${label} : la 2e plage doit commencer après la fin de la 1re (${sl.close})`, 422);
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
                                   closed: !!sl?.closed, split: !!sl?.split && !sl?.closed,
                                   open2: re.test(sl?.open2) ? sl.open2 : def.open2, close2: re.test(sl?.close2) ? sl.close2 : def.close2 });
      const today = new Date();
      const anchor = todayIs === "B" ? ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) : ymd(today);
      st.settings.hours = {
        mode,
        open: re.test(open) ? open : prev.open, close: re.test(close) ? close : prev.close,
        a: slot(a || prev.a, { open: "18:00", close: "21:30", open2: "22:00", close2: "23:30" }),
        b: slot(b || prev.b, { open: "12:00", close: "14:00", open2: "18:00", close2: "21:30" }),
        anchor: mode === "alternate" ? anchor : (prev.anchor || ymd(today)),
      };
      const h = st.settings.hours, txt = (sl) => (sl.closed ? "fermé" : rangesOf(sl).map((r) => `${r.open} – ${r.close}`).join(" et "));
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

  function setAfterCloseSoft(on) {
    requireAdmin();
    return mutate((st, log) => {
      if (!!st.settings.after_close_soft === !!on) return { ok: true };
      st.settings.after_close_soft = !!on;
      log({ kind: "setting", note: on ? "Après la fermeture : vente des softs et des divers (sans alcool)"
                                      : "Après la fermeture : plus aucune vente" });
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
  // Nouveau code du responsable de la section : remplace tous les anciens codes/comptes.
  async function setMyCode(code) {
    const me = requireAdmin();
    checkAdminCode(code);
    const h = await hashSecret(code);
    return mutate((st, log) => {
      st.admins = [{ id: me.id, username: ADMIN_NAME, pw_hash: h.hash, pw_salt: h.salt, code8: true, active: true,
                     failed_attempts: 0, locked_until: null, created_at: nowIso() }];
      log({ kind: "setting", note: "Code responsable changé" });
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
    describeHours, status: () => saleStatus(S.settings), canSell: (d) => canSell(d), isAlcohol, setAfterCloseSoft,
    // borne
    kioskDrinks, register, login, order, logout,
    // responsables
    hasAdmins, createFirstAdmin, adminLogin, adminLogout, currentAdmin, touchAdmin,
    stats, users, userPatch, approveUser, rejectUser, deleteUser, payment, adjust,
    drinks, drinkCreate, drinkPatch, drinkStock,
    transactions, cancel, exportTransactions, exportBalances, exportProducts, exportFinances, exportLedger, financeSummary,
    ACCOUNT_TYPES, LEDGER_CATS, accounts, accountingSummary, accountCreate, accountPatch, ledgerAdd, ledgerCancel, ledger,
    backup, defaultBackupName, markBackup, restore, storageInfo, settings, setOverdraft, resetActivity, wipeAll,
    emojiFor: (d) => d.emoji || suggestEmoji(d.name, d.category), suggestEmoji,
    overdraft: () => S.settings.overdraft_cents,
    admins, adminCreate, adminPatch, setMyCode,
  };
})();
