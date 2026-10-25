// Studgether connection layer: joins the same room over two independent public
// signalling networks (BitTorrent trackers + Nostr relays) for reliability, then
// talks directly browser-to-browser (WebRTC). No server of ours is involved.
import { joinRoom as joinTorrent, selfId } from "@trystero-p2p/torrent";
import { joinRoom as joinNostr } from "@trystero-p2p/nostr";

function join(opts, roomId) {
  const base = { appId: opts.appId || "studgether-v1" };
  if (opts.turn && opts.turn.length) base.turnConfig = opts.turn;
  if (opts.loopback) { base._test_only_mdnsHostFallbackToLoopback = true; base.rtcConfig = { iceServers: [] }; }
  const refs = new Map();           // peerId -> number of strategy links
  const links = [];                 // {room, send}
  const api = { selfId, onMessage: null, onPeerJoin: null, onPeerLeave: null };
  const up = (id) => { const n = (refs.get(id) || 0) + 1; refs.set(id, n); if (n === 1 && api.onPeerJoin) api.onPeerJoin(id); };
  const down = (id) => { const n = (refs.get(id) || 0) - 1; if (n <= 0) { refs.delete(id); if (api.onPeerLeave) api.onPeerLeave(id); } else refs.set(id, n); };
  const strategies = [];
  const tcfg = Object.assign({}, base);
  if (opts.trackers && opts.trackers.length) tcfg.relayConfig = { urls: opts.trackers };
  strategies.push(["torrent", () => joinTorrent(tcfg, roomId)]);
  if (opts.nostr !== false) strategies.push(["nostr", () => joinNostr(Object.assign({}, base), roomId)]);
  strategies.forEach(([name, make]) => {
    try {
      const room = make();
      const action = room.makeAction("sg");
      action.onMessage = (data, ctx) => { if (api.onMessage && data && typeof data === "object") api.onMessage(data, ctx.peerId); };
      room.onPeerJoin = up;
      room.onPeerLeave = down;
      links.push({ room, action, name });
    } catch (e) { console.warn("Studgether: " + name + " link failed", e); }
  });
  api.send = (msg, target) => {
    links.forEach(l => { try { const p = l.action.send(msg, target ? { target } : undefined); if (p && p.catch) p.catch(() => {}); } catch (_) {} });
  };
  api.peers = () => Array.from(refs.keys());
  api.leave = () => { links.forEach(l => { try { l.room.leave(); } catch (_) {} }); refs.clear(); };
  return api;
}
window.StudgetherNet = { join, selfId };
