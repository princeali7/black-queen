# ♛ Black Queen

A polished, fully-playable Black Queen card game (a Hearts-style trick-taking
game) with a clean, **rule-driven engine** designed to be modified later.

**Two games in one.** A toggle on the menu picks the game; everything else
(single-player, LAN/online multiplayer, spectating, bots) works for both:

- **♛ Black Queen** — the classic Hearts-style trick-taker.
- **🎴 Treeky** — a fast *shedding* game (Crazy-Eights / "Switch" family).

### 🎴 Treeky — how it plays

Empty your hand first. The first to finish is ranked 1st and then **spectates**
while the rest keep playing; the game ends when only one player still holds cards
and the **finish order** is shown. Single-player is you + 3 bots; online supports
**3–10 players** (empty seats fill with bots up to 4).

- Played with **two full decks** (every card appears twice). Each player is dealt **10 cards**; one card is flipped to start the pile (re-flipped if it's a 3 or a Jack).
- The player **after the dealer** goes first.
- Play a card that matches the pile's **suit** or **number**. A **Jack** is always playable and lets you **choose the next suit**.
- No legal card? **Draw one** — play it if it fits, otherwise your turn ends.
- A **3** makes the next player **draw 3** — but they can stack their own 3 to pass it on (+3 each time).
- Down to one card? Tap **🔔 Last Card!** as you play your second-to-last card. Forget, and you draw a penalty card on your next turn.

## Run it

**Single player** — just open `index.html` in any modern browser. Works offline,
no build step, no dependencies, no audio files (sound is synthesized live).

```
open index.html          # macOS
```

If your browser blocks audio/JS from `file://`, serve it: `python3 -m http.server 8765`.

**Multiplayer (recommended) — PartyKit / Cloudflare.** The multiplayer server
now also runs on Cloudflare's edge (Durable Objects) so it can be hosted for
free with no VM. Local dev mirrors production:

```
npm install              # one-time: pulls the partykit dev tool
npm run dev              # serves the game + multiplayer on http://localhost:1999
```

Everyone on your Wi-Fi opens `http://<your-LAN-ip>:1999`. The classic
zero-dependency `node server.js` (below) still works for pure-LAN play, but
PartyKit is the path that also deploys to the cloud — see *Hosting it online*.

**Multiplayer on your LAN (legacy, zero-dependency)** — the original Node server:

```
node server.js            # default port 4003  (node server.js 8080 to change)
```

It prints a URL like `http://192.168.0.166:4003`. Everyone on the same
Wi-Fi/network opens that URL in a browser, picks **Multiplayer (LAN)**, and:

1. One player taps **Create Room** → gets a 4-letter code (e.g. `BWNB`).
2. Others tap **Join Room** and enter the code — or **leave the box blank** to
   join the only open game automatically. (Codes never contain `0`, `1`, `I`, or
   `O`. If you mistype, the error lists the valid open-room codes.)
3. The host presses **Start**. Empty seats are filled with bots.

Between rounds, **every player must press "I'm Ready"** — the next round only
begins once all connected humans have confirmed (the summary shows who's ready).
AI seats are clearly tagged **BOT**, your own seat is tagged **YOU**, and the
player whose turn it is glows/pulses (including bots).

The server runs the authoritative game; if someone disconnects, their seat
becomes a bot so the game never stalls. The host advances rounds and can edit
rules (Settings) before starting. Requires Node.js (v14+); no `npm install`.

### Connection health (built in)

Both sides heartbeat: the server pings every WebSocket every 25 s (and replies
to pings per RFC 6455), the client pings the server every 20 s. This keeps
cloud proxies (ngrok, Render, Cloudflare…) from killing "idle" sockets, measures
your latency (shown as a 🟢 pill in the toolbar), and detects half-open
connections within seconds instead of minutes. `setNoDelay` is enabled, so
moves aren't batched by Nagle's algorithm. A dropped player's seat shows
**⚠️ OFFLINE** on every table, a bot covers it, and the player auto-reconnects
into the exact same seat (their session token is kept for 90 s).

### Hosting it online (play across the internet)

**Recommended — Cloudflare / PartyKit (free, no VM).** The static game **and**
the multiplayer server deploy together to Cloudflare's edge:

```
npx partykit deploy       # first run opens a browser to log in (free account)
```

It prints a URL like `https://black-queen.<you>.partykit.dev` — share it. Free
tier is generous (a card game is tiny) and there is nothing to keep "always on".

How it maps (see `party/`):
- **`party/main.js`** — one Durable Object **per room** (the room code is the URL
  id), running the authoritative engine. Replaces the old single-process
  `rooms`/`clients` Maps; bots and grace timers use `setTimeout` while the room
  is warm (≥1 player connected).
- **`party/lobby.js`** — one shared registry that allocates unused room codes and
  answers blank-code *join* / *watch the only live game*.
- **`partykit.json`** — serves the repo as static assets and routes `/parties/…`.
- **Persistence / rejoin.** The full room state is written to Durable Object
  storage on every change and reloaded if Cloudflare evicts the object, so a
  mid-game eviction looks like a brief reconnect. A room whose players have
  *all* dropped is held for **24 h** (not 90 s) and stays listed on the menu
  under **⟳ Unfinished games** for anyone whose account holds a seat — one tap
  rejoins. As a last line of defence the **host's browser** keeps an encrypted
  copy of the room (`backup` messages; AES-GCM, key held by the Lobby object, so
  the host can't read hands or forge scores); if the room is ever gone from the
  server, the host's "Restore" rebuilds it and everyone rejoins.

**Alternative — Render / Railway / Fly (the legacy Node server).** The repo still
ships `render.yaml`: push to GitHub, then on [Render](https://render.com): *New →
Blueprint → pick the repo*. One service serves the site **and** the WebSocket.

- **Free tier sleeps after ~15 min idle** — first visitor waits 30–50 s. For real
  games use the **Starter** plan (always-on), or [Railway](https://railway.app) /
  [Fly.io](https://fly.io).
- Rooms live in memory: keep it at **one instance** (no autoscaling).
- ngrok works for a quick session (`ngrok http 4003`), but tunnels add latency.

### Desktop & mobile app

The game is a **PWA**: served over HTTPS (any of the hosts above), browsers
offer **Install** (desktop Chrome/Edge: ⊕ icon in the address bar; Android:
"Add to Home screen"; iOS Safari: Share → "Add to Home Screen"). It launches
fullscreen like a native app, and single player works offline.

To go further:
- **Desktop**: wrap with [Tauri](https://tauri.app) (tiny, Rust) or Electron —
  point the window at your hosted URL or bundle the static files.
- **Mobile stores**: wrap with [Capacitor](https://capacitorjs.com) — the
  whole game is static HTML/JS, so it drops straight in; multiplayer just needs
  the hosted server URL.

### Emotes & quick messages

In an online game, tap **💬** to send an emoji reaction, a preset quick message
("Nice play!", "Hurry up ⏳"…) or a short typed message — it pops up as a speech
bubble at your seat on everyone's table. Rate-limited server-side.

### Attack taunts (multiplayer)

💬 → the red **attack row**: send a 🦁 Lion charge, 🐉 Dragon fire, 💣 Bomb,
👻 Ghost or 💀 Doom rampaging across **every player's table** — pressure your
opponents right before they pick a card. Budget is **one attack per move**
(server-enforced); playing a card recharges it.

### Cinematics & sound

Big moments get live-stream-style effects (all CSS 3D + synthesized audio, no
assets, no dependencies — see `js/fx.js`):
- **Black Queen lands** → full-screen takeover: lightning, shockwave rings, a
  spinning 3D Q♠, falling queens, screen shake, thunder + tolling bells.
- **Someone eats hearts** → a beating heart bursts over their seat with the
  points, plus a soft thump-and-sigh sound.
- **Hearts broken** → top banner sweep + 💔 rain + whoosh.
- **Game over** → 3D tumbling confetti, trophy banner, brass-y fanfare.
- **Emoji reactions** (multiplayer) → float up the screen like a TikTok live.

Everything can be turned off per player: 🎨 → *Cinematic effects*.

All particles (sparks, rains, floats, confetti, attack actors) run on a single
full-screen **canvas** with a physics loop (`js/fx.js`) — velocity, gravity,
drag, sway, trails. Cards **fly** from each player's hand to the trick with an
arc (opponents' cards 3D-flip face-up mid-air), and deals spin out of the
center deck. Real recorded sounds live in `sounds/` (shuffle, card place, hard
punch) with synthesized fallbacks. **Settings → Sound Volumes** mixes six
channels independently: master, music, cards, hard punch, effects, interface.

### Appearance (per player)

Tap **🎨** (menu or in-game). Each player can pick — just for themselves:
- **Card size** — 70 % to 140 % slider for your own hand.
- **Table felt** — 6 themes (emerald, midnight, crimson, charcoal, royal, sand).
- **Card back** — 10 designs.
- **Card style** — classic illustrated deck, big-and-clean text, or
  high-contrast night cards.
- **Pre-select** — tick the option, then tap a card *before* your turn; it's
  pinned 📌 and plays automatically the moment your turn arrives (tap again to
  unpin).

## How to play

Avoid winning tricks that contain penalty cards. **Lowest total score wins.**

| Card                 | Points |
|----------------------|--------|
| Black Queen (Q♠)     | **12** |
| Each Heart (♥)       | **1**  |
| **Total per round**  | **25** |

Special rules (all toggleable in Settings):
- Win **no trick** all round → **−12**.
- **3** zero-point rounds in a row → **−12**.
- The two −12 penalties **never stack** — you lose at most −12 per round from
  them, and receiving any −12 **resets** your consecutive-zero streak.
- **Queen immunity:** a player at **≥ 80** points can't be charged the Queen.
  If they capture it, the 12 points are disregarded (they take only the hearts,
  so the round totals 13). Threshold is editable in Settings.
- **Must throw the Queen:** you can't hold the Black Queen back when there's a
  guaranteed way to get rid of it. Two cases force it: **(a)** you're **void**
  in the led suit (discard it onto whoever wins), or **(b)** **spades is led and
  a higher spade (K♠/A♠) is already on the table** — the Queen can no longer win
  the trick, so you must dump it onto that higher spade instead of hiding it
  behind a lower one.
  *Exception:* if the Queen's points are **guaranteed wasted** this trick (every
  player who could still win it is score-exempt), throwing becomes optional. If
  there's any chance a non-exempt player takes it, you must throw.
- **No passing** cards.
- **Highest-scoring** player deals; player to their **right** leads first, and
  play proceeds to the **right** (counter-clockwise).
- A scoreboard shows running totals, a per-round breakdown, and a hand-by-hand
  conceded-points matrix (with a ♛ marker for who took/voided the Queen).

## Architecture — where to change things

Everything is plain ES5-ish JavaScript in `js/`, loaded as classic scripts (so
it runs from `file://`). All modules hang off a single global `BQ` namespace.

| File              | Responsibility | Edit this when you want to… |
|-------------------|----------------|------------------------------|
| `js/config.js`    | **All rules & tunables** (`DEFAULT_RULES`). | Change points, penalties, win conditions, player count, bot names, speeds. |
| `js/cards.js`     | Card/Deck data, shuffle, deal, sort. | Change deck composition or sorting. |
| `js/engine.js`    | Headless game engine: state, turns, trick resolution, scoring. Emits events. | Change *how* rules are applied / trick logic. |
| `js/ai.js`        | Bot decision heuristics. | Make bots smarter/dumber. |
| `js/sound.js`     | Web-Audio synthesized SFX + ambient music. | Change/add sounds. |
| `js/ui.js`        | All rendering, animation, modals, FX. | Change look & feel. |
| `js/net.js`       | Client networking: `NetClient` (WebSocket) + `NetworkEngine` (mirrors the engine, driven by server snapshots). | Change the wire protocol or client-side sync. |
| `js/main.js`      | Bootstrap: wires menu, lobby, the Settings rule-editor, single- & multi-player lifecycle. | Add new screens/buttons/settings fields. |
| `server.js`       | **LAN server** (zero-dep Node): static files + hand-rolled WebSocket + rooms + authoritative engine + bots. | Change matchmaking, rooms, or server rules. |
| `css/styles.css`  | All visual styling. | Restyle the table, cards, effects. |

### How multiplayer works
The same `GameEngine` runs **on the server** (it's headless, so it just works in
Node). Each connected browser is a thin view: it sends `{t:'play',cardId}` and
receives personalized **snapshots** (only your own hand is revealed) plus a
`hint` describing what just happened, which `NetworkEngine` turns back into the
exact same UI events the local engine emits. The UI is *perspective-aware*
(`ui.me`) so every player sees themselves at the bottom seat.

### The golden rule
The engine **never hard-codes a rule value** — it always reads from `this.rules`
(the config object). So to retune the game you only touch `config.js` (defaults)
or the in-game **Settings** panel (live overrides, saved to `localStorage`).

### Engine events (subscribe in `ui.js`)
```js
engine.on('roundStart',  e => ...)  // {round, dealerIndex, leaderIndex, hands}
engine.on('turn',        e => ...)  // {playerIndex, legalCardIds}
engine.on('cardPlayed',  e => ...)  // {playerIndex, card, trick}
engine.on('trickWon',    e => ...)  // {winnerIndex, trick, points}
engine.on('heartsBroken',e => ...)
engine.on('roundEnd',    e => ...)  // {round, roundScores, totals, breakdown}
engine.on('gameOver',    e => ...)  // {totals, winnerIndex, ranking}
engine.on('reshuffleOffer', e => ...) // {playerIndex, remaining} — trailing player may re-deal
```

### Trailing-player reshuffle (multiplayer)
Before a round's cards are dealt, the player with the **most points** (worst
standing — low score wins) may reshuffle the deck, up to `reshuffleMax` (2) times
per round. The choice is **blind** — it happens before any hand is distributed.
Skipped on round 1 (everyone tied at 0) and when no one is distinctly trailing.
Off in single-player; the server sets `rules.reshuffleEnabled = true` for online
Black Queen and vetoes the offer for bot/disconnected seats via
`engine.reshuffleGate`. The engine shuffles a deck, enters the `awaitReshuffle`
phase (no deal yet), and emits `reshuffleOffer`; it then waits for
`reshuffleAgain()` (shuffle once more) or `beginPlay()` (deal + start). Only on
`beginPlay`/exhausted does it deal and emit `roundStart`. Client messages:
`reshuffleDeal` (shuffle again) / `reshuffleStart` (deal now); the offer is
broadcast as its own `reshuffleOffer` message and also rides in the snapshot
(`snapshot.reshuffle = {seat, remaining}`) for reconnects.

### Adding a new editable rule
1. Add the key + default to `DEFAULT_RULES` in `config.js`.
2. Read it wherever needed in `engine.js` via `this.rules.yourKey`.
3. Add one row to `SETTINGS_SCHEMA` in `main.js` so it appears in the editor.

## Customizing rules in-game
Click **⚙️** (in-game) or **Settings** (menu). Change any value, hit **Save** —
it applies on the next round and persists across sessions. **Reset Defaults**
restores `config.js` values.


# Gameplay Tactics (Pairs Strategy)

## Main Objective

* The game is played in pairs.
* Your primary goal is to avoid collecting points:

  * Queen of Spades = 12 points
  * Each Heart = 1 point
* The strategy mainly revolves around forcing opponents to take the Queen of Spades.

---

# Queen of Spades Strategy

## Basic Rule

* The Queen of Spades can safely be played on:

  * King of Spades
  * Ace of Spades
* If neither has been played and you cannot follow suit, you may throw the Queen on any other card.

---

## 1. If You Have the Queen of Spades (First Position)

* Check which non-spade suit you have the fewest cards in.
* Try to become void in that suit as early as possible.
* Signal your partner about the suit you are trying to empty.
* Once you are void:

  * Your partner should lead that suit with a low card.
  * An opponent will likely win the trick with a higher card.
  * You can then discard the Queen of Spades onto that trick.

---

## 2. If You Have the Queen of Spades (Second, Third, or Fourth Position)

* Try to gain control of the lead during the early or middle stage of the game.
* Work toward becoming void in a selected suit.
* Use the same setup strategy:

  * Partner leads the target suit.
  * Opponent wins the trick.
  * You discard the Queen of Spades.

---

## 3. If You Do NOT Have the Queen, but Have the Ace or King of Spades

* Avoid leading with spades early.
* Win tricks using other suits whenever possible.
* Help create opportunities for the Queen holder to dump the Queen onto opponents.
* Be careful not to accidentally capture the Queen with your Ace or King.

---

## 4. If You Do NOT Have the Queen, Ace, or King of Spades

* start with low spades early in the game.
* This signals to your partner that:

  * You do not hold the Queen of Spades.
  * You also do not hold the high spades.
* Your partner can then adjust strategy accordingly if they hold the Queen.

---

## 5. If Your Partner Has the Queen and You Have the Ace or King of Spades

* Win tricks using other suits whenever possible.
* Avoid taking tricks with the Ace or King of Spades unless absolutely necessary.
* Indicate to your partner which suit you can safely use to dispose of your high spades later.
* Protect your partner from accidentally losing the Queen onto your high spades.

---

## 6. If Your Partner Has the Queen and You Do NOT Have the Ace or King of Spades

* Allow your partner to control the lead whenever possible.
* Your partner will indicate the suit where they plan to discard the Queen.
* In the first round of that suit:

  * Save your high cards.
* In the second round:

  * Use your high card to gain control if needed.
* Then lead back with a very low card (2, 3, or 4) in the same suit.
* This forces opponents to win the trick with higher cards, allowing your partner to safely discard the Queen of Spades.

---

# General Team Communication Tips

* Use card play patterns to communicate with your partner.
* Avoid obvious risky plays that expose your strategy too early.
* Keep track of:

  * Played spades
  * Remaining high cards
  * Which suits players are void in
* Timing and coordination are more important than aggressive trick-taking.


# 🎴 Treeky — Complete Gameplay

Treeky is the second game in this app — a fast **shedding** game (Crazy-Eights /
"Switch" family). Pick it from the **game toggle on the menu** (♛ Black Queen /
🎴 Treeky); everything else — single-player, LAN/online multiplayer, spectating,
bots — works for both games.

## Objective

**Empty your hand.** The first player to get rid of all their cards finishes
**1st** and then **spectates** while everyone else keeps playing. The game ends
when only **one** player is still holding cards (they place **last**), and the
final **finish order** is shown.

## Players & table

* **3 to 10 players.**
* **Single player:** you + 3 bots (4 at the table). Table size is adjustable in
  Settings (3–6).
* **Online:** join with friends; any empty seats are filled with bots up to a
  minimum of 4, and up to 10 players total.
* Players are seated around the felt — you at the bottom, opponents across the
  top and sides — each showing a face-down stack of their cards. A **D** marks
  the dealer; the glowing badge is whoever's turn it is.

## Setup

1. The game uses **two full decks shuffled together** (104 cards — every card
   appears twice).
2. Each player is dealt **10 cards** (configurable: 7 / 8 / 10 / 12 in Settings).
3. One card is turned face-up to start the **pile**. If it's a **3** or a
   **Jack**, it's reshuffled and another is flipped until a normal card shows.
4. The player **after the dealer** goes first; play proceeds one way around the
   table.

## Matching — what you can play

On your turn you may throw a card that matches the top of the pile by:

* **Suit** (♠ / ♥ / ♦ / ♣ — the "colour"), **or**
* **Number** (same rank), **or**
* a **Jack** (always playable — see below).

Playing a **same-number** card of a different suit switches the active suit to
the card you played, so the next player must follow the new suit.

## Your turn — throw or draw

* You may either **throw a legal card** *or* **draw a card** — and you can choose
  to draw **even if you have a playable card**.
* **After you draw** (a normal draw *or* a 3-penalty pickup) you get a **Pass**
  option: throw any legal card, or **pass** the turn on.
* If after drawing you still have **nothing to throw**, the turn moves to the
  **next player** automatically.
* There is **no pass before drawing** — on a fresh turn you throw or draw.

## Special cards

### Jack — wild

* A Jack can be played on **anything**.
* When you play it, you **choose the new suit** the next player must follow (a
  suit picker pops up). Change your mind? **Cancel** the picker and play a
  different card instead.

### 3 — "pick three" (stackable)

* Play a **3** and the **next player must draw 3 cards** (you'll hear *"Pick 3
  cards!"*).
* If that player also has a **3**, they can **stack** it instead of drawing — now
  the following player must draw **6** (*"Pick 6 cards!"*), and so on (+3 each
  stacked 3).
* A player who can't (or won't) stack **draws the whole accumulated amount**.
  After picking up they still get to **throw a card or pass** (or the turn passes
  on if they have nothing to throw).

## "Last Card!" call

* When you play your **second-to-last** card (leaving you with one), you must tap
  the pulsing **🔔 Last Card!** button to announce it.
* **Forget to call it?** On your **next turn** you automatically **draw one
  penalty card** — and you may **not draw again** that turn. If you then have a
  card to throw you play it; otherwise the turn passes to the next player.
* (Bots always call their last card. The penalty applies at most once per time
  you drop to a single card.)

## When the deck runs out

If the draw pile can't cover a required draw, a **popup asks the table owner to
reshuffle**. The **last card thrown stays on the pile**; every other discarded
card is shuffled back into the deck, and play resumes right where it paused.

## Finishing & results

* Empty your hand to **finish**. You're ranked in the order players go out (1st,
  2nd, …) and then **watch** the rest of the game.
* The game ends when only one player still holds cards — they finish **last**.
* The results panel lists everyone in **finish order**. **Play Again** (host)
  starts a fresh game.

## In-game controls

* **Toolbar (top-right):** 🎨 Appearance · 🎵 Music · 🔊 Sound · 📊 **Standings**
  (live leaderboard by cards left / finish order) · ⚙️ **Settings** · ✕ Quit.
* **⚙️ Settings:** Table size (single-player), Cards per player, and Bot speed.
* **Effects dock (bottom-right):** 🦁 Lion · 🐉 Dragon · 💣 Bomb · 👻 Ghost ·
  💀 Doom — fun taunt animations + sounds you can send to the table.
* **Spectate:** from Multiplayer, tap **👁 Watch** to watch a live game — every
  hand stays hidden; only the discard pile and card counts are shown.

## Quick strategy

* **Hold your Jacks.** They're your escape hatch — save them for when you have no
  other legal card, or to swing the suit to one you're long in.
* **Watch the player to your left.** If they're down to one or two cards, a **3**
  played into them can wreck their plan (and saves a "Last Card" finish).
* **Shed your long suits** so you always have something to follow with.
* **Stack 3s** when you can — passing a +6 or +9 along is brutal, and it sheds a
  card at the same time.
* **Drawing on purpose** can be smart: take a card to dodge a forced bad play, or
  to keep a key card for a better moment.
* **Don't forget the call** — getting caught one card short is a free penalty
  card for you and a tempo gift to everyone else.

## For developers — where Treeky lives

Treeky is **purely additive**; the Black Queen engine/UI/AI are untouched. A
`gameType` (`'blackqueen'` | `'treeky'`) selected on the menu flows through the
single-player launch, the create-room message, the room, and every snapshot;
clients pick the matching engine-mirror + UI by reading `snapshot.gameType`.

* `js/treeky-engine.js` — `BQ.TreekyEngine`: headless rules/state, same `on/emit`
  bus as the Black Queen engine. Events: `gameStart`, `turn`, `cardPlayed`,
  `suitChosen`, `cardsDrawn`, `lastCardDeclared`, `playerFinished`, `gameOver`,
  `needReshuffle`, `reshuffled`. Phases: `playing | awaitHuman | awaitSuit |
  awaitReshuffle | gameOver`.
* `js/treeky-ai.js` — `BQ.TreekyAI.chooseMove(engine, seat)`.
* `js/treeky-ui.js` — `BQ.TreekyUI`, the table renderer (same `attach(engine)`
  contract as `ui.js`).
* `js/config.js` — `TREEKY_RULES` + `BQ.cloneTreekyRules()`.
* `js/cards.js` — `BQ.buildTreekyDeck()` (two decks, unique per-copy ids).
* `js/net.js` — `BQ.TreekyNetworkEngine` (read-only server mirror).
* `server.js` — `gameType` branches: `startTreekyGame`, `wireTreekyEngine`,
  `scheduleTreekyBot`, `treekySnapshotFor`, `treekySpectatorSnapshot`.
