/* =============================================================================
 * Black Queen — LOBBY (a single shared registry Durable Object)
 * -----------------------------------------------------------------------------
 * In the old single-process server, ONE Map held every room, so "join with a
 * blank code" or "watch the only live game" could just scan it. On Workers each
 * room is an isolated Durable Object that can't see the others — so this one
 * fixed object (name "lobby") keeps the cross-room view, reached over HTTP:
 *
 *   • allocates a unique, unused 4-letter code for a new room      (GET ?need=create)
 *   • answers "give me an open room to join"                       (GET ?need=join)
 *   • answers "give me a live game to watch"                       (GET ?need=spectate)
 *   • answers "which room holds MY seat?" (cross-device rejoin)    (GET ?need=mine)
 *   • lists everything (debug / future room browser)               (GET ?need=list)
 *
 * Each Main room reports its state here on every meaningful change (created,
 * started, a seat opened/closed, torn down) via getServerByName(env.Lobby,...).
 * It is HTTP-only (no sockets), so it evicts between requests — the registry is
 * persisted to Durable Object storage and reloaded on demand.
 * ===========================================================================*/

import { Server } from "partyserver";
import { getUser } from "./api.js";

// Unambiguous alphabet (no 0/O/1/I) — mirrors the old makeCode().
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// A confirmed room with no activity for this long is considered dead and swept
// (a safety net against rooms that vanished without reporting a removal).
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
// A code reserved by ?need=create but never actually created (the client closed
// the tab before connecting) expires quickly so it can't block its slot.
const RESERVED_TTL_MS = 90 * 1000;

export class Lobby extends Server {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // code -> { started, joinable, live, reserved, ts }
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get("rooms");
    if (Array.isArray(saved)) this.rooms = new Map(saved);
    this.loaded = true;
  }

  async persist() {
    await this.ctx.storage.put("rooms", [...this.rooms]);
  }

  // Durable Object RPC (room objects call `stub.getBackupKey()`; NOT reachable
  // over HTTP — onRequest never exposes it). One random 256-bit AES key, minted
  // on first use and kept here forever, seals every room's host backup so the
  // blob a host's browser holds can't be read or forged, only handed back.
  async getBackupKey() {
    let key = await this.ctx.storage.get("backupKey");
    if (!key) {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...raw));
      await this.ctx.storage.put("backupKey", key);
    }
    return key;
  }

  // Drop stale entries: long-dead rooms and abandoned reservations.
  sweep() {
    const now = Date.now();
    for (const [code, v] of this.rooms) {
      const ttl = v.reserved ? RESERVED_TTL_MS : ENTRY_TTL_MS;
      if (now - (v.ts || 0) > ttl) this.rooms.delete(code);
    }
  }

  freshCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  async onRequest(req) {
    await this.load();
    this.sweep();

    // Rooms report their state with a POST.
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ ok: false }, 400); }
      const code = String(body.code || "").toUpperCase();
      if (!code) return json({ ok: false }, 400);
      if (body.removed) {
        this.rooms.delete(code);
      } else {
        this.rooms.set(code, {
          gameType: typeof body.gameType === "string" ? body.gameType : "blackqueen",
          started: !!body.started,
          joinable: !!body.joinable,
          live: !!body.live,
          users: Array.isArray(body.users) ? body.users : [],
          reserved: false,
          ts: Date.now(),
        });
      }
      await this.persist();
      return json({ ok: true });
    }

    // Clients ask questions with a GET.
    const need = new URL(req.url).searchParams.get("need");

    if (need === "create") {
      const code = this.freshCode();
      // Reserved (not yet joinable) until the room itself reports its real state.
      this.rooms.set(code, { started: false, joinable: false, live: false, reserved: true, ts: Date.now() });
      await this.persist();
      return json({ code });
    }

    if (need === "join") {
      const hit = [...this.rooms].find(([, v]) => v.joinable);
      return hit ? json({ code: hit[0] }) : json({ error: "none" }, 404);
    }

    if (need === "spectate") {
      const hit = [...this.rooms].find(([, v]) => v.live);
      return hit ? json({ code: hit[0] }) : json({ error: "none" }, 404);
    }

    // Cross-device rejoin: which room is the logged-in user seated in? The
    // session cookie rides along on the same-origin fetch; resolve it against
    // D1 and scan the registry for a room holding that user's seat.
    if (need === "mine") {
      if (!this.env.DB) return json({ error: "none" }, 404);
      const user = await getUser(req, this.env).catch(() => null);
      if (!user) return json({ error: "unauthorized" }, 401);
      // Every room holding a seat for this account (started games first, newest
      // first) — the menu lists them all under "Unfinished games"; `code` keeps
      // the original single-answer shape for older clients.
      const rooms = [...this.rooms]
        .filter(([, v]) => !v.reserved && Array.isArray(v.users) && v.users.includes(user.id))
        .sort(([, a], [, b]) => (Number(!!b.started) - Number(!!a.started)) || ((b.ts || 0) - (a.ts || 0)))
        .map(([code, v]) => ({ code, gameType: v.gameType || "blackqueen", started: !!v.started, live: !!v.live, ts: v.ts || 0 }));
      return rooms.length
        ? json({ code: rooms[0].code, started: rooms[0].started, live: rooms[0].live, rooms })
        : json({ error: "none" }, 404);
    }

    if (need === "list") {
      return json({ rooms: [...this.rooms].map(([code, v]) => ({ code, ...v })) });
    }

    return json({ error: "bad-request" }, 400);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
