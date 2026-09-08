/* =============================================================================
 * Black Queen — BOOTSTRAP / GLUE
 * Wires the menu, settings editor, and game lifecycle to the engine + UI.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // Persisted rules (localStorage) layered over defaults.
  function loadRules() {
    const base = BQ.cloneRules();
    try {
      const saved = JSON.parse(localStorage.getItem('bq_rules') || '{}');
      Object.assign(base, saved);
    } catch (_) {}
    return base;
  }
  function saveRules(rules) {
    try { localStorage.setItem('bq_rules', JSON.stringify(rules)); } catch (_) {}
  }
  // Treeky has its own (small) rule set + persistence.
  function loadTreekyRules() {
    const base = BQ.cloneTreekyRules();
    try { Object.assign(base, JSON.parse(localStorage.getItem('treeky_rules') || '{}')); } catch (_) {}
    return base;
  }
  function saveTreekyRules(r) {
    try { localStorage.setItem('treeky_rules', JSON.stringify(r)); } catch (_) {}
  }
  // Bluff has its own (small) rule set + persistence.
  function loadBluffRules() {
    const base = BQ.cloneBluffRules();
    try { Object.assign(base, JSON.parse(localStorage.getItem('bluff_rules') || '{}')); } catch (_) {}
    return base;
  }
  function saveBluffRules(r) {
    try { localStorage.setItem('bluff_rules', JSON.stringify(r)); } catch (_) {}
  }

  // ---- multiplayer session token (survives refresh / reconnect) ----------
  function loadSession() {
    try { return JSON.parse(localStorage.getItem('bq_session') || 'null'); } catch (_) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem('bq_session', JSON.stringify(s)); } catch (_) {}
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem('bq_session'); } catch (_) {}
  }

  // ---- backups of multiplayer rooms we're seated in --------------------------
  // The room streams every seated player a sealed (gzip + AES-GCM, server-
  // keyed) copy of its full state after every change. We can't read it — it's
  // only useful handed back: if the room ever vanishes from the server,
  // `restore` rebuilds it from this blob and everyone rejoins. Any one player's
  // copy is enough. code -> {blob, meta, ts}.
  const BACKUPS_KEY = 'bq_backups';
  const BACKUP_MAX = 10;
  const BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  function loadBackups() {
    let all;
    try { all = JSON.parse(localStorage.getItem(BACKUPS_KEY) || '{}'); } catch (_) { all = {}; }
    if (!all || typeof all !== 'object') all = {};
    // Expire stale entries; keep only the newest few.
    const now = Date.now();
    const keep = Object.keys(all)
      .filter((c) => all[c] && typeof all[c].blob === 'string' && (now - (all[c].ts || 0)) < BACKUP_TTL_MS)
      .sort((a, b) => (all[b].ts || 0) - (all[a].ts || 0))
      .slice(0, BACKUP_MAX);
    const out = {};
    keep.forEach((c) => { out[c] = all[c]; });
    return out;
  }
  function saveBackups(all) {
    try { localStorage.setItem(BACKUPS_KEY, JSON.stringify(all)); } catch (_) {}
  }
  function putBackup(code, blob, meta) {
    const all = loadBackups();
    all[code] = { blob, meta: meta || {}, ts: Date.now() };
    saveBackups(all);
  }
  function dropBackup(code) {
    if (!code) return;
    const all = loadBackups();
    if (!(code in all)) return;
    delete all[code];
    saveBackups(all);
  }

  // ---- single-player game persistence (survives refresh; works offline) --
  const SP_KEY = 'bq_sp_game';
  function loadSPGame() {
    try { const d = JSON.parse(localStorage.getItem(SP_KEY) || 'null'); return (d && d.v === 1) ? d : null; } catch (_) { return null; }
  }
  function saveSPGame(snap) {
    try { localStorage.setItem(SP_KEY, JSON.stringify(snap)); } catch (_) {}
  }
  function clearSPGame() {
    try { localStorage.removeItem(SP_KEY); } catch (_) {}
  }

  let rules = loadRules();
  let engine = null;
  const ui = new BQ.UI();
  const treekyUI = new BQ.TreekyUI();
  const bluffUI = new BQ.BluffUI();
  let selectedGame = 'blackqueen';   // menu game picker: 'blackqueen' | 'treeky' | 'bluff'
  let treekyRules = loadTreekyRules();
  let bluffRules = loadBluffRules();
  let settingsTab = 'blackqueen';    // active tab in the main Settings panel

  // ---- multiplayer state -----------------------------------------------
  let net = null;            // BQ.NetClient
  let netEngine = null;      // BQ.NetworkEngine
  let isMultiplayer = false;
  let isHost = false;
  let isSpectator = false;   // watching a livestream — no seat, no cards, no moves
  let myName = 'You';
  let lastLobbyState = null;  // most recent lobby snapshot (for the seat-arrange prompt)
  // Reconnection: a persisted session token lets a refreshed / dropped player
  // re-attach to their exact seat. We also auto-reconnect (with backoff) when
  // the socket drops without a page reload (e.g. a brief Wi-Fi outage).
  let session = loadSession();
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  /* ---- Settings editor schema (label, key, type, opts) ------------------- */
  const SETTINGS_SCHEMA = [
    { section: 'Scoring' },
    { key: 'queenPoints', label: 'Black Queen points', type: 'number' },
    { key: 'heartPoints', label: 'Each heart points', type: 'number' },
    { key: 'noTrickPenalty', label: 'No-trick score (Rule 4)', type: 'number' },
    { key: 'noTrickRuleEnabled', label: 'Enable no-trick rule', type: 'check' },
    { key: 'consecutiveZeroLimit', label: 'Consecutive 0-rounds limit (Rule 5)', type: 'number' },
    { key: 'consecutiveZeroPenalty', label: 'Penalty for that streak', type: 'number' },
    { key: 'consecutiveZeroRuleEnabled', label: 'Enable streak rule', type: 'check' },
    { key: 'queenExemptEnabled', label: 'Queen immunity at high score', type: 'check' },
    { key: 'queenExemptScore', label: 'Queen immunity score (≥)', type: 'number' },

    { section: 'Play' },
    { key: 'heartsMustBeBroken', label: 'Hearts must be broken before leading', type: 'check' },
    { key: 'queenBreaksHearts', label: 'Black Queen also breaks hearts', type: 'check' },
    { key: 'mustThrowQueen', label: 'Must throw Queen when void, or onto a higher spade', type: 'check' },
    { key: 'shootTheMoonEnabled', label: 'Allow shooting the moon', type: 'check' },
    { key: 'dealerIsHighestScore', label: 'Highest score deals (Rule 7)', type: 'check' },
    { key: 'playDirection', label: 'Play direction', type: 'select', opts: [['right', 'Right (counter-clockwise)'], ['left', 'Left (clockwise)']] },

    { section: 'Match' },
    { key: 'endMode', label: 'Game ends by', type: 'select', opts: [['targetScore', 'Target score'], ['fixedRounds', 'Fixed rounds']] },
    { key: 'endScore', label: 'Target score', type: 'number' },
    { key: 'roundLimit', label: 'Round limit', type: 'number' },
    { key: 'lowestScoreWins', label: 'Lowest score wins', type: 'check' },

    { section: 'Feel' },
    { key: 'botThinkMs', label: 'Bot think time (ms)', type: 'number' },
    { key: 'soundEnabled', label: 'Sound', type: 'check' },
  ];

  // Per-channel volume sliders (Settings → Sound Volumes). Applied live and
  // saved to prefs — independent of the Save button, which is for game rules.
  function appendVolumeSection(form) {
    const h = document.createElement('h3');
    h.className = 'full';
    h.textContent = 'Sound Volumes';
    form.appendChild(h);
    const PREVIEW = {
      master: () => BQ.Sound.trickWin(),
      cards: () => BQ.Sound.play(),
      punch: () => BQ.Sound.punch(),
      fx: () => BQ.Sound.sparkle(),
      ui: () => BQ.Sound.click(),
    };
    BQ.Sound.CHANNELS.forEach((ch) => {
      const row = document.createElement('div');
      row.className = 'set-row vol';
      const lab = document.createElement('label');
      lab.textContent = ch.label;
      row.appendChild(lab);
      const wrap = document.createElement('div');
      wrap.className = 'vol-wrap';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0'; input.max = '1'; input.step = '0.05';
      input.value = BQ.Sound.getVolume(ch.id);
      const val = document.createElement('span');
      val.className = 'vol-val';
      val.textContent = Math.round(BQ.Sound.getVolume(ch.id) * 100) + '%';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        BQ.Sound.setVolume(ch.id, v);
        val.textContent = Math.round(v * 100) + '%';
        const vols = Object.assign({}, BQ.Prefs.get().volumes);
        vols[ch.id] = v;
        BQ.Prefs.set({ volumes: vols });
      });
      // a short representative sound when the slider is released
      input.addEventListener('change', () => { BQ.Sound.unlock(); if (PREVIEW[ch.id]) PREVIEW[ch.id](); });
      wrap.appendChild(input);
      wrap.appendChild(val);
      row.appendChild(wrap);
      form.appendChild(row);
    });
  }

  function buildSettingsForm() {
    const form = $('#settingsForm');
    form.innerHTML = '';
    appendVolumeSection(form);
    SETTINGS_SCHEMA.forEach((f) => {
      if (f.section) {
        const h = document.createElement('h3');
        h.className = 'full';
        h.textContent = f.section;
        form.appendChild(h);
        return;
      }
      const row = document.createElement('div');
      row.className = 'set-row' + (f.type === 'check' ? ' check' : '');
      const id = 'set_' + f.key;
      let control;
      if (f.type === 'check') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.checked = !!rules[f.key];
        row.appendChild(control);
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
      } else if (f.type === 'select') {
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
        control = document.createElement('select');
        f.opts.forEach(([val, text]) => {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          if (rules[f.key] === val) o.selected = true;
          control.appendChild(o);
        });
        row.appendChild(control);
      } else {
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
        control = document.createElement('input');
        control.type = 'number';
        control.value = rules[f.key];
        row.appendChild(control);
      }
      control.id = id;
      control.dataset.key = f.key;
      control.dataset.type = f.type;
      form.appendChild(row);
    });
  }

  function readSettingsForm() {
    $('#settingsForm').querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'check') rules[key] = el.checked;
      else if (type === 'number') rules[key] = Number(el.value);
      else rules[key] = el.value;
    });
    saveRules(rules);
    BQ.Sound.setEnabled(rules.soundEnabled);
    if (engine) engine.rules = rules; // applies next round
  }

  /* ---- How to play content --------------------------------------------- */
  function rulesHtml() {
    return (
      '<h2>♛ How to Play Black Queen</h2>' +
      '<p style="color:#cfe6d6;margin-bottom:0.8rem">A trick-taking game. Avoid winning tricks that contain penalty cards — the lowest total score wins.</p>' +
      '<h3>The Penalty Cards</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li><b>Black Queen (Q♠)</b> = <b>' + rules.queenPoints + '</b> points</li>' +
      '<li>Each <b style="color:#ff8a7a">Heart ♥</b> = <b>' + rules.heartPoints + '</b> point</li>' +
      '<li>Total points per round = <b>' + rules.expectedRoundTotal + '</b></li>' +
      '</ul>' +
      '<h3>Special Rules</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li>Win <b>no trick</b> all round → <b>' + rules.noTrickPenalty + '</b> to your score.</li>' +
      '<li><b>' + rules.consecutiveZeroLimit + '</b> zero-point rounds in a row → <b>' + rules.consecutiveZeroPenalty + '</b>.</li>' +
      '<li><b>No passing</b> of cards.</li>' +
      '<li>The <b>highest-scoring</b> player deals; the player to their <b>right</b> plays first, and play continues to the <b>right</b>.</li>' +
      '</ul>' +
      '<h3>Playing a Trick</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li>Follow the led suit if you can.</li>' +
      '<li>Highest card of the led suit wins the trick and leads next.</li>' +
      '<li>Hearts can\'t be led until a heart (or the Queen) has been played.</li>' +
      '</ul>' +
      '<div class="close-row"><button class="btn small" data-close="rulesOverlay">Got it</button></div>'
    );
  }

  /* ---- Game lifecycle (single player) ----------------------------------- */
  function newGame(name) {
    isMultiplayer = false; isHost = true;
    document.body.classList.remove('mp');
    clearSPGame();                       // start fresh — drop any old saved game
    engine = new BQ.GameEngine(rules);
    engine.init(name);
    wireSinglePersistence(engine);
    ui.attach(engine);
    ui.show('game');
    BQ.Sound.unlock();
    if (rules.soundEnabled) BQ.Sound.startMusic();
    setupRoundControls();
    engine.startRound();
  }

  // Single-player Treeky: you + 3 bots, run entirely in this engine.
  function newTreekyGame(name) {
    isMultiplayer = false; isHost = true; isSpectator = false;
    document.body.classList.remove('mp', 'spectating');
    clearSPGame();                       // Treeky doesn't persist; drop any Black Queen save
    engine = new BQ.TreekyEngine(BQ.cloneOf(treekyRules));
    engine.init(name);
    treekyUI.attach(engine);
    treekyUI.show('treekyGame');
    BQ.Sound.unlock();
    if (rules.soundEnabled) BQ.Sound.startMusic();
    const again = $('#tkOverAgain'); if (again) again.style.display = '';
    const wait = $('#tkOverWait'); if (wait) wait.style.display = 'none';
    engine.start();
  }

  function closeTreekyOverlays() {
    const a = $('#tkOverOverlay'); if (a) a.classList.remove('show');
    const b = $('#suitPickerOverlay'); if (b) b.classList.remove('show');
  }

  // Single-player Bluff: you + 3 bots, run entirely in this engine.
  function newBluffGame(name) {
    isMultiplayer = false; isHost = true; isSpectator = false;
    document.body.classList.remove('mp', 'spectating');
    clearSPGame();                       // Bluff doesn't persist; drop any Black Queen save
    engine = new BQ.BluffEngine(BQ.cloneOf(bluffRules));
    engine.init(name);
    bluffUI.attach(engine);
    bluffUI.show('bluffGame');
    BQ.Sound.unlock();
    if (rules.soundEnabled) BQ.Sound.startMusic();
    const again = $('#blOverAgain'); if (again) again.style.display = '';
    const wait = $('#blOverWait'); if (wait) wait.style.display = 'none';
    engine.start();
  }

  function closeBluffOverlays() {
    const a = $('#blOverOverlay'); if (a) a.classList.remove('show');
  }

  /* ---- Bluff settings form (game options) ------------------------------- */
  function buildBluffSettingsForm(sel) {
    const f = $(sel || '#blSettingsForm');
    if (!f) return;
    const opt = (label, key, opts) => {
      const cur = bluffRules[key];
      const options = opts.map((o) => '<option value="' + o.v + '"' + (o.v === cur ? ' selected' : '') + '>' + o.label + '</option>').join('');
      return '<div class="row"><label>' + label + '</label><select data-key="' + key + '">' + options + '</select></div>';
    };
    f.innerHTML =
      opt('Decks', 'decks', [{ v: 1, label: '1 deck (52)' }, { v: 2, label: '2 decks (104)' }]) +
      opt('Max cards per play', 'maxPerPlay', [2, 3, 4, 5].map((v) => ({ v, label: v + ' cards' }))) +
      opt('Play direction', 'playDirection', [{ v: 'right', label: 'Right ↻' }, { v: 'left', label: 'Left ↺' }]) +
      opt('Table size (single-player)', 'playerCount', [2, 3, 4, 5, 6, 7, 8].map((v) => ({ v, label: v + ' players' }))) +
      opt('Bot speed', 'botThinkMs', [{ v: 1700, label: 'Relaxed' }, { v: 1100, label: 'Normal' }, { v: 650, label: 'Fast' }]);
  }
  function saveBluffSettingsForm(sel) {
    const f = $(sel || '#blSettingsForm');
    if (!f) return;
    f.querySelectorAll('select[data-key]').forEach((s) => {
      const key = s.getAttribute('data-key');
      const num = parseInt(s.value, 10);
      bluffRules[key] = isNaN(num) ? s.value : num;
    });
    saveBluffRules(bluffRules);
  }

  /* ---- Treeky settings form (game options) ------------------------------ */
  // `sel` is the container selector — the in-game gear uses '#tkSettingsForm',
  // the main Settings panel's Treeky tab uses '#settingsTreekyForm'.
  function buildTreekySettingsForm(sel) {
    const f = $(sel || '#tkSettingsForm');
    if (!f) return;
    const opt = (label, key, opts) => {
      const cur = treekyRules[key];
      const options = opts.map((o) => '<option value="' + o.v + '"' + (o.v === cur ? ' selected' : '') + '>' + o.label + '</option>').join('');
      return '<div class="row"><label>' + label + '</label><select data-key="' + key + '">' + options + '</select></div>';
    };
    f.innerHTML =
      opt('Decks', 'decks', [{ v: 1, label: '1 deck (52)' }, { v: 2, label: '2 decks (104)' }]) +
      opt('Play direction', 'playDirection', [{ v: 'right', label: 'Right ↻' }, { v: 'left', label: 'Left ↺' }]) +
      opt('Table size (single-player)', 'playerCount', [3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({ v, label: v + ' players' }))) +
      opt('Cards per player', 'handSize', [{ v: 7, label: '7' }, { v: 8, label: '8' }, { v: 10, label: '10' }, { v: 12, label: '12' }]) +
      opt('Bot speed', 'botThinkMs', [{ v: 1800, label: 'Relaxed' }, { v: 1250, label: 'Normal' }, { v: 700, label: 'Fast' }]);
  }
  function saveTreekySettingsForm(sel) {
    const f = $(sel || '#tkSettingsForm');
    if (!f) return;
    f.querySelectorAll('select[data-key]').forEach((s) => {
      const key = s.getAttribute('data-key');
      const num = parseInt(s.value, 10);           // numeric options -> number; else keep the string
      treekyRules[key] = isNaN(num) ? s.value : num;
    });
    saveTreekyRules(treekyRules);
  }

  /* ---- main Settings panel: Black Queen / Treeky tabs ------------------- */
  function setSettingsTab(tab) {
    settingsTab = (tab === 'treeky' || tab === 'bluff') ? tab : 'blackqueen';
    document.querySelectorAll('#settingsTabs .settings-tab').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-tab') === settingsTab));
    document.querySelectorAll('#settingsOverlay .settings-pane').forEach((p) => {
      p.style.display = (p.getAttribute('data-pane') === settingsTab) ? '' : 'none';
    });
  }
  function openMainSettings() {
    buildSettingsForm();                              // Black Queen rules
    buildTreekySettingsForm('#settingsTreekyForm');   // Treeky options
    buildBluffSettingsForm('#settingsBluffForm');     // Bluff options
    setSettingsTab(selectedGame);
    ui.openOverlay('settingsOverlay');
  }

  /* ---- Treeky sound-effect / taunt dock (bottom-right) ------------------ */
  function setupTreekyAttackRow() {
    const row = $('#tkAttackDock');
    if (!row || !BQ.FX || !BQ.FX.ATTACKS) return;
    BQ.FX.ATTACKS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'attack-btn';
      b.innerHTML = '<span></span><small></small>';
      b.querySelector('span').textContent = a.emoji;
      b.querySelector('small').textContent = a.label;
      b.title = 'Play a ' + a.label + ' effect at the table';
      b.addEventListener('click', () => {
        if (isMultiplayer && net && net.connected) {
          net.send({ t: 'attack', kind: a.id });
        } else if (BQ.Prefs.get().attacks === false) {
          treekyUI.toast('Effects are muted (🎨 Appearance)');
        } else {
          BQ.FX.attack(a.id, (myName || 'You'), treekyUI.seatAnchor(treekyUI.me));
          BQ.Sound.attack(a.id);
        }
      });
      row.appendChild(b);
    });
  }

  // Persist the local game after every state change so a refresh can restore it.
  function wireSinglePersistence(eng) {
    const save = () => { if (!isMultiplayer && engine === eng) saveSPGame(eng.snapshot()); };
    ['roundStart', 'turn', 'cardPlayed', 'trickWon', 'heartsBroken', 'roundEnd'].forEach((ev) => eng.on(ev, save));
    eng.on('gameOver', clearSPGame);     // finished — nothing left to resume
    // attack-taunt credit: refunded when you play a card, fresh each round
    eng.on('cardPlayed', (e) => { if (e.playerIndex === 0 && !attackCredit) { attackCredit = true; updateAttackBtns(); } });
    eng.on('roundStart', () => { attackCredit = true; updateAttackBtns(); });
  }

  // On page load: rebuild a single-player game in progress from localStorage.
  function resumeSingleGame() {
    const data = loadSPGame();
    if (!data || !data.players) return false;
    try {
      isMultiplayer = false; isHost = true;
      engine = BQ.GameEngine.fromSnapshot(data);
      wireSinglePersistence(engine);
      setupRoundControls();
      ui.attach(engine);
      ui.show('game');
      BQ.Sound.unlock();
      if (rules.soundEnabled) BQ.Sound.startMusic();
      engine.resume();
      return true;
    } catch (_) {
      clearSPGame();
      return false;
    }
  }

  /* ---- Multiplayer ------------------------------------------------------- */
  // A clear, reusable explanation for when the server can't be reached.
  function serverHelp(err) {
    const code = err && err.code;
    if (code === 'not-served' || location.protocol === 'file:') {
      return 'Multiplayer needs the game server. You opened this file directly. ' +
        'In a terminal run  node server.js  then open the http://… address it prints (the same address on every device).';
    }
    return 'Could not reach the game server at ' + location.host + '. ' +
      'Make sure  node server.js  is running and you opened the address it printed (not a file or a different server).';
  }

  function setMpStatus(msg, kind) {
    const el = $('#mpStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mp-status' + (kind ? ' ' + kind : '');
  }

  function setControlsEnabled(on) {
    $('#btnCreate').disabled = !on;
    $('#btnJoin').disabled = !on;
    const w = $('#btnWatch'); if (w) w.disabled = !on;
  }

  // Open the multiplayer screen and probe the server. There is no room to open a
  // socket to yet (a room code is assigned on create / typed on join), so we just
  // confirm the lobby endpoint is reachable over HTTP.
  function openMultiplayer() {
    $('#mpError').textContent = '';
    ui.show('mp');
    $('#mpName').focus();
    setControlsEnabled(false);
    setMpStatus('Connecting to server…', '');
    fetch('/parties/lobby/lobby?need=list')
      .then((r) => {
        if (!r.ok) throw new Error('unreachable');
        setMpStatus('✓ Connected. Create a room or join with a code.', 'ok');
        setControlsEnabled(true);
      })
      .catch(() => { setMpStatus('Could not reach the game server. Refresh and try again.', 'bad'); setControlsEnabled(true); });
  }

  // Open (or reuse) a socket bound to a specific room code. On PartyKit the room
  // code lives in the connection URL, so every flow must know its code up front
  // (create asks the lobby for a fresh one; join/spectate/resume already have it).
  function connectTo(code) {
    if (net && net.connected && net.roomId === code) return Promise.resolve();
    net = new BQ.NetClient();
    wireNet();
    // The table's engine mirror sends moves through the client it was built
    // with — point it at the NEW socket, or every play after a reconnect would
    // go quietly into the dead one.
    if (netEngine) netEngine.client = net;
    return net.connect(code, 'main');
  }

  // Session token for a room, if this device holds one (else undefined: the
  // server matches the seat by account instead — cross-device rejoin).
  function tokenFor(code) {
    return (session && session.code === code && session.token) ? session.token : undefined;
  }

  // Re-open the socket and reclaim our seat, backing off on repeated failure.
  function scheduleReconnect() {
    if (reconnectTimer || !session) return;
    const delay = Math.min(1000 * Math.pow(1.6, reconnectAttempts), 8000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectTo(session.code)
        .then(() => net.send({ t: 'resume', code: session.code, token: session.token }))
        .catch(() => scheduleReconnect());
    }, delay);
  }

  /* ---- Unfinished games (menu panel) ---------------------------------------
   * Two sources, merged by room code:
   *   • the lobby's answer to "which rooms hold a seat for MY account?"
   *     (GET ?need=mine — a game started on another device, or one the server
   *     is holding because everyone dropped);
   *   • this device's sealed backups (see putBackup) — a room the server LOST
   *     can be rebuilt from these, so they're listed even when the lobby has
   *     never heard of the room.
   * One tap rejoins: connect, `resume` (token if we have one, else by account);
   * if the room answers "room-gone" and we hold a backup, `restore` it first.  */
  const GAME_LABEL = { blackqueen: ['♛', 'Black Queen'], treeky: ['🎴', 'Treeky'], bluff: ['🃏', 'Bluff'] };
  let serverRooms = [];            // last ?need=mine answer
  let restoreTried = new Set();    // rooms we already offered a backup to (no loops)

  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function renderUnfinished() {
    const box = $('#unfinishedBox'), list = $('#unfinishedList');
    if (!box || !list) return;
    const backups = loadBackups();
    const rows = new Map();
    serverRooms.forEach((r) => rows.set(r.code, { code: r.code, gameType: r.gameType, server: true, live: !!r.live, ts: r.ts || 0 }));
    Object.keys(backups).forEach((code) => {
      const b = backups[code];
      const row = rows.get(code) || { code, server: false, live: false, ts: 0 };
      row.gameType = row.gameType || (b.meta && b.meta.gameType);
      row.backup = b;
      row.ts = Math.max(row.ts, b.ts || 0);
      rows.set(code, row);
    });
    // The room we're currently seated in (this tab) isn't "unfinished".
    if (isMultiplayer && session) rows.delete(session.code);
    const items = [...rows.values()].sort((a, b) => b.ts - a.ts);
    if (!items.length) { box.style.display = 'none'; list.innerHTML = ''; return; }

    list.innerHTML = items.map((r) => {
      const m = (r.backup && r.backup.meta) || {};
      const sub = [];
      if (m.round) sub.push('Round ' + m.round);
      if (Array.isArray(m.players) && m.players.length) sub.push(m.players.map(escHtml).join(', '));
      if (r.ts) sub.push(ago(r.ts));
      const chips = (r.server ? '<span class="unfinished-chip live">' + (r.live ? 'on server' : 'held for you') + '</span>' : '') +
        (r.backup ? '<span class="unfinished-chip local">backup on this device</span>' : '');
      const forget = r.backup ? '<button class="unfinished-forget" data-forget="' + escHtml(r.code) + '" title="Forget this backup">✕</button>' : '';
      const label = GAME_LABEL[r.gameType] || GAME_LABEL.blackqueen;
      return '<div class="unfinished-row">' +
        '<span class="unfinished-icon">' + label[0] + '</span>' +
        '<div class="unfinished-main">' +
          '<div class="unfinished-title">' + escHtml(label[1]) +
            ' <span class="unfinished-code">#' + escHtml(r.code) + '</span>' + chips + '</div>' +
          '<div class="unfinished-sub">' + sub.join(' · ') + '</div>' +
        '</div>' +
        '<button class="btn primary" data-rejoin="' + escHtml(r.code) + '">' + (r.server ? 'Rejoin' : 'Restore') + '</button>' +
        forget +
        '</div>';
    }).join('');
    box.style.display = '';
  }

  // Ask the lobby which rooms hold our seat, then repaint the panel. Always
  // repaints (from local backups) even when the lobby is unreachable.
  function refreshUnfinished() {
    renderUnfinished();
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    fetch('/parties/lobby/lobby?need=mine')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        serverRooms = (m && Array.isArray(m.rooms)) ? m.rooms
          : (m && m.code) ? [{ code: m.code, started: !!m.started, live: !!m.live, gameType: 'blackqueen', ts: 0 }]
          : [];
        renderUnfinished();
      })
      .catch(() => {});
  }

  // Walk back into a room from the panel (or auto, on page load).
  function rejoinRoom(code) {
    if (!code) return;
    restoreTried.delete(code);
    ui.setReconnecting(true);
    connectTo(code)
      .then(() => net.send({ t: 'resume', token: tokenFor(code) }))
      .catch(() => { ui.setReconnecting(false); ui.toast('Could not reach the game server.'); });
  }

  // The room is empty on the server — if this device hosted it, hand back our
  // sealed copy. Returns true when a restore was sent (the caller waits for
  // `restored` / `restoreFail` instead of giving up).
  function tryRestore(code) {
    if (!code || restoreTried.has(code)) return false;
    const b = loadBackups()[code];
    if (!b) return false;
    restoreTried.add(code);
    ui.setReconnecting(true);
    ui.toast('Room ' + code + ' was lost — restoring it from your backup…');
    net.send({ t: 'restore', code, blob: b.blob, token: tokenFor(code) });
    return true;
  }

  // On page load: walk straight back into whatever game we were in.
  function attemptResume() {
    // Multiplayer session takes priority (it needs the server).
    if (session && session.token && session.code &&
        (location.protocol === 'http:' || location.protocol === 'https:')) {
      myName = session.name || 'Player';
      ui.setReconnecting(true);
      connectTo(session.code)
        .then(() => net.send({ t: 'resume', code: session.code, token: session.token }))
        .catch(() => {
          // Server unreachable right now (offline, deploy in flight). Keep the
          // session and keep trying — a game is only over when the server says so.
          ui.setReconnecting(false);
          if (!resumeSingleGame()) { ui.setReconnecting(true); scheduleReconnect(); }
        });
      return;
    }
    // Otherwise restore a single-player game in progress (works offline too).
    resumeSingleGame();
  }

  function wireNet() {
    net.on('joined', (m) => {
      $('#mpError').textContent = '';
      if (m.host != null) isHost = m.host;
      // Remember who we are so a refresh / drop can reclaim this exact seat.
      if (m.token && m.code) {
        myName = myName || (session && session.name) || 'Player';
        session = { code: m.code, token: m.token, name: myName };
        saveSession(session);
      }
      // A successful (re)attach clears any reconnect backoff + banner.
      reconnectAttempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ui.setReconnecting(false);
      renderUnfinished();
      ui.setNetStatus('online', net.latencyMs);
      // tell the table about preferences they can see (🛡️ = taunts muted)
      net.send({ t: 'prefs', attacksMuted: BQ.Prefs.get().attacks === false });
    });
    // We're now a spectator. The table itself arrives via the first 'game'
    // message (which shows the game screen); here we just flag the mode.
    net.on('spectating', (m) => {
      isSpectator = true;
      $('#mpError').textContent = '';
      setMpStatus('👁 Watching room ' + m.code + ' — no cards are shown.', 'ok');
    });
    net.on('error', (m) => { setMpStatus(m.msg || 'Error', 'bad'); $('#mpError').textContent = ''; BQ.Sound.error(); });
    net.on('resumeFail', (m) => {
      // The room is empty on the server. If we hosted it and hold a sealed
      // backup, rebuild it instead of giving up (see tryRestore → 'restored').
      if (m && m.reason === 'room-gone' && tryRestore(net.roomId)) return;
      // Otherwise the room/seat really is gone (game ended, held too long, or
      // the seat was handed to another device). Drop the stale session and
      // return to a clean menu.
      const code = net.roomId;
      if (session && session.code === code) clearSession();
      ui.setReconnecting(false);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (isMultiplayer) { ui.toast('That game has ended — returning to menu.'); isMultiplayer = false; netEngine = null; }
      ui.show('menu');
      // A stale local token (seat handed to another device, then handed back)
      // can still rejoin by account — list it if a seat exists somewhere.
      refreshUnfinished();
    });
    // Our backup was accepted: the room is back with every seat held — take ours.
    net.on('restored', (m) => {
      ui.toast('Room ' + (m.code || net.roomId) + ' restored — rejoining…');
      net.send({ t: 'resume', token: tokenFor(net.roomId) });
    });
    net.on('restoreFail', (m) => {
      const code = net.roomId;
      const reason = m && m.reason;
      if (reason === 'room-live') {
        // Someone else restored it (or it was never gone) — just rejoin.
        net.send({ t: 'resume', token: tokenFor(code) });
        return;
      }
      // Unusable copy (foreign key, corrupted) — forget it so it stops being offered.
      if (reason === 'bad-backup') dropBackup(code);
      if (session && session.code === code) clearSession();
      ui.setReconnecting(false);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (isMultiplayer) { isMultiplayer = false; netEngine = null; }
      ui.toast(reason === 'room-busy' ? 'Room ' + code + ' is in use by another game.' : 'Could not restore that game.');
      ui.show('menu');
      refreshUnfinished();
    });
    // The room's sealed state after each change, sent to every seated player
    // (blob:null = the game finished — nothing left to restore, forget it).
    net.on('backup', (m) => {
      if (!m || !m.code) return;
      if (m.blob) putBackup(m.code, m.blob, m.meta); else dropBackup(m.code);
    });
    // Another of MY devices took this seat over (account hand-off). Let go
    // cleanly: no reconnect fight — the other device owns the seat now.
    net.on('takenOver', () => {
      clearSession();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempts = 0;
      ui.setReconnecting(false);
      if (BQ.Voice) BQ.Voice.leave();
      netEngine = null; isMultiplayer = false;
      document.body.classList.remove('mp');
      BQ.Sound.stopMusic();
      ui.toast('You rejoined this game from another device.');
      ui.show('menu');
      refreshUnfinished();
    });
    net.on('lobby', (m) => {
      isHost = m.state.youAreHost;
      renderLobby(m.state);
      ui.show('lobby');
    });
    // The host removed us from the room. Drop the session so we DON'T try to
    // resume back into the seat, then return to a clean menu.
    net.on('kicked', () => {
      clearSession();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempts = 0;
      ui.setReconnecting(false);
      if (BQ.Voice) BQ.Voice.leave();
      netEngine = null; isMultiplayer = false;
      document.body.classList.remove('mp');
      BQ.Sound.stopMusic();
      ui.toast('You were removed from the room by the host.');
      ui.show('menu');
      refreshUnfinished();
    });
    net.on('close', () => {
      ui.setNetStatus('offline');
      // Lost the socket. Any saved session (lobby OR mid-game) reconnects and
      // reclaims its seat transparently; without one there's nothing to resume.
      if (!session) { if (isMultiplayer) ui.toast('Disconnected from server'); return; }
      ui.setReconnecting(true);
      scheduleReconnect();
    });
    // Connection quality + presence — drive the status pill and seat dots.
    net.on('pong', () => ui.setNetStatus('online', net.latencyMs));
    net.on('peers', (m) => {
      ui.renderPeers(m.seats);
      if (m.note && m.note.name !== myName) {
        if (m.note.kind === 'lost') ui.toast('⚠️ ' + m.note.name + ' lost connection — bot filling in');
        else if (m.note.kind === 'back') ui.toast('✓ ' + m.note.name + ' is back online');
        else if (m.note.kind === 'left') ui.toast(m.note.name + ' left the game');
      }
    });
    net.on('emote', (m) => ui.showEmote(m.seat, m.text, m.name, true));
    net.on('chat', (m) => ui.showEmote(m.seat, m.text, m.name, false));
    // Voice chat (WebRTC) — server relays the roster + signaling; Voice does
    // the P2P audio. seatOf reads netEngine.me live (set once the game starts).
    BQ.Voice.attach(net, () => (netEngine ? netEngine.me : -1));
    net.on('voice', (m) => BQ.Voice.onRoster(m.seats));
    net.on('rtc', (m) => BQ.Voice.onSignal(m.from, m.data));
    // attack taunt — pops up at the ATTACKER's seat on every viewer's table
    // (muteable per player: 🎨)
    net.on('attack', (m) => {
      if (BQ.Prefs.get().attacks === false) return;
      const onTreeky = document.getElementById('treekyGame').classList.contains('active');
      const anchor = onTreeky ? treekyUI.seatAnchor(m.seat) : ui.seatAnchor(m.seat);
      BQ.FX.attack(m.kind, m.name, anchor);
      BQ.Sound.attack(m.kind);
    });
    net.on('ready', (m) => renderReady(m));
    // Play frozen because a player left mid-game (or un-frozen once resolved).
    net.on('paused', (m) => {
      if (m.paused) {
        const who = m.name ? m.name + ' left the table.' : 'A player left the table.';
        const wait = 'Waiting for the host to add a bot, or for a new player to join'
          + (m.code ? ' with code ' + m.code : '') + '…';
        showPause(who + ' ' + wait);
      } else {
        hidePause();
        ui.closeOverlay('vacancyOverlay');
      }
    });
    // Host-only: a player left — choose a bot or wait for a new player.
    // Receiving this means we ARE the current host (covers host reassignment
    // when the original host is the one who left).
    net.on('seatVacated', (m) => {
      isHost = true;
      const who = m.name ? m.name : 'A player';
      $('#vacancyMsg').textContent = who + ' left the table. Add a bot to keep playing, '
        + 'or wait for a new player to join with code ' + (m.code || (session && session.code) || '') + '.';
      ui.openOverlay('vacancyOverlay');
      BQ.Sound.error();
    });
    net.on('game', (m) => {
      const gt = m.snapshot && m.snapshot.gameType;
      const treeky = gt === 'treeky';
      const bluff = gt === 'bluff';
      if (!netEngine) {
        isMultiplayer = true;
        document.body.classList.add('mp');   // reveals net pill, presence chip, emotes
        if (bluff) {
          netEngine = new BQ.BluffNetworkEngine(net);
          netEngine.ingest(m.snapshot);
          bluffUI.attach(netEngine);
          netEngine.on('gameOver', () => {
            const again = $('#blOverAgain'); if (again) again.style.display = isHost ? '' : 'none';
            const wait = $('#blOverWait'); if (wait) wait.style.display = isHost ? 'none' : '';
          });
          bluffUI.show('bluffGame');
        } else if (treeky) {
          netEngine = new BQ.TreekyNetworkEngine(net);
          netEngine.ingest(m.snapshot);
          treekyUI.attach(netEngine);
          // Game-over: only the host can restart; others see a "waiting" note.
          netEngine.on('gameOver', () => {
            const again = $('#tkOverAgain'); if (again) again.style.display = isHost ? '' : 'none';
            const wait = $('#tkOverWait'); if (wait) wait.style.display = isHost ? 'none' : '';
          });
          treekyUI.show('treekyGame');
        } else {
          netEngine = new BQ.NetworkEngine(net);
          netEngine.ingest(m.snapshot);
          ui.attach(netEngine);
          // set up the round/game-over confirmation controls
          netEngine.on('roundEnd', setupRoundControls);
          netEngine.on('gameOver', setupGameOverControls);
          // attack credit refunds when I play a card (and each new round)
          netEngine.on('cardPlayed', (ev) => {
            if (ev.playerIndex === netEngine.me && !attackCredit) { attackCredit = true; updateAttackBtns(); }
          });
          netEngine.on('roundStart', () => { attackCredit = true; updateAttackBtns(); });
          ui.show('game');
        }
        BQ.Sound.unlock();
        if (rules.soundEnabled) BQ.Sound.startMusic();
      }
      netEngine.handle(m.snapshot, m.hint);
      // A finished game has nothing left to restore — drop any backup of it.
      if (m.hint && m.hint.name === 'gameOver') dropBackup(net.roomId);
    });
  }

  function createRoom() {
    myName = ($('#mpName').value || '').trim() || 'Host';
    $('#mpError').textContent = '';
    setMpStatus('Creating room…', '');
    // The lobby allocates a fresh, unused code; we then open the room at it.
    BQ.NetClient.lobby('create').then((res) => {
      if (!res || !res.code) { setMpStatus('Could not reach the lobby. Try again.', 'bad'); return; }
      connectTo(res.code).then(() => {
        setMpStatus('✓ Connected.', 'ok');
        net.send({ t: 'create', name: myName, gameType: selectedGame,
          treekyRules: selectedGame === 'treeky'
            ? { handSize: treekyRules.handSize, botThinkMs: treekyRules.botThinkMs, decks: treekyRules.decks, playDirection: treekyRules.playDirection }
            : undefined,
          bluffRules: selectedGame === 'bluff'
            ? { decks: bluffRules.decks, maxPerPlay: bluffRules.maxPerPlay, botThinkMs: bluffRules.botThinkMs, playDirection: bluffRules.playDirection }
            : undefined });
      }).catch((err) => { setMpStatus(serverHelp(err), 'bad'); });
    });
  }

  function joinRoom() {
    myName = ($('#mpName').value || '').trim() || 'Player';
    const typed = ($('#mpCode').value || '').trim().toUpperCase();
    $('#mpError').textContent = '';
    setMpStatus(typed ? 'Joining room ' + typed + '…' : 'Looking for an open game…', '');
    // Blank code → ask the lobby for any open room.
    const resolve = typed ? Promise.resolve({ code: typed }) : BQ.NetClient.lobby('join');
    resolve.then((res) => {
      if (!res || !res.code) { setMpStatus('No open rooms yet. Ask the host to create one first.', 'bad'); return; }
      connectTo(res.code)
        .then(() => net.send({ t: 'join', code: res.code, name: myName }))
        .catch((err) => { setMpStatus(serverHelp(err), 'bad'); });
    });
  }

  // Watch a live game as a spectator: no seat is taken and no hand is ever
  // revealed. Blank code watches the only live game.
  function watchRoom() {
    myName = ($('#mpName').value || '').trim() || 'Spectator';
    const typed = ($('#mpCode').value || '').trim().toUpperCase();
    $('#mpError').textContent = '';
    setMpStatus(typed ? 'Joining stream ' + typed + '…' : 'Looking for a live game…', '');
    const resolve = typed ? Promise.resolve({ code: typed }) : BQ.NetClient.lobby('spectate');
    resolve.then((res) => {
      if (!res || !res.code) { setMpStatus('No live game to watch yet. Ask the host to start one.', 'bad'); return; }
      connectTo(res.code)
        .then(() => net.send({ t: 'spectate', code: res.code, name: myName }))
        .catch((err) => { setMpStatus(serverHelp(err), 'bad'); });
    });
  }

  function renderLobby(state) {
    lastLobbyState = state;
    $('#lobbyCode').textContent = state.code;
    const seats = state.players.map((p) => {
      // Host gets a remove (✕) button on every seat but their own.
      const kick = (state.youAreHost && !p.you)
        ? '<button class="lobby-kick" data-kick="' + p.seat + '" title="Remove player" aria-label="Remove player">✕</button>'
        : '';
      return '<div class="lobby-seat' + (p.you ? ' you' : '') + '">' +
        '<span class="avatar">' + p.name.charAt(0).toUpperCase() + '</span>' +
        '<span class="lname">' + p.name + (p.seat === 0 ? ' 👑' : '') + (p.you ? ' (you)' : '') +
        (p.connected === false ? ' <span class="off-tag">⚠️ reconnecting…</span>' : '') + '</span>' +
        kick + '</div>';
    }).join('');
    const empties = Math.max(0, state.maxSeats - state.players.length);
    const botNote = empties > 0
      ? '<div class="lobby-seat bot">' + empties + ' empty seat' + (empties > 1 ? 's' : '') + ' → filled with bots</div>'
      : '';
    $('#lobbyPlayers').innerHTML = seats + botNote;
    $('#lobbyHint').textContent = state.youAreHost
      ? 'Share code ' + state.code + ' with players on your network, then press Start.'
      : 'Waiting for the host to start…';
    $('#btnLobbyStart').style.display = state.youAreHost ? '' : 'none';
  }

  // How many other humans the owner could place (drives whether to show the
  // arrange prompt at all).
  function otherHumanCount(state) {
    if (!state || !state.players) return 0;
    const ownerSeat = state.yourSeat != null ? state.yourSeat : 0;
    return state.players.filter((p) => !p.isBot && p.seat !== ownerSeat).length;
  }

  // ---- Seat arrangement: the owner gives each player a seat number ----------
  // Seat 1 is the owner; play proceeds Seat 1 → 2 → 3 → … around the table. Any
  // seat left unassigned fills with a bot, so this works with bots at the table.
  function buildSeatOrderForm(state) {
    const form = $('#seatOrderForm');
    form.innerHTML = '';
    const maxSeats = state.maxSeats;
    const ownerSeat = state.yourSeat != null ? state.yourSeat : 0;
    const owner = state.players.find((p) => p.seat === ownerSeat) || state.players[0];
    const others = state.players.filter((p) => p.seat !== ownerSeat && !p.isBot);

    // Seat 1 — the owner (fixed).
    const r1 = document.createElement('div');
    r1.className = 'seat-order-row owner';
    const n1 = document.createElement('span'); n1.className = 'so-num'; n1.textContent = '1';
    const name1 = document.createElement('span'); name1.className = 'so-name';
    name1.textContent = owner.name + ' 👑 (you)';
    r1.appendChild(n1); r1.appendChild(name1);
    form.appendChild(r1);

    // One row per other human: pick that player's seat number (2..maxSeats).
    // Picking a seat already taken by another player swaps the two.
    others.forEach((p, k) => {
      const row = document.createElement('div');
      row.className = 'seat-order-row';
      const label = document.createElement('span'); label.className = 'so-name'; label.textContent = p.name;
      const pick = document.createElement('span'); pick.className = 'so-pick';
      const tag = document.createElement('span'); tag.className = 'so-seatlabel'; tag.textContent = 'Seat';
      const sel = document.createElement('select');
      sel.className = 'so-select';
      sel.dataset.human = String(p.seat);   // this player's CURRENT seat index
      for (let idx = 1; idx < maxSeats; idx++) {   // indices 1..maxSeats-1 → "Seat 2".."Seat N"
        const opt = document.createElement('option');
        opt.value = String(idx); opt.textContent = 'Seat ' + (idx + 1);
        sel.appendChild(opt);
      }
      sel.value = String(k + 1);             // default = current join order
      sel.dataset.prev = sel.value;
      sel.addEventListener('change', () => {
        const selects = $$('#seatOrderForm .so-select');
        const prev = sel.dataset.prev, now = sel.value;
        const clash = selects.find((s) => s !== sel && s.value === now);
        if (clash) { clash.value = prev; clash.dataset.prev = prev; }  // swap → seats stay unique
        sel.dataset.prev = now;
      });
      pick.appendChild(tag); pick.appendChild(sel);
      row.appendChild(label); row.appendChild(pick);
      form.appendChild(row);
    });

    const botCount = maxSeats - 1 - others.length;
    if (botCount > 0) {
      const note = document.createElement('div');
      note.className = 'seat-order-note';
      note.textContent = botCount + ' remaining seat' + (botCount > 1 ? 's' : '') + ' will be filled with bots.';
      form.appendChild(note);
    }
  }

  // Read the chosen arrangement into a full-table layout and start with it.
  function confirmSeatOrder() {
    const state = lastLobbyState;
    if (!state) { if (net) net.send({ t: 'start' }); return; }
    const maxSeats = state.maxSeats;
    const ownerSeat = state.yourSeat != null ? state.yourSeat : 0;
    const layout = new Array(maxSeats).fill('bot');
    layout[0] = ownerSeat;                                   // seat 1 = owner
    let ok = true;
    $$('#seatOrderForm .so-select').forEach((s) => {
      const idx = Number(s.value);                           // chosen seat index
      const human = Number(s.dataset.human);                 // that player's current seat index
      if (idx < 1 || idx >= maxSeats || layout[idx] !== 'bot') ok = false;
      layout[idx] = human;
    });
    const placed = layout.filter((v) => v !== 'bot');
    if (!ok || new Set(placed).size !== placed.length || placed.length !== otherHumanCount(state) + 1) {
      ui.toast('Each player needs a different seat'); return;
    }
    ui.closeOverlay('seatOrderOverlay');
    if (net) net.send({ t: 'start', layout });
  }

  // Round-end controls. Single player: a plain "Next Round" button.
  // Multiplayer: EVERY player must press "I'm Ready"; the round advances only
  // when all connected humans have confirmed.
  function setupRoundControls() {
    const btn = $('#btnNextRound');
    const wait = $('#roundWait');
    if (!btn) return;
    // Final hand (game over): ui.onRoundEnd already set this button to
    // "See Final Results" — don't overwrite it with the next-round / ready label.
    if (btn.dataset.final === '1') return;
    // Spectator: no "ready" to give — the game advances on its own. Just watch.
    if (isSpectator) {
      btn.style.display = 'none';
      if (wait) { wait.style.display = ''; wait.textContent = '👁 Spectating — the next round starts automatically.'; }
      return;
    }
    btn.disabled = false;
    if (isMultiplayer) {
      btn.textContent = "I'm Ready ✓";
      wait.style.display = '';
      wait.textContent = 'All players must confirm to continue.';
    } else {
      btn.textContent = 'Next Round';
      wait.style.display = 'none';
    }
  }

  // Game-over: only the host can start a new game.
  function setupGameOverControls() {
    const b = $('#btnPlayAgain'), w = $('#gameOverWait');
    if (isSpectator) {
      if (b) b.style.display = 'none';
      if (w) { w.style.display = ''; w.textContent = '👁 You are spectating. Leave any time to return to the menu.'; }
      return;
    }
    const host = !isMultiplayer || isHost;
    if (b) b.style.display = host ? '' : 'none';
    if (w) w.style.display = host ? 'none' : '';
  }

  // Update the "who's ready" status shown in the round-summary overlay.
  function renderReady(m) {
    const wait = $('#roundWait');
    if (!wait) return;
    const ticks = m.humans.map((seat) =>
      m.names[seat] + (m.ready.indexOf(seat) >= 0 ? ' ✓' : ' …')
    ).join('   ·   ');
    wait.style.display = '';
    wait.innerHTML = '<b>' + m.ready.length + ' / ' + m.humans.length + ' ready</b> &nbsp; ' + ticks;
  }

  // Game-paused overlay (a player left). The host gets an "add a bot" shortcut
  // so a game can never get permanently stuck waiting for a player who never comes.
  function showPause(msg) {
    const el = $('#pauseMsg'); if (el) el.textContent = msg;
    const row = $('#pauseHostRow'); if (row) row.style.display = isHost ? '' : 'none';
    ui.openOverlay('pauseOverlay');
  }
  function hidePause() { ui.closeOverlay('pauseOverlay'); }

  function leaveMultiplayer() {
    if (BQ.Voice) BQ.Voice.leave();                     // hang up audio + close peers
    if (net) { net.send({ t: 'leave' }); }
    if (session) dropBackup(session.code);              // we walked out — not ours to restore
    clearSession();                                     // don't auto-resume after leaving on purpose
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    ui.setReconnecting(false);
    hidePause();
    ui.closeOverlay('vacancyOverlay');
    netEngine = null; isMultiplayer = false; isSpectator = false;
    document.body.classList.remove('mp', 'spectating');
    BQ.Sound.stopMusic();
    ui.show('menu');
    refreshUnfinished();
  }

  /* ---- Appearance editor (per-player; see js/prefs.js) ------------------- */
  function buildAppearanceForm() {
    const p = BQ.Prefs.get();
    $('#prefScale').value = p.cardScale;
    $('#prefScaleVal').textContent = Math.round(p.cardScale * 100) + '%';
    $('#prefTrickScale').value = p.trickScale;
    $('#prefTrickScaleVal').textContent = Math.round(p.trickScale * 100) + '%';
    $('#prefPreSelect').checked = !!p.preSelect;
    $('#prefHandScroll').checked = p.handScroll !== false;
    $('#prefFx').checked = p.fx !== false;
    $('#prefAttacks').checked = p.attacks !== false;

    const tables = $('#prefTables');
    tables.innerHTML = '';
    BQ.Prefs.TABLES.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch table-sw' + (p.table === t.id ? ' sel' : '');
      b.setAttribute('data-table', t.id);
      b.innerHTML = '<span class="sw-label">' + t.label + '</span>';
      b.addEventListener('click', () => { BQ.Sound.click(); BQ.Prefs.set({ table: t.id }); buildAppearanceForm(); });
      tables.appendChild(b);
    });

    const backs = $('#prefBacks');
    backs.innerHTML = '';
    BQ.Prefs.BACKS.forEach((bk) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch back-sw' + (p.cardBack === bk.id ? ' sel' : '');
      b.setAttribute('data-back', bk.id);
      b.title = bk.label;
      b.innerHTML = '<span class="card back mini-back"></span><span class="sw-label">' + bk.label + '</span>';
      b.addEventListener('click', () => { BQ.Sound.click(); BQ.Prefs.set({ cardBack: bk.id }); buildAppearanceForm(); });
      backs.appendChild(b);
    });

    const faces = $('#prefFaces');
    faces.innerHTML = '';
    BQ.Prefs.FACES.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch face-sw' + (p.cardFace === f.id ? ' sel' : '');
      b.textContent = f.label;
      b.addEventListener('click', () => {
        BQ.Sound.click();
        BQ.Prefs.set({ cardFace: f.id });
        ui.refreshCards();                 // repaint my hand with the new template
        if (treekyUI.engine) treekyUI.refreshCards();
        buildAppearanceForm();
      });
      faces.appendChild(b);
    });

    const mob = $('#prefMobile');
    mob.innerHTML = '';
    [['auto', 'Auto (detect)'], ['on', 'Always on'], ['off', 'Off']].forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch face-sw' + ((p.mobileMode || 'auto') === id ? ' sel' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        BQ.Sound.click();
        BQ.Prefs.set({ mobileMode: id });
        applyMobileMode();
        buildAppearanceForm();
      });
      mob.appendChild(b);
    });

    const music = $('#prefMusic');
    music.innerHTML = '';
    BQ.Sound.MUSIC_TRACKS.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch face-sw' + (p.music === m.id ? ' sel' : '');
      b.textContent = (m.id === 'off' ? '🔇 ' : '🎵 ') + m.label;
      b.addEventListener('click', () => {
        const patch = { music: m.id };
        if (m.id !== 'off') patch.musicPrev = m.id;   // 🎵 toggle restores this
        BQ.Prefs.set(patch);
        BQ.Sound.unlock();
        BQ.Sound.setMusicTrack(m.id);
        // instant preview — the loop picks the new style up next bar
        if (m.id !== 'off' && rules.soundEnabled) BQ.Sound.startMusic();
        updateMusicBtn();
        buildAppearanceForm();
      });
      music.appendChild(b);
    });
  }

  /* ---- music mute toggle (independent of the 🔊 all-sound switch) --------- */
  function updateMusicBtn() {
    const off = BQ.Prefs.get().music === 'off';
    [$('#btnMusic'), $('#tkBtnMusic')].forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle('muted', off);
      btn.title = off ? 'Music is off — click to turn on' : 'Mute music (sound effects stay on)';
    });
  }

  function toggleMusic() {
    const p = BQ.Prefs.get();
    if (p.music === 'off') {
      const restore = p.musicPrev || 'lounge';
      BQ.Prefs.set({ music: restore });
      BQ.Sound.unlock();
      BQ.Sound.setMusicTrack(restore);
      if (rules.soundEnabled) BQ.Sound.startMusic();
      ui.toast('🎵 Music on');
    } else {
      BQ.Prefs.set({ musicPrev: p.music, music: 'off' });
      BQ.Sound.setMusicTrack('off');
      ui.toast('Music muted — sound effects stay on');
    }
    updateMusicBtn();
  }

  /* ---- Mobile mode ---------------------------------------------------------
   * 'auto' turns it on for touch devices / narrow screens; 'on'/'off' force it.
   * Mobile mode = thumb-zone bottom bar (emotes · attacks · menu), collapsed
   * toolbar, bottom-sheet modals, bigger touch targets (all CSS via body.mobile).
   */
  function mobileAuto() {
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    return (coarse && Math.min(innerWidth, innerHeight) < 860) || innerWidth < 700;
  }

  function applyMobileMode() {
    const mode = BQ.Prefs.get().mobileMode || 'auto';
    const on = mode === 'on' || (mode === 'auto' && mobileAuto());
    document.body.classList.toggle('mobile', on);
    // the attack dock lives in the bottom bar on mobile, floats on desktop
    const dock = $('#attackDock');
    const home = on ? $('#mbarAttacks') : $('#game');
    if (dock && home && dock.parentElement !== home) home.appendChild(dock);
  }

  /* ---- hand zoom (+ / −) and screen rotation ------------------------------ */
  function nudgeCardScale(delta) {
    const v = Math.round(Math.max(0.7, Math.min(2, BQ.Prefs.get().cardScale + delta)) * 100) / 100;
    BQ.Prefs.set({ cardScale: v });
    ui.layoutHumanHand();
    ui.toast('Cards ' + Math.round(v * 100) + '%');
  }

  // Lock the screen the other way round (needs fullscreen on most browsers).
  // Tapping again flips back; where the API isn't available we say so.
  async function toggleRotate() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      const portrait = (screen.orientation && screen.orientation.type || 'portrait').indexOf('portrait') === 0;
      await screen.orientation.lock(portrait ? 'landscape' : 'portrait');
      ui.toast(portrait ? 'Landscape — tap ⟳ to go back' : 'Portrait — tap ⟳ to go back');
    } catch (_) {
      ui.toast('Rotation not supported in this browser — turn your device instead');
    }
  }

  /* ---- Emotes & quick messages (multiplayer) ------------------------------ */
  const EMOTE_EMOJIS = ['😀', '😂', '😎', '🤔', '😭', '😡', '👏', '🔥', '💀', '👍', '🍀', '♛'];
  const EMOTE_MSGS = ['Nice play!', 'Hurry up ⏳', 'Good game!', 'Ouch!', 'Lucky!', 'Oh no…', 'Sorry!', 'Take the Queen 😈'];

  // Attack-taunt budget: one per move. Spent on send; the server refunds it
  // when you play your next card (mirrored here for instant button state).
  let attackCredit = true;

  function updateAttackBtns() {
    document.querySelectorAll('.attack-btn').forEach((b) => { b.disabled = !attackCredit; });
  }

  // Voice chat controls: 🎤 joins/leaves the WebRTC audio mesh; 🎙️ (shown only
  // while in the call) mutes the mic. State pushed back from BQ.Voice keeps the
  // button glyphs/colors in sync with the actual call/mute state.
  function setupVoice() {
    if (!BQ.Voice) return;
    // Two button pairs render the same state: desktop toolbar + mobile thumb-bar
    // (the desktop toolbar's .right is hidden in mobile mode, so mobile needs
    // its own controls). Each pair = a join/leave button + a mute button.
    const voiceBtns = ['#btnVoice', '#btnMobileVoice'].map($).filter(Boolean);
    const micBtns = ['#btnMic', '#btnMobileMic'].map($).filter(Boolean);
    if (!voiceBtns.length) return;

    BQ.Voice.onError = (msg) => { ui.toast(msg); BQ.Sound.error(); };
    BQ.Voice.onMember = (info) => ui.setVoiceMember(info);
    BQ.Voice.onState = (st) => {
      voiceBtns.forEach((b) => {
        b.classList.toggle('in-call', st.inCall);
        b.textContent = st.inCall ? '📞' : '🎤';
        b.title = st.inCall ? 'Leave voice chat' : 'Join voice chat';
      });
      micBtns.forEach((b) => {
        b.style.display = st.inCall ? '' : 'none';
        b.classList.toggle('muted', st.muted);
        b.textContent = st.muted ? '🔇' : '🎙️';
        b.title = st.muted ? 'Unmute mic' : 'Mute mic';
      });
      if (!st.inCall) ui.clearVoice();
    };

    voiceBtns.forEach((b) => b.addEventListener('click', () => { BQ.Sound.click(); BQ.Voice.toggle(); }));
    micBtns.forEach((b) => b.addEventListener('click', () => { BQ.Sound.click(); BQ.Voice.toggleMute(); }));
  }

  function setupAttackRow() {
    const row = $('#attackDock');
    BQ.FX.ATTACKS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'attack-btn';
      b.innerHTML = '<span></span><small></small>';
      b.querySelector('span').textContent = a.emoji;
      b.querySelector('small').textContent = a.label;
      b.title = 'Send a ' + a.label + ' at the whole table (1 per move)';
      b.addEventListener('click', () => {
        if (!attackCredit) { ui.toast('Recharges when you play a card'); return; }
        attackCredit = false;
        updateAttackBtns();
        if (isMultiplayer && net && net.connected) {
          net.send({ t: 'attack', kind: a.id });   // others still see it even if you muted your own screen
        } else if (BQ.Prefs.get().attacks === false) {
          ui.toast('Attack taunts are muted (🎨 Appearance)');
        } else {
          BQ.FX.attack(a.id, localName(), ui.seatAnchor(0));   // my own seat (south)
          BQ.Sound.attack(a.id);
        }
        $('#emotePanel').classList.remove('show');
      });
      row.appendChild(b);
    });
    updateAttackBtns();
  }

  // In multiplayer the server relays to every table; in single player the
  // bubble/float simply shows at your own seat (and attacks play locally).
  function localName() {
    return (engine && engine.players && engine.players[0]) ? engine.players[0].name : (myName || 'You');
  }

  function sendEmote(type, text) {
    if (isMultiplayer && net && net.connected) {
      net.send(type === 'emote' ? { t: 'emote', emoji: text } : { t: 'chat', text });
    } else {
      ui.showEmote(0, text, localName(), type === 'emote');
    }
  }

  /* ---- Card-smash style picker (emote panel) -------------------------------
   * Each style has its own shortcut: HOLD the key shown on its chip while
   * clicking a card to slam with that style. Click a chip to rebind the key.
   * ⌘/Ctrl-click and long-press use the selected (highlighted) style. The
   * 🗣️ chip toggles the voice shout on impact. */
  function setupSmashRow() {
    const row = $('#smashRow');
    if (!row) return;
    const rebuild = () => {
      row.innerHTML = '';
      const lab = document.createElement('small');
      lab.className = 'smash-lab';
      lab.textContent = 'Smash — hold key + click card';
      row.appendChild(lab);
      BQ.FX.SMASHES.forEach((s) => {
        const key = (BQ.Prefs.get().smashKeys || {})[s.id] || '';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'smash-btn keyed' + (BQ.Prefs.get().smash === s.id ? ' sel' : '');
        b.innerHTML = '<span></span><kbd></kbd>';
        b.querySelector('span').textContent = s.emoji;
        b.querySelector('kbd').textContent = key ? key.toUpperCase() : '·';
        b.title = s.label + ' smash — hold ' + (key ? '“' + key.toUpperCase() + '”' : 'its key') +
                  ' while clicking a card. Click the key chip to rebind.';
        b.addEventListener('click', () => {
          BQ.Prefs.set({ smash: s.id });
          BQ.Sound.smash(s.id);   // instant preview: impact sound + shout
          rebuild();
        });
        // the key chip rebinds instead of selecting
        b.querySelector('kbd').addEventListener('click', (ev) => {
          ev.stopPropagation();
          b.querySelector('kbd').textContent = '…';
          b.classList.add('binding');
          const capture = (kev) => {
            kev.preventDefault();
            kev.stopPropagation();
            window.removeEventListener('keydown', capture, true);
            const k = kev.key.toLowerCase();
            if (k === 'escape') { rebuild(); return; }
            if (k.length !== 1) { ui.toast('Press a single letter or number key'); rebuild(); return; }
            const keys = Object.assign({}, BQ.Prefs.get().smashKeys);
            // a key belongs to one style: stealing it unbinds the old owner
            Object.keys(keys).forEach((st) => { if (keys[st] === k) delete keys[st]; });
            keys[s.id] = k;
            BQ.Prefs.set({ smashKeys: keys });
            ui.toast(s.label + ' smash → hold “' + k.toUpperCase() + '” + click a card');
            rebuild();
          };
          window.addEventListener('keydown', capture, true);
        });
        row.appendChild(b);
      });
      const v = document.createElement('button');
      v.type = 'button';
      v.className = 'smash-btn voice' + (BQ.Prefs.get().smashVoice === false ? '' : ' sel');
      v.textContent = '🗣️';
      v.title = 'Voice shout on smash (Kaboom!, Freeze!…)';
      v.addEventListener('click', () => {
        const on = BQ.Prefs.get().smashVoice === false;   // toggling back on
        BQ.Prefs.set({ smashVoice: on });
        BQ.Sound.click();
        if (on) BQ.Sound.shout(BQ.Prefs.get().smash);
        rebuild();
      });
      row.appendChild(v);
    };
    rebuild();
  }

  function setupEmotePanel() {
    const emojis = $('#emoteEmojis');
    EMOTE_EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emote-btn';
      b.textContent = e;
      b.addEventListener('click', () => sendEmote('emote', e));
      emojis.appendChild(b);
    });
    const msgs = $('#emoteMsgs');
    EMOTE_MSGS.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emote-msg';
      b.textContent = m;
      b.addEventListener('click', () => {
        sendEmote('chat', m);
        $('#emotePanel').classList.remove('show');
      });
      msgs.appendChild(b);
    });
    const sendCustom = () => {
      const text = ($('#emoteInput').value || '').trim();
      if (!text) return;
      sendEmote('chat', text);
      $('#emoteInput').value = '';
      $('#emotePanel').classList.remove('show');
    };
    $('#btnEmoteSend').addEventListener('click', sendCustom);
    $('#emoteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCustom(); });
  }

  /* ---- Event wiring ----------------------------------------------------- */
  function wire() {
    // Menu — game picker (Black Queen / Treeky)
    function selectGame(g) {
      selectedGame = (g === 'treeky' || g === 'bluff') ? g : 'blackqueen';
      const bq = $('#pickBlackQueen'), tk = $('#pickTreeky'), bl = $('#pickBluff'), sub = $('#menuSubtitle');
      if (bq) bq.classList.toggle('active', selectedGame === 'blackqueen');
      if (tk) tk.classList.toggle('active', selectedGame === 'treeky');
      if (bl) bl.classList.toggle('active', selectedGame === 'bluff');
      if (sub) sub.textContent = selectedGame === 'treeky'
        ? 'Shed your hand — 3s attack, Jacks are wild'
        : selectedGame === 'bluff'
        ? 'Lie boldly — claim any rank, call the cheats'
        : 'A Game of Hearts & Nerve';
    }
    $('#pickBlackQueen') && $('#pickBlackQueen').addEventListener('click', () => { BQ.Sound.click(); selectGame('blackqueen'); });
    $('#pickTreeky') && $('#pickTreeky').addEventListener('click', () => { BQ.Sound.click(); selectGame('treeky'); });
    $('#pickBluff') && $('#pickBluff').addEventListener('click', () => { BQ.Sound.click(); selectGame('bluff'); });

    // Menu
    $('#btnPlay').addEventListener('click', () => { BQ.Sound.unlock(); BQ.Sound.click(); ui.show('setup'); $('#playerName').focus(); });
    $('#btnMulti').addEventListener('click', () => { BQ.Sound.unlock(); BQ.Sound.click(); openMultiplayer(); });
    // Unfinished games panel: rejoin / restore / forget, plus manual refresh.
    $('#unfinishedList').addEventListener('click', (e) => {
      const rejoin = e.target.closest('[data-rejoin]');
      if (rejoin) { BQ.Sound.unlock(); BQ.Sound.click(); rejoinRoom(rejoin.dataset.rejoin); return; }
      const forget = e.target.closest('[data-forget]');
      if (forget) { BQ.Sound.click(); dropBackup(forget.dataset.forget); renderUnfinished(); }
    });
    $('#btnUnfinishedRefresh').addEventListener('click', () => { BQ.Sound.click(); refreshUnfinished(); });
    // Coming back to the menu tab: the list may have changed (a game we left on
    // the phone ended, the host restored a room…).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && $('#menu') && $('#menu').classList.contains('active')) refreshUnfinished();
    });
    $('#btnRules').addEventListener('click', () => { BQ.Sound.click(); $('#rulesModal').innerHTML = rulesHtml(); ui.openOverlay('rulesOverlay'); });
    $('#btnSettingsMenu').addEventListener('click', () => { BQ.Sound.click(); openMainSettings(); });
    $('#btnLookMenu').addEventListener('click', () => { BQ.Sound.click(); buildAppearanceForm(); ui.openOverlay('lookOverlay'); });

    // Multiplayer screens
    $('#btnCreate').addEventListener('click', () => { BQ.Sound.click(); createRoom(); });
    $('#btnJoin').addEventListener('click', () => { BQ.Sound.click(); joinRoom(); });
    $('#btnWatch').addEventListener('click', () => { BQ.Sound.click(); watchRoom(); });
    $('#btnMpBack').addEventListener('click', () => { BQ.Sound.click(); ui.show('menu'); });
    $('#btnLobbyStart').addEventListener('click', () => {
      BQ.Sound.click();
      // Treeky / Bluff seats are symmetric (no dealing-order arrangement) — just start.
      if (selectedGame === 'treeky' || selectedGame === 'bluff') { if (net) net.send({ t: 'start' }); return; }
      const st = lastLobbyState;
      // Offer seat arrangement whenever there's at least one other player to
      // place and a real choice of seats (3+ at the table, bots included).
      // Otherwise there's nothing to arrange, so just start.
      if (st && st.maxSeats >= 3 && otherHumanCount(st) >= 1) {
        buildSeatOrderForm(st);
        ui.openOverlay('seatOrderOverlay');
      } else if (net) {
        net.send({ t: 'start' });
      }
    });
    $('#btnSeatOrderStart').addEventListener('click', () => { BQ.Sound.click(); confirmSeatOrder(); });
    $('#btnSeatOrderCancel').addEventListener('click', () => { BQ.Sound.click(); ui.closeOverlay('seatOrderOverlay'); });
    $('#btnLobbyLeave').addEventListener('click', () => { BQ.Sound.click(); leaveMultiplayer(); });
    // Host: remove a player (event-delegated — the seat list is re-rendered).
    $('#lobbyPlayers').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kick]');
      if (!btn) return;
      const seat = parseInt(btn.dataset.kick, 10);
      if (!Number.isInteger(seat)) return;
      BQ.Sound.click();
      if (net) net.send({ t: 'kick', seat });
    });

    // Host vacancy prompt (a player left mid-game)
    $('#btnAddBot').addEventListener('click', () => {
      BQ.Sound.click();
      if (net) net.send({ t: 'resolveVacancy', choice: 'bot' });
      ui.closeOverlay('vacancyOverlay');
    });
    $('#btnOpenSeat').addEventListener('click', () => {
      BQ.Sound.click();
      if (net) net.send({ t: 'resolveVacancy', choice: 'open' });
      ui.closeOverlay('vacancyOverlay');   // pause overlay (waiting for a player) shows next
    });
    $('#btnPauseAddBot').addEventListener('click', () => {
      BQ.Sound.click();
      if (net) net.send({ t: 'resolveVacancy', choice: 'bot' });
    });
    // Trailing player's pre-round re-deal. Hide the actions immediately so a
    // double-tap can't fire twice; the server's next deal/turn redraws the state.
    $('#btnReshuffleDeal') && $('#btnReshuffleDeal').addEventListener('click', () => {
      BQ.Sound.click();
      if (netEngine && netEngine.reshuffleDeal) {
        netEngine.reshuffleDeal();
        const a = $('#reshuffleActions'); if (a) a.style.display = 'none';
      }
    });
    $('#btnReshuffleStart') && $('#btnReshuffleStart').addEventListener('click', () => {
      BQ.Sound.click();
      if (netEngine && netEngine.reshuffleStart) {
        netEngine.reshuffleStart();
        const a = $('#reshuffleActions'); if (a) a.style.display = 'none';
      }
    });
    $('#mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

    // Setup
    $('#btnBackMenu').addEventListener('click', () => { BQ.Sound.click(); ui.show('menu'); });
    $('#btnStart').addEventListener('click', startFromSetup);
    $('#playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromSetup(); });

    function startFromSetup() {
      const name = ($('#playerName').value || '').trim() || 'You';
      BQ.Sound.click();
      if (selectedGame === 'treeky') newTreekyGame(name);
      else if (selectedGame === 'bluff') newBluffGame(name);
      else newGame(name);
    }

    // Treeky toolbar + results overlay
    $('#tkQuit') && $('#tkQuit').addEventListener('click', () => {
      if (!confirm('Quit to main menu? Current game will be lost.')) return;
      closeTreekyOverlays();
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic(); engine = null;
      treekyUI.show('menu');
    });
    $('#tkBtnSound') && $('#tkBtnSound').addEventListener('click', () => {
      rules.soundEnabled = !rules.soundEnabled;
      BQ.Sound.setEnabled(rules.soundEnabled);
      saveRules(rules);
      const t = rules.soundEnabled ? '🔊' : '🔇';
      $('#tkBtnSound').textContent = t; $('#btnSound').textContent = t;
      if (rules.soundEnabled) { BQ.Sound.startMusic(); BQ.Sound.click(); }
    });
    $('#tkOverAgain') && $('#tkOverAgain').addEventListener('click', () => {
      BQ.Sound.click();
      closeTreekyOverlays();
      if (isMultiplayer) { if (net) net.send({ t: 'again' }); }
      else if (engine && engine.players[0]) newTreekyGame(engine.players[0].name);
    });
    $('#tkOverLeave') && $('#tkOverLeave').addEventListener('click', () => {
      BQ.Sound.click();
      closeTreekyOverlays();
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic(); engine = null;
      treekyUI.show('menu');
    });

    // Treeky toolbar — appearance / music / standings / settings (sound & quit are above)
    $('#tkBtnLook') && $('#tkBtnLook').addEventListener('click', () => {
      BQ.Sound.click(); buildAppearanceForm(); ui.openOverlay('lookOverlay');
    });
    $('#tkBtnMusic') && $('#tkBtnMusic').addEventListener('click', () => { BQ.Sound.click(); toggleMusic(); });
    $('#tkBtnStandings') && $('#tkBtnStandings').addEventListener('click', () => {
      BQ.Sound.click(); treekyUI.renderStandings(); ui.openOverlay('tkStandingsOverlay');
    });
    $('#tkStandingsClose') && $('#tkStandingsClose').addEventListener('click', () => { BQ.Sound.click(); ui.closeOverlay('tkStandingsOverlay'); });
    $('#tkBtnSettings') && $('#tkBtnSettings').addEventListener('click', () => {
      BQ.Sound.click(); buildTreekySettingsForm(); ui.openOverlay('tkSettingsOverlay');
    });
    $('#tkSettingsClose') && $('#tkSettingsClose').addEventListener('click', () => { BQ.Sound.click(); ui.closeOverlay('tkSettingsOverlay'); });
    $('#tkSettingsSave') && $('#tkSettingsSave').addEventListener('click', () => {
      BQ.Sound.click(); saveTreekySettingsForm(); ui.closeOverlay('tkSettingsOverlay');
      ui.toast('Saved — applies to your next game');
    });
    setupTreekyAttackRow();

    // Bluff toolbar + results overlay
    $('#blQuit') && $('#blQuit').addEventListener('click', () => {
      if (!confirm('Quit to main menu? Current game will be lost.')) return;
      closeBluffOverlays();
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic(); engine = null;
      bluffUI.show('menu');
    });
    $('#blBtnSound') && $('#blBtnSound').addEventListener('click', () => {
      rules.soundEnabled = !rules.soundEnabled;
      BQ.Sound.setEnabled(rules.soundEnabled);
      saveRules(rules);
      const t = rules.soundEnabled ? '🔊' : '🔇';
      $('#blBtnSound').textContent = t; $('#btnSound').textContent = t;
      if (rules.soundEnabled) { BQ.Sound.startMusic(); BQ.Sound.click(); }
    });
    $('#blBtnLook') && $('#blBtnLook').addEventListener('click', () => {
      BQ.Sound.click(); buildAppearanceForm(); ui.openOverlay('lookOverlay');
    });
    $('#blBtnMusic') && $('#blBtnMusic').addEventListener('click', () => { BQ.Sound.click(); toggleMusic(); });
    $('#blBtnStandings') && $('#blBtnStandings').addEventListener('click', () => {
      BQ.Sound.click(); bluffUI.renderStandings(); ui.openOverlay('blStandingsOverlay');
    });
    $('#blStandingsClose') && $('#blStandingsClose').addEventListener('click', () => { BQ.Sound.click(); ui.closeOverlay('blStandingsOverlay'); });
    $('#blBtnSettings') && $('#blBtnSettings').addEventListener('click', () => {
      BQ.Sound.click(); buildBluffSettingsForm(); ui.openOverlay('blSettingsOverlay');
    });
    $('#blSettingsClose') && $('#blSettingsClose').addEventListener('click', () => { BQ.Sound.click(); ui.closeOverlay('blSettingsOverlay'); });
    $('#blSettingsSave') && $('#blSettingsSave').addEventListener('click', () => {
      BQ.Sound.click(); saveBluffSettingsForm(); ui.closeOverlay('blSettingsOverlay');
      ui.toast('Saved — applies to your next game');
    });
    $('#blOverAgain') && $('#blOverAgain').addEventListener('click', () => {
      BQ.Sound.click();
      closeBluffOverlays();
      if (isMultiplayer) { if (net) net.send({ t: 'again' }); }
      else if (engine && engine.players[0]) newBluffGame(engine.players[0].name);
    });
    $('#blOverLeave') && $('#blOverLeave').addEventListener('click', () => {
      BQ.Sound.click();
      closeBluffOverlays();
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic(); engine = null;
      bluffUI.show('menu');
    });

    // In-game toolbar
    $('#btnScores').addEventListener('click', () => { BQ.Sound.click(); ui.renderScoreboard(); ui.openOverlay('scoreOverlay'); });
    $('#btnLook').addEventListener('click', () => { BQ.Sound.click(); buildAppearanceForm(); ui.openOverlay('lookOverlay'); });
    $('#btnLookReset').addEventListener('click', () => {
      BQ.Sound.click();
      BQ.Prefs.reset();
      BQ.Sound.setMusicTrack(BQ.Prefs.get().music);
      buildAppearanceForm();
      ui.refreshCards();
      ui.toast('Appearance reset');
    });
    $('#prefScale').addEventListener('input', () => {
      const v = parseFloat($('#prefScale').value) || 1;
      BQ.Prefs.set({ cardScale: v });
      $('#prefScaleVal').textContent = Math.round(v * 100) + '%';
      ui.layoutHumanHand();
    });
    $('#prefTrickScale').addEventListener('input', () => {
      const v = parseFloat($('#prefTrickScale').value) || 1;
      BQ.Prefs.set({ trickScale: v });
      $('#prefTrickScaleVal').textContent = Math.round(v * 100) + '%';
    });
    $('#prefPreSelect').addEventListener('change', (e) => {
      BQ.Prefs.set({ preSelect: e.target.checked });
      ui.toast(e.target.checked ? 'Pre-select on — tap a card before your turn' : 'Pre-select off');
    });
    $('#prefHandScroll').addEventListener('change', (e) => {
      BQ.Prefs.set({ handScroll: e.target.checked });
      ui.layoutHumanHand();
    });
    $('#zoomIn').addEventListener('click', () => { BQ.Sound.click(); nudgeCardScale(+0.15); });
    $('#zoomOut').addEventListener('click', () => { BQ.Sound.click(); nudgeCardScale(-0.15); });
    $('#btnRotate').addEventListener('click', () => { BQ.Sound.click(); toggleRotate(); });
    $('#prefFx').addEventListener('change', (e) => {
      BQ.Prefs.set({ fx: e.target.checked });
      if (e.target.checked) { BQ.FX.floatEmoji('🎉', 4); BQ.Sound.pop(); }
    });
    $('#prefAttacks').addEventListener('change', (e) => {
      BQ.Prefs.set({ attacks: e.target.checked });
      ui.toast(e.target.checked ? 'Attack taunts on' : 'Attack taunts muted on your screen');
      // let everyone at the table see the 🛡️ state
      if (net && net.connected) net.send({ t: 'prefs', attacksMuted: !e.target.checked });
    });
    $('#btnEmote').addEventListener('click', () => {
      BQ.Sound.click();
      $('#emotePanel').classList.toggle('show');
    });
    setupSmashRow();
    setupEmotePanel();
    setupAttackRow();
    setupVoice();

    // Mobile bottom bar + menu sheet
    $('#btnMobileEmote').addEventListener('click', () => {
      BQ.Sound.click();
      $('#emotePanel').classList.toggle('show');
    });
    $('#btnMobileMenu').addEventListener('click', () => {
      BQ.Sound.click();
      ui.openOverlay('mobileMenuOverlay');
    });
    // menu sheet buttons proxy the (hidden) toolbar buttons
    document.querySelectorAll('#mobileMenuOverlay [data-proxy]').forEach((b) => {
      b.addEventListener('click', () => {
        ui.closeOverlay('mobileMenuOverlay');
        const target = $('#' + b.dataset.proxy);
        if (target) target.click();
      });
    });
    applyMobileMode();
    window.addEventListener('resize', applyMobileMode);
    $('#btnSettings').addEventListener('click', () => { BQ.Sound.click(); openMainSettings(); });
    $('#btnMusic').addEventListener('click', () => { BQ.Sound.click(); toggleMusic(); });
    $('#btnSound').addEventListener('click', () => {
      rules.soundEnabled = !rules.soundEnabled;
      BQ.Sound.setEnabled(rules.soundEnabled);
      saveRules(rules);
      $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
      if (rules.soundEnabled) { BQ.Sound.startMusic(); BQ.Sound.click(); }
    });
    $('#btnQuit').addEventListener('click', () => {
      if (!confirm('Quit to main menu? Current game will be lost.')) return;
      if (isMultiplayer) { leaveMultiplayer(); return; }
      clearSPGame();
      BQ.Sound.stopMusic();
      ui.show('menu');
    });

    // Round overlay — single player advances immediately; multiplayer waits
    // for ALL players to confirm "ready".
    $('#btnNextRound').addEventListener('click', () => {
      BQ.Sound.click();
      const btn = $('#btnNextRound');
      // Final hand (game over): the round overlay is showing the deciding round's
      // scorecard — its button reveals the results podium, not a new round.
      if (btn.dataset.final === '1') {
        ui.showGameOver();
        return;
      }
      if (isMultiplayer) {
        net.send({ t: 'ready' });
        btn.disabled = true;
        btn.textContent = 'Waiting for others…';
      } else {
        ui.closeOverlay('roundOverlay');
        engine.startRound();
      }
    });

    // Reveal zoom: make the end-of-round won-tricks cards bigger / smaller.
    // Persisted per player; the CSS var updates every reveal card live.
    const REVEAL_MIN = 0.7, REVEAL_MAX = 2.2, REVEAL_STEP = 0.15;
    function updateRevealZoom() {
      const s = BQ.Prefs.get().revealScale || 1;
      const sm = $('#btnRevealSmaller'), bg = $('#btnRevealBigger');
      if (sm) sm.disabled = s <= REVEAL_MIN + 0.001;
      if (bg) bg.disabled = s >= REVEAL_MAX - 0.001;
    }
    function bumpReveal(dir) {
      const cur = BQ.Prefs.get().revealScale || 1;
      const next = Math.min(REVEAL_MAX, Math.max(REVEAL_MIN, Math.round((cur + dir * REVEAL_STEP) * 100) / 100));
      BQ.Prefs.set({ revealScale: next });
      updateRevealZoom();
    }
    $('#btnRevealSmaller').addEventListener('click', () => { BQ.Sound.click(); bumpReveal(-1); });
    $('#btnRevealBigger').addEventListener('click', () => { BQ.Sound.click(); bumpReveal(1); });
    updateRevealZoom();

    // Settings overlay — tabs (Black Queen / Treeky)
    document.querySelectorAll('#settingsTabs .settings-tab').forEach((b) =>
      b.addEventListener('click', () => { BQ.Sound.click(); setSettingsTab(b.getAttribute('data-tab')); }));
    $('#btnSaveRules').addEventListener('click', () => {
      readSettingsForm();                              // Black Queen rules
      saveTreekySettingsForm('#settingsTreekyForm');   // Treeky options
      BQ.Sound.click();
      ui.closeOverlay('settingsOverlay');
      if (net && net.connected && isHost) net.send({ t: 'rules', rules }); // host syncs room rules (pre-start)
      ui.toast('Settings saved');
      $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
    });
    $('#btnResetRules').addEventListener('click', () => {
      BQ.Sound.click();
      if (settingsTab === 'treeky') {
        treekyRules = BQ.cloneTreekyRules();
        saveTreekyRules(treekyRules);
        buildTreekySettingsForm('#settingsTreekyForm');
        ui.toast('Treeky defaults restored');
      } else {
        rules = BQ.cloneRules();
        saveRules(rules);
        buildSettingsForm();
        if (engine && engine.rules && engine.rules.gameName !== 'Treeky') engine.rules = rules;
        ui.toast('Black Queen defaults restored');
      }
    });

    // Game over
    $('#btnPlayAgain').addEventListener('click', () => {
      BQ.Sound.click();
      ui.closeOverlay('gameOverOverlay');
      if (isMultiplayer) net.send({ t: 'again' });
      else newGame(engine.players[0].name);
    });
    $('#btnGoMenu').addEventListener('click', () => {
      BQ.Sound.click();
      ui.closeOverlay('gameOverOverlay');
      if (isMultiplayer) { leaveMultiplayer(); return; }
      clearSPGame();
      BQ.Sound.stopMusic();
      ui.show('menu');
    });

    // initial sound icon state
    $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
    if ($('#tkBtnSound')) $('#tkBtnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
    BQ.Sound.setEnabled(rules.soundEnabled);

    // apply saved appearance (card scale / felt / backs / face template / music)
    BQ.Prefs.apply();
    BQ.Sound.setMusicTrack(BQ.Prefs.get().music);
    BQ.Sound.applyVolumes(BQ.Prefs.get().volumes);
    updateMusicBtn();

    // PWA: installable app + offline shell (single player works offline).
    // Service workers need a secure context (https or localhost) — on plain
    // LAN http this quietly does nothing.
    if ('serviceWorker' in navigator &&
        (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Accounts: login is REQUIRED. Gate the app behind auth — BQ.Account.boot()
    // shows the login screen, or (if a session exists) calls onReady, where we
    // set the player name, reveal the menu, and resume any in-progress game.
    BQ.Account.init({
      ui,
      onReady: (user) => {
        myName = user.displayName || user.username;
        const mp = $('#mpName'); if (mp) mp.value = myName;
        const pn = $('#playerName'); if (pn) pn.value = myName;
        ui.show('menu');
        attemptResume();
        // Seats held for this account elsewhere, or rooms this device can
        // restore from a backup: list them under "Unfinished games".
        refreshUnfinished();
      },
    });
    BQ.Account.boot();
  }

  document.addEventListener('DOMContentLoaded', wire);
})(window);
