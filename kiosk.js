"use strict";
/* Borne : identification, création de carte, commande. Les données passent par Store (local). */

const Kiosk = (() => {
  const IDLE_SECONDS = 45;       // inactivité avant l'alerte
  const IDLE_GRACE = 10;         // compte à rebours de l'alerte
  const DONE_SECONDS = 8;        // retour auto après confirmation
  const HOLD_MS = 3000;          // appui long sur le titre -> gestion

  const $ = (id) => document.getElementById(id);
  const euro = (c) => (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

  const state = {
    screen: null,
    mode: "login",          // login | register
    regStep: 1,
    code: "", firstCode: "",
    session: null,          // { token, name, balance_cents }
    drinks: [],
    pick: null, qty: 1,
    cat: null,              // catégorie affichée dans le menu
  };

  function show(name) {
    state.screen = name;
    for (const s of $("v-kiosk").querySelectorAll(".screen")) s.hidden = s.id !== "s-" + name;
    armIdle();
  }

  // ---- Carte -----------------------------------------------------------------
  function loadDrinks() {
    state.drinks = Store.kioskDrinks();
    renderBoard();
    if (state.screen === "menu") renderDrinks();
  }

  function renderBoard() {
    const ul = $("board");
    ul.replaceChildren();
    const softOnly = !!Store.status().soft_only;
    ul.dataset.softOnly = String(softOnly);
    let cat = null, group = null;
    for (const d of state.drinks) {
      if (d.category !== cat) {               // rubrique : Bières / Softs / Divers
        cat = d.category;
        const g = document.createElement("li");
        g.className = "cat-group";
        g.dataset.cat = cat;
        const h = document.createElement("p");
        h.className = "cat-head";
        h.textContent = Store.CATEGORIES.find((c) => c.id === cat)?.label || "";
        if (softOnly && Store.isAlcohol(d)) {              // bar fermé : pas d'alcool
          g.classList.add("no-sale");
          const n = document.createElement("span"); n.className = "cat-off"; n.textContent = "plus servies après la fermeture";
          h.append(" ", n);
        }
        group = document.createElement("ul");
        g.append(h, group);
        ul.appendChild(g);
      }
      const li = document.createElement("li");
      if (d.stock <= 0) li.className = "out";
      li.innerHTML = '<span class="b-name"></span><span class="b-fill"></span><span class="b-price num"></span>';
      li.querySelector(".b-name").textContent = Store.emojiFor(d) + " " + d.name;
      li.querySelector(".b-price").textContent = d.stock > 0 ? euro(d.price_cents) : "épuisé";
      group.appendChild(li);
    }
    $("board-empty").hidden = state.drinks.length > 0;
  }

  // Horloge de l'accueil
  function tick() {
    const d = new Date();
    const txt = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
      + "  " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.querySelectorAll(".clock-live").forEach((e) => { e.textContent = txt; });
    if (state.screen === "home") renderHomeStatus();
    if (state.screen === "sections") renderSections();
  }
  setInterval(tick, 15_000);

  // ---- Choix de la section ------------------------------------------------------
  async function renderSections() {
    const list = await Store.sectionsOverview();
    $("section-choices").replaceChildren(...list.map((sec) => {
      const b = document.createElement("button");
      b.className = "section-card" + (sec.configured && !sec.open ? (sec.status.soft_only ? " limited" : " closed") : "");
      b.dataset.sec = sec.id;
      b.innerHTML = '<span class="sc-name"></span><span class="sc-status"></span>';
      b.querySelector(".sc-name").textContent = "#" + sec.name;
      b.querySelector(".sc-status").textContent = sec.configured ? sec.status.text : "À mettre en route";
      b.addEventListener("click", () => enterSection(sec.id));
      return b;
    }));
  }
  async function showSections() {
    document.activeElement?.blur?.();
    resetSession();
    await renderSections();
    show("sections");
    tick();
  }
  async function enterSection(id) {
    await Store.open(id);
    state.cat = null;
    if (!Store.hasAdmins()) return openAuth("setup");
    sectionHome();
  }

  // Statut de la section sur son accueil : ouvert / fermé (pas de commande hors horaires)
  function renderHomeStatus() {
    const st = Store.status(), open = st.open, sell = open || st.soft_only;
    $("sec-name").textContent = "#" + Store.sectionName();
    $("sec-status").textContent = st.text;
    $("sec-status").classList.toggle("closed", !sell);
    $("sec-status").classList.toggle("limited", st.soft_only);
    $("btn-order").disabled = !sell;
    $("btn-order").textContent = sell ? "Commander" : "Fermé";
    $("home-hint").textContent = open
      ? "Chaque consommation est déduite de votre carte. Rechargez-la auprès d'un responsable."
      : st.soft_only ? st.hint
      : `${st.hint} Vous pouvez consulter les tarifs et créer votre carte.`;
    if ($("board").dataset.softOnly !== String(st.soft_only)) renderBoard();
  }

  // ---- Identification / création (clients et responsables) -------------------
  // Un seul écran : identifiant au clavier, puis code au pavé numérique.
  //   login / register : clients, code à 6 chiffres
  //   admin / setup / newcode : responsables, code à 8 chiffres
  const MODES = {
    login:    { title: "Identification", len: 6, confirm: false, back: true,
                help: "Celui choisi lors de la création de votre carte.",
                code: "Votre code à 6 chiffres" },
    register: { title: "Créer ma carte", len: 6, confirm: true, back: true,
                help: "Choisissez votre identifiant. Il doit être unique.",
                code: "Choisissez un code à 6 chiffres" },
    admin:    { title: "Espace responsable", len: 8, confirm: false, back: true, noName: true,
                code: "Code responsable à 8 chiffres" },
    setup:    { title: "Mise en route de la section", len: 8, confirm: true, back: true, noName: true,
                code: "Choisissez le code responsable à 8 chiffres",
                intro: "Cette section n'a pas encore de responsable. Choisissez le code à 8 chiffres qui ouvrira sa gestion (produits, tarifs, stocks, cartes). Il peut être partagé par les personnes qui gèrent la section." },
    newcode:  { title: "Nouveau code responsable", len: 8, confirm: true, back: false, noName: true,
                code: "Choisissez votre code à 8 chiffres",
                intro: "Les responsables utilisent désormais un code à 8 chiffres. Choisissez le vôtre : il remplacera votre ancien mot de passe." },
  };
  const M = () => MODES[state.mode];

  function openAuth(mode) {
    state.mode = mode; state.regStep = 1; state.code = ""; state.firstCode = "";
    const m = M();
    $("auth-title").textContent = m.title;
    $("auth-back").style.visibility = m.back ? "" : "hidden";   // garde la place : titre centré
    $("auth-intro").hidden = !m.intro;
    $("auth-intro").textContent = m.intro || "";
    $("auth-name-block").hidden = !!m.noName;
    $("name-help").textContent = m.help || "";
    $("name").value = "";
    buildDots();
    setCodeLabel();
    $("auth-error").textContent = "";
    renderDots();
    show("auth");
    // focus immédiat (dans le geste de l'utilisateur) : l'iPad n'ouvre le clavier qu'à cette condition
    if (!m.noName) $("name").focus();
  }

  function buildDots() {
    $("dots").replaceChildren(...Array.from({ length: M().len }, () => document.createElement("span")));
    $("dots").classList.toggle("dots-8", M().len === 8);
  }

  function setCodeLabel() {
    const m = M();
    $("code-label").textContent = m.confirm && state.regStep === 2 ? "Confirmez le code" : m.code;
    $("key-ok").textContent = m.confirm && state.regStep === 1 ? "Suivant" : "Valider";
  }

  function renderDots() {
    $("dots").querySelectorAll("span").forEach((s, i) => s.classList.toggle("on", i < state.code.length));
    $("key-ok").disabled = state.code.length !== M().len || busy;
  }

  function shake(msg) {
    $("auth-error").textContent = msg;
    const d = $("dots");
    d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake");
  }

  let busy = false;
  async function submitAuth() {
    if (busy) return;
    const m = M();
    const name = $("name").value.trim();
    if (!m.noName && name.length < 2) { shake("Saisissez votre identifiant."); $("name").focus(); return; }
    if (state.code.length !== m.len) return;

    if (m.confirm && state.regStep === 1) {
      state.firstCode = state.code; state.code = ""; state.regStep = 2;
      $("auth-error").textContent = ""; setCodeLabel(); renderDots();
      return;
    }
    if (m.confirm && state.code !== state.firstCode) {
      state.code = ""; state.firstCode = ""; state.regStep = 1;
      setCodeLabel(); renderDots();
      shake("Les deux codes sont différents. Recommencez.");
      return;
    }
    busy = true; renderDots();
    try {
      $("name").blur();
      if (state.mode === "login") {
        state.session = await Store.login(name, state.code);
        openMenu();
      } else if (state.mode === "register") {
        const r = await Store.register(name, state.code);
        showPending(r.name);
      } else if (state.mode === "admin") {
        const r = await Store.adminLogin(state.code);
        enterAdmin(r);
      } else if (state.mode === "setup") {
        await Store.createFirstAdmin(state.code);
        await Store.adminLogin(state.code);
        Admin.open("drinks");
      } else if (state.mode === "newcode") {
        await Store.setMyCode(state.code);
        Admin.open();
      }
    } catch (e) {
      state.code = "";
      if (m.confirm) { state.regStep = 1; state.firstCode = ""; setCodeLabel(); }
      shake(e.message);
    } finally {
      busy = false; renderDots();
    }
  }

  // Responsable connecté : ancien mot de passe → choisir d'abord un code à 8 chiffres
  function enterAdmin(r) {
    if (r.legacy) openAuth("newcode"); else Admin.open();
  }

  $("keypad").addEventListener("click", (ev) => {
    const k = ev.target.closest("button")?.dataset.k;
    if (!k) return;
    if (k === "del") state.code = state.code.slice(0, -1);
    else if (k === "ok") return submitAuth();
    else if (state.code.length < M().len) state.code += k;
    $("auth-error").textContent = "";
    renderDots();
  });
  $("name").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("name").blur(); });

  // Clavier physique (clavier Bluetooth ou tests sur ordinateur)
  document.addEventListener("keydown", (ev) => {
    if (state.screen !== "auth" || document.activeElement?.id === "name" || !$("v-admin").hidden) return;
    if (/^\d$/.test(ev.key) && state.code.length < M().len) { state.code += ev.key; renderDots(); }
    else if (ev.key === "Backspace") { state.code = state.code.slice(0, -1); renderDots(); }
    else if (ev.key === "Enter") submitAuth();
  });

  // ---- Menu -------------------------------------------------------------------
  // balance_cents > 0 : la personne doit ; < 0 : il reste de l'argent sur la carte
  function renderSlate(el, balance, prefix) {
    const solde = -balance;
    el.classList.toggle("credit", solde > 0);
    el.classList.toggle("debt", solde < 0);
    const label = solde > 0 ? "Sur votre carte : " : solde < 0 ? "À régler : " : "Carte à zéro";
    el.replaceChildren(document.createTextNode((prefix || "") + label));
    if (solde !== 0) {
      const s = document.createElement(el.id === "done-slate" ? "strong" : "span");
      s.className = "amt num"; s.textContent = euro(Math.abs(solde));
      el.appendChild(s);
    }
  }
  const available = () => state.session ? state.session.available_cents : 0;

  function openMenu() {
    $("hello").textContent = "Bonjour " + state.session.name;
    renderSlate($("slate"), state.session.balance_cents);
    show("menu");
    state.drinks = Store.kioskDrinks();
    // bar fermé : le menu s'ouvre sur une catégorie encore en vente (les bières restent visibles, grisées)
    const sellable = (id) => state.drinks.some((d) => d.category === id && Store.canSell(d));
    if (!sellable(state.cat)) state.cat = Store.CATEGORIES.find((c) => sellable(c.id))?.id || state.cat;
    loadDrinks();
    renderDrinks();
  }

  // Onglets de catégorie : seulement celles qui ont des produits
  function renderCatTabs() {
    const cats = Store.CATEGORIES.filter((c) => state.drinks.some((d) => d.category === c.id));
    if (!cats.some((c) => c.id === state.cat)) state.cat = cats[0]?.id || null;
    $("cat-tabs").replaceChildren(...cats.map((c) => {
      const b = document.createElement("button");
      b.className = "cat-tab";
      b.dataset.cat = c.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", c.id === state.cat);
      b.innerHTML = '<span class="ct-emoji"></span><span class="ct-label"></span>';
      b.querySelector(".ct-emoji").textContent = c.emoji;
      b.querySelector(".ct-label").textContent = c.label;
      b.addEventListener("click", () => { state.cat = c.id; renderDrinks(); $("drinks").scrollTop = 0; });
      return b;
    }));
    $("cat-tabs").hidden = cats.length < 2;
  }

  function renderDrinks() {
    renderCatTabs();
    const box = $("drinks");
    box.replaceChildren();
    const avail = available();
    const affordable = state.drinks.some((d) => d.stock > 0 && d.price_cents <= avail && Store.canSell(d));
    $("menu-note").hidden = affordable || !state.drinks.length;
    for (const d of state.drinks.filter((x) => x.category === state.cat)) {
      const b = document.createElement("button");
      const tooExpensive = d.price_cents > avail, offHours = !Store.canSell(d);
      b.className = "drink" + (tooExpensive && d.stock > 0 && !offHours ? " too-expensive" : "") + (offHours ? " too-expensive" : "");
      b.dataset.cat = d.category;
      b.disabled = d.stock <= 0 || tooExpensive || offHours;
      b.innerHTML = '<span class="d-emoji"></span><span><span class="d-name"></span><br>' +
                    '<span class="d-price num"></span></span><span class="d-left"></span>';
      b.querySelector(".d-emoji").textContent = Store.emojiFor(d);
      b.querySelector(".d-name").textContent = d.name;
      b.querySelector(".d-price").textContent = d.stock > 0 ? euro(d.price_cents) : "Épuisé";
      if (d.stock > 0 && offHours) b.querySelector(".d-left").textContent = "plus servi";
      else if (d.stock > 0 && tooExpensive) b.querySelector(".d-left").textContent = "solde insuffisant";
      else if (d.stock > 0 && d.stock <= 3) b.querySelector(".d-left").textContent = "plus que " + d.stock;
      b.addEventListener("click", () => openSheet(d));
      box.appendChild(b);
    }
    if (!state.drinks.length) {
      const p = document.createElement("p");
      p.className = "board-empty";
      p.textContent = "Aucun produit n'est encore proposé. Voyez un responsable.";
      box.appendChild(p);
    }
  }

  // ---- Feuille quantité -------------------------------------------------------
  function openSheet(d) {
    state.pick = d; state.qty = 1;
    $("sheet").querySelector(".sheet").dataset.cat = d.category;
    $("sheet-emoji").textContent = Store.emojiFor(d);
    $("sheet-name").textContent = d.name;
    $("sheet-error").textContent = "";
    renderQty();
    $("sheet").hidden = false;
  }
  // Quantité maximale : stock, 10 par commande, et ce que le solde permet de payer
  function maxQty(d) {
    const bySolde = d.price_cents > 0 ? Math.floor(available() / d.price_cents) : Infinity;
    return Math.max(0, Math.min(10, d.stock, bySolde));
  }
  function renderQty() {
    const d = state.pick;
    const max = maxQty(d);
    if (state.qty > max) state.qty = Math.max(1, max);
    $("qty-val").textContent = state.qty;
    $("qty-minus").disabled = state.qty <= 1;
    $("qty-plus").disabled = state.qty >= max;
    $("sheet-unit").textContent = state.qty > 1
      ? `${state.qty} × ${euro(d.price_cents)} = ${euro(d.price_cents * state.qty)}`
      : euro(d.price_cents);
    const after = -state.session.balance_cents - d.price_cents * state.qty;
    const limitBySolde = d.price_cents > 0 && Math.floor(available() / d.price_cents) < Math.min(10, d.stock)
                         && state.qty >= max;
    $("sheet-after").textContent = (after >= 0 ? `Restera sur votre carte : ${euro(after)}` : `À régler ensuite : ${euro(-after)}`)
      + (limitBySolde ? " — maximum permis par votre solde" : "");
    $("sheet-ok").disabled = max < 1;
  }
  function closeSheet() { $("sheet").hidden = true; state.pick = null; }

  $("qty-minus").addEventListener("click", () => { if (state.qty > 1) { state.qty--; renderQty(); } });
  $("qty-plus").addEventListener("click", () => { if (state.qty < maxQty(state.pick)) { state.qty++; renderQty(); } });
  $("sheet-cancel").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (ev) => { if (ev.target === $("sheet")) closeSheet(); });

  $("sheet-ok").addEventListener("click", async () => {
    if (busy || !state.pick) return;
    busy = true; $("sheet-ok").disabled = true;
    try {
      const r = await Store.order(state.session.token, state.pick.id, state.qty);
      state.session.balance_cents = r.balance_cents;
      state.session.available_cents = r.available_cents;
      closeSheet();
      showDone(r);
    } catch (e) {
      if (e.status === 401) { closeSheet(); return endSession(); }
      $("sheet-error").textContent = e.message;
      loadDrinks();
    } finally {
      busy = false; $("sheet-ok").disabled = false;
    }
  });

  // ---- Confirmation -----------------------------------------------------------
  let doneTimer = null;
  function showDone(r) {
    $("done-title").textContent = `${r.qty > 1 ? r.qty + " × " : ""}${r.drink} — ${euro(r.amount_cents)}`;
    renderSlate($("done-slate"), r.balance_cents);
    const who = document.createElement("span");
    who.className = "who"; who.textContent = state.session.name;
    $("done-slate").prepend("C'est noté, ", who, ". ");
    show("done");
    let n = DONE_SECONDS;
    $("done-count").textContent = "(" + n + ")";
    clearInterval(doneTimer);
    doneTimer = setInterval(() => {
      n--; $("done-count").textContent = "(" + n + ")";
      if (n <= 0) endSession();
    }, 1000);
    loadDrinks();
  }
  $("btn-again").addEventListener("click", () => { clearInterval(doneTimer); openMenu(); });
  $("btn-done").addEventListener("click", endSession);
  $("btn-finish").addEventListener("click", endSession);

  function resetSession() {
    clearInterval(doneTimer); clearInterval(pendingTimer);
    closeSheet();
    if (state.session) Store.logout(state.session.token);
    state.session = null; state.code = ""; state.firstCode = "";
    $("name").value = "";
    $("idle").hidden = true;
  }
  // Fin d'une commande ou inactivité : la borne revient toujours à l'écran des tarifs de la section
  function endSession() { sectionHome(); }
  // Accueil de la section en cours (bouton Retour, sortie de la gestion)
  function sectionHome() {
    document.activeElement?.blur?.();
    resetSession();
    if (!Store.hasAdmins()) return openAuth("setup");
    loadDrinks();
    renderHomeStatus();
    show("home");
    tick();
  }


  // ---- Carte créée, en attente de validation ---------------------------------
  let pendingTimer = null;
  function showPending(name) {
    $("pending-name").textContent = name;
    show("pending");
    let n = 20;
    $("pending-count").textContent = "(" + n + ")";
    clearInterval(pendingTimer);
    pendingTimer = setInterval(() => {
      n--; $("pending-count").textContent = "(" + n + ")";
      if (n <= 0) endSession();
    }, 1000);
  }
  $("btn-pending-ok").addEventListener("click", endSession);

  // ---- Inactivité -------------------------------------------------------------
  let idleTimer = null, idleCountdown = null;
  function armIdle() {
    clearTimeout(idleTimer); clearInterval(idleCountdown);
    $("idle").hidden = true;
    if (!["auth", "menu"].includes(state.screen) || !$("v-admin").hidden) return;
    if (state.screen === "auth" && !M().back) return;      // premier lancement / nouveau code : pas de retour auto
    idleTimer = setTimeout(() => {
      let n = IDLE_GRACE;
      $("idle-count").textContent = n;
      $("idle").hidden = false;
      idleCountdown = setInterval(() => {
        n--; $("idle-count").textContent = n;
        if (n <= 0) { clearInterval(idleCountdown); endSession(); }
      }, 1000);
    }, IDLE_SECONDS * 1000);
  }
  for (const ev of ["pointerdown", "keydown", "input"]) {
    document.addEventListener(ev, () => { if ($("idle").hidden) armIdle(); }, { passive: true });
  }
  $("idle-stay").addEventListener("click", armIdle);

  // ---- La lampe de l'écran des tarifs grésille de temps en temps ---------------
  // Deux lampes, chacune avec son propre tirage au hasard : elles ne grésillent pas ensemble
  function scheduleFlicker(lamp) {
    setTimeout(() => {
      if (state.screen === "home" && $("v-admin").hidden && !document.hidden) {
        lamp.classList.remove("flicker-1", "flicker-2", "flicker-3");
        void lamp.offsetWidth;
        lamp.classList.add("flicker-" + (1 + Math.floor(Math.random() * 3)));
      }
      scheduleFlicker(lamp);
    }, 3000 + Math.random() * 11000);   // toutes les 3 à 14 s, au hasard
  }
  document.querySelectorAll("#s-home .lamp").forEach((lamp) => {
    lamp.addEventListener("animationend", (e) => {
      if (e.target.classList.contains("cone")) lamp.classList.remove("flicker-1", "flicker-2", "flicker-3");
    });
    scheduleFlicker(lamp);
  });

  // ---- Accès responsable : appui long de 3 s sur le titre ---------------------
  let holdT = null;
  const ring = $("hold-ring");
  function holdStart(ev) {
    ev.preventDefault();
    ring.style.left = ev.clientX + "px"; ring.style.top = ev.clientY + "px";
    ring.classList.remove("on"); void ring.offsetWidth; ring.classList.add("on");
    holdT = setTimeout(() => { holdEnd(); openAdminLogin(); }, HOLD_MS);
  }
  function holdEnd() { clearTimeout(holdT); ring.classList.remove("on"); }
  $("btn-admin").addEventListener("click", openAdminLogin);
  $("brand").addEventListener("pointerdown", holdStart);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) $("brand").addEventListener(ev, holdEnd);

  function openAdminLogin() { openAuth("admin"); }

  // ---- Navigation -------------------------------------------------------------
  document.querySelectorAll("#v-kiosk [data-go]").forEach((b) => b.addEventListener("click", () => {
    const g = b.dataset.go;
    if (g !== "home") return openAuth(g);
    if (state.screen === "auth" && state.mode === "setup") showSections(); else sectionHome();
  }));
  $("btn-switch").addEventListener("click", showSections);
  document.addEventListener("contextmenu", (e) => { if ($("v-admin").hidden) e.preventDefault(); });

  return {
    home: sectionHome,
    sections: showSections,
    setup: () => openAuth("setup"),
    fatal: (msg) => { $("fatal-msg").textContent = msg; show("fatal"); },
  };
})();
