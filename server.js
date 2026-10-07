const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const SERVER_VERSION = '3.15.0';
const CLIENT = path.join(__dirname, 'client', 'index.html');
const rooms = new Map();
const sessions = new Map();

const RULES = new Set(['unlimited', 'rental', 'super_rental', 'random_pot']);
const MAX_ROOM_NAME = 40;
const MAX_PLAYER_NAME = 40;
const MAX_SPECTATORS = 50;
const DECISION_MS = 90_000;
const MAX_PROFILE_CARDS = 500;
const MAX_PROFILE_DECKS = 100;
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;

const ABNORMALITY_DEFS = Object.freeze({
  poison: { name:'毒', kind:'debuff' },
  paralysis: { name:'麻痺', kind:'debuff' },
  freeze: { name:'凍結', kind:'debuff' },
  slow: { name:'鈍足', kind:'debuff' }
});
function abnormalityName(type) { return ABNORMALITY_DEFS[type]?.name || String(type || '状態異常'); }

function uid(prefix='id') { return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function hashPassword(v) { return v ? crypto.createHash('sha256').update(String(v)).digest('hex') : ''; }
function safeName(v, fallback='プレイヤー', max=MAX_PLAYER_NAME) {
  const s = String(v ?? '').trim();
  return (s || fallback).slice(0, max);
}
function uniqueById(arr) {
  const m = new Map();
  for (const x of Array.isArray(arr) ? arr : []) if (x?.id && !m.has(String(x.id))) m.set(String(x.id), x);
  return [...m.values()];
}
function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function isUnitCard(c) { return c?.cardType === 'unit'; }
function isMagicCard(c) { return c?.cardType === 'magic'; }
function cardIdsUnique(ids) {
  return Array.isArray(ids) && ids.every((v, i) => ids.indexOf(v) === i);
}

function sanitizeCard(c, includePrivate=false) {
  if (!c || !c.id) return null;
  const base = {
    id: String(c.id),
    cardType: c.cardType,
    name: String(c.name || '').slice(0, 80),
    mainAttr: c.mainAttr || '',
    subAttrs: Array.isArray(c.subAttrs) ? c.subAttrs.slice(0, 5) : [],
    stats: clone(c.stats || {}),
    image: typeof c.image === 'string' ? c.image : null,
    imageUrl: typeof c.imageUrl === 'string' ? c.imageUrl : null
  };
  if (includePrivate) {
    base.skills = clone(c.skills || []);
    base.effect = clone(c.effect || null);
    base.desc = String(c.desc ?? c.description ?? '').slice(0, 5000);
    base.description = base.desc;
  }
  return base;
}
function sanitizeCardNoImage(c, includePrivate=false) {
  const x = sanitizeCard(c, includePrivate);
  if (x) { delete x.image; delete x.imageUrl; }
  return x;
}
function sanitizeDeck(d) {
  if (!d?.id) return null;
  return {
    id: String(d.id),
    name: String(d.name || 'デッキ').slice(0, 80),
    unitIds: [...new Set((Array.isArray(d.unitIds) ? d.unitIds : []).map(String))].slice(0, 5),
    magicIds: [...new Set((Array.isArray(d.magicIds) ? d.magicIds : []).map(String))].slice(0, 10)
  };
}
function normalizeProfile(msg, fallbackName) {
  const cards = uniqueById((Array.isArray(msg?.cards) ? msg.cards : [])
    .slice(0, MAX_PROFILE_CARDS)
    .map(c => sanitizeCard(c, true))
    .filter(Boolean));
  const decks = [];
  for (const d of (Array.isArray(msg?.decks) ? msg.decks : []).slice(0, MAX_PROFILE_DECKS)) {
    const x = sanitizeDeck(d);
    if (x) decks.push(x);
  }
  return { name: safeName(msg?.name, fallbackName), cards, decks };
}

function mergeProfileAssets(s, assets) {
  if (!s?.profile || !Array.isArray(assets)) return 0;
  const byId = new Map(s.profile.cards.map(c => [String(c.id), c]));
  let count = 0;
  for (const a of assets) {
    const id = String(a?.id || '');
    const image = typeof a?.image === 'string' ? a.image : (typeof a?.imageUrl === 'string' ? a.imageUrl : null);
    const card = byId.get(id);
    if (!id || !card || !image) continue;
    card.image = image;
    card.imageUrl = null;
    count++;
  }
  return count;
}


function setProfileAssetExpectations(s, assetIds) {
  if (!s) return;
  const ids = new Set((Array.isArray(assetIds) ? assetIds : []).map(String).filter(Boolean));
  s.profileAssetExpected = ids;
  const prev = s.profileAssetReceived instanceof Set ? s.profileAssetReceived : new Set();
  s.profileAssetReceived = new Set([...prev].filter(id => ids.has(id)));
}
function markProfileAssetsReceived(s, assetIds) {
  if (!s) return;
  if (!(s.profileAssetReceived instanceof Set)) s.profileAssetReceived = new Set();
  for (const id of (Array.isArray(assetIds) ? assetIds : [])) {
    const sid = String(id || '');
    if (sid) s.profileAssetReceived.add(sid);
  }
}
function profileAssetsReady(s) {
  if (!s) return false;
  const expected = s.profileAssetExpected instanceof Set ? s.profileAssetExpected : new Set();
  if (expected.size === 0) return true;
  const received = s.profileAssetReceived instanceof Set ? s.profileAssetReceived : new Set();
  for (const id of expected) if (!received.has(id)) return false;
  return true;
}
function markAssetReadyForRoom(r, sid) {
  const p = r?.players?.find(x => x?.sessionId === sid);
  const sess = sessions.get(sid);
  if (p) p.assetsReady = profileAssetsReady(sess);
}
function allBattlePrerequisitesReady(r) {
  if (!r?.players?.every(Boolean)) return false;
  for (const p of r.players) {
    const sess = sessions.get(p.sessionId);
    if (!sess || !profileAssetsReady(sess)) return false;
  }
  return true;
}
function maybeStartBattle(r) {
  if (!r || r.battle) return false;
  if (!r.players.every(Boolean) || !r.players.every(p => p.ready)) return false;
  if (!r.selected[r.players[0].sessionId] || !r.selected[r.players[1].sessionId]) return false;
  if (!allBattlePrerequisitesReady(r)) {
    r.status = 'preparing';
    broadcastRoom(r, 'battle_preparing', {message:'両プレイヤーのカード画像を同期しています…'});
    broadcastPlayers(r);
    return false;
  }
  try {
    startBattle(r);
    return true;
  } catch (err) {
    r.status = 'waiting';
    for (const q of r.players) if (q) q.ready = false;
    broadcastRoom(r, 'error', {code:'BATTLE_START_FAILED', message:err.message});
    return false;
  }
}
function publicRoom(r) {
  return {
    roomId: r.roomId,
    roomName: r.roomName,
    ownerName: r.ownerName,
    rule: r.rule,
    status: r.status,
    players: r.players.filter(Boolean).length,
    spectators: r.spectators.size,
    password: !!r.passwordHash,
    maxSpectators: r.maxSpectators
  };
}
function playerSummaries(r) {
  return r.players.map((p) => {
    if (!p) return null;
    const x = { playerId: p.sessionId, name: p.name, ready: !!p.ready, online: !!p.online };
    if (r.rule === 'rental') x.deckName = r.deckSelections[p.sessionId]?.name || null;
    return x;
  });
}
function send(ws, type, payload={}) {
  if (!ws || !ws._wsOpen) return false;
  return wsSend(ws, { type, ...payload });
}
function wsSend(ws, data) {
  if (!ws || !ws._wsOpen || ws.destroyed) return false;
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  if (payload.length > MAX_WS_PAYLOAD) return false;
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try { ws.write(Buffer.concat([head, payload])); return true; } catch { return false; }
}
function wsControl(ws, opcode, payload=Buffer.alloc(0)) {
  if (!ws || !ws._wsOpen) return;
  const p = Buffer.from(payload).subarray(0, 125);
  const head = Buffer.from([0x80 | opcode, p.length]);
  try { ws.write(Buffer.concat([head, p])); } catch {}
}
function acceptWebSocket(socket) {
  socket._wsOpen = true;
  socket._wsClosed = false;
  socket._wsBuffer = Buffer.alloc(0);
  socket._wsMessageOpcode = 0;
  socket._wsMessageChunks = [];
  socket._wsMessageLength = 0;
  try { socket.setNoDelay(true); socket.setKeepAlive(true, 30000); } catch {}

  const closeWithCode = (code=1002) => {
    if (!socket._wsOpen) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    wsControl(socket, 0x8, p);
    socket.end();
  };
  const resetMessage = () => {
    socket._wsMessageOpcode = 0;
    socket._wsMessageChunks = [];
    socket._wsMessageLength = 0;
  };
  const emitTextMessage = (payload) => {
    try { socket.emit('wsmessage', payload.toString('utf8')); }
    catch { closeWithCode(1007); }
  };

  socket.on('error', () => {});
  socket.on('data', chunk => {
    if (!socket._wsOpen) return;
    socket._wsBuffer = Buffer.concat([socket._wsBuffer, chunk]);
    if (socket._wsBuffer.length > MAX_WS_PAYLOAD + 64 * 1024) {
      closeWithCode(1009);
      return;
    }

    while (socket._wsBuffer.length >= 2 && socket._wsOpen) {
      const b0 = socket._wsBuffer[0];
      const b1 = socket._wsBuffer[1];
      const fin = !!(b0 & 0x80);
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;

      if (rsv !== 0 || !masked) { closeWithCode(1002); return; }
      if (len === 126) {
        if (socket._wsBuffer.length < 4) return;
        len = socket._wsBuffer.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (socket._wsBuffer.length < 10) return;
        const n = socket._wsBuffer.readBigUInt64BE(2);
        if (n > BigInt(MAX_WS_PAYLOAD)) { closeWithCode(1009); return; }
        len = Number(n); off = 10;
      }

      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) { closeWithCode(1002); return; }
      const need = off + 4 + len;
      if (socket._wsBuffer.length < need) return;

      const mask = socket._wsBuffer.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(socket._wsBuffer.subarray(off, off + len));
      socket._wsBuffer = socket._wsBuffer.subarray(need);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      if (opcode === 0x8) {
        wsControl(socket, 0x8, payload.subarray(0, 125));
        socket.end();
        return;
      }
      if (opcode === 0x9) { wsControl(socket, 0xA, payload); continue; }
      if (opcode === 0xA) continue;

      if (len > MAX_WS_PAYLOAD || socket._wsMessageLength + len > MAX_WS_PAYLOAD) {
        closeWithCode(1009);
        return;
      }

      if (opcode === 0x1) {
        if (socket._wsMessageOpcode !== 0) { closeWithCode(1002); return; }
        if (fin) {
          emitTextMessage(payload);
        } else {
          socket._wsMessageOpcode = 0x1;
          socket._wsMessageChunks = [payload];
          socket._wsMessageLength = len;
        }
        continue;
      }

      if (opcode === 0x0) {
        if (socket._wsMessageOpcode !== 0x1) { closeWithCode(1002); return; }
        if (len) socket._wsMessageChunks.push(payload);
        socket._wsMessageLength += len;
        if (fin) {
          const full = Buffer.concat(socket._wsMessageChunks, socket._wsMessageLength);
          resetMessage();
          emitTextMessage(full);
        }
        continue;
      }

      // Binary frames are not used by this application.
      closeWithCode(1003);
      return;
    }
  });
  socket.on('close', () => { socket._wsOpen = false; socket._wsClosed = true; resetMessage(); });
  return socket;
}
function roomBySession(sid) {
  const s = sessions.get(sid);
  return s?.roomId ? rooms.get(s.roomId) || null : null;
}
function playerSlot(r, sid) { return r?.players.findIndex(p => p?.sessionId === sid) ?? -1; }
function isPlayer(r, sid) { return playerSlot(r, sid) >= 0; }
function isSpectator(r, sid) { return !!r?.spectators.has(sid); }
function bothPlayersOnline(r) { return r.players.length === 2 && r.players.every(p => p?.online); }
function broadcastRoom(r, type, payload={}) {
  for (const p of r.players.filter(Boolean)) send(p.ws, type, payload);
  for (const sid of r.spectators) {
    const s = sessions.get(sid); if (s?.ws) send(s.ws, type, payload);
  }
}
function broadcastPlayers(r, type='room_update') {
  broadcastRoom(r, type, { room: publicRoom(r), players: playerSummaries(r) });
}
function setSessionRoom(sid, roomId) {
  const s = sessions.get(sid); if (s) s.roomId = roomId || null;
}
function copySessionProfileToRoom(r, s) {
  if (!s?.profile) return;
  r.profiles[s.sessionId] = clone(s.profile);
}
function createRoom(owner, cfg) {
  const rule = RULES.has(cfg.rule) ? cfg.rule : 'unlimited';
  const maxSpectators = Math.max(0, Math.min(MAX_SPECTATORS, Number(cfg.maxSpectators) || 10));
  const room = {
    roomId: uid('room'),
    roomName: safeName(cfg.roomName, 'カード勝負', MAX_ROOM_NAME),
    ownerId: owner.sessionId,
    ownerName: owner.name,
    passwordHash: hashPassword(cfg.password),
    rule,
    allowSpectators: cfg.allowSpectators !== false,
    maxSpectators,
    status: 'waiting',
    players: [null, null],
    spectators: new Set(),
    profiles: {},
    deckSelections: {},
    selected: {},
    pools: {},
    battle: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timer: null
  };
  room.players[0] = { sessionId: owner.sessionId, name: owner.name, ws: owner.ws, ready: false, online: true, lastSeen: Date.now(), assetsReady: profileAssetsReady(owner) };
  copySessionProfileToRoom(room, owner);
  rooms.set(room.roomId, room);
  owner.roomId = room.roomId;
  return room;
}

function validateDeckForProfile(profile, deck) {
  if (!profile || !deck) return { ok: false, error: 'デッキ情報がありません。' };
  const cards = new Map((profile.cards || []).map(c => [String(c.id), c]));
  const unitIds = [...new Set(deck.unitIds || [])].map(String);
  const magicIds = [...new Set(deck.magicIds || [])].map(String);
  if (unitIds.length < 3 || unitIds.length > 5) return { ok: false, error: 'キャラクターは3～5枚のデッキが必要です。' };
  if (magicIds.length > 10) return { ok: false, error: 'マジックは10枚までです。' };
  if (unitIds.some(id => !cards.has(id) || !isUnitCard(cards.get(id)))) return { ok: false, error: 'デッキ内のキャラクターカードがカードリストと一致しません。' };
  if (magicIds.some(id => !cards.has(id) || !isMagicCard(cards.get(id)))) return { ok: false, error: 'デッキ内のマジックカードがカードリストと一致しません。' };
  return { ok: true, unitIds, magicIds };
}
function selectedCardMap(source) { return new Map((source || []).map(c => [String(c.id), c])); }
function validateBattleSelection(source, selection) {
  const units = [...new Set((selection?.unitIds || []).map(String))];
  const magics = [...new Set((selection?.magicIds || []).map(String))];
  const active = [...new Set((selection?.active || []).map(String))];
  const reserve = [...new Set((selection?.reserve || []).map(String))];
  if (units.length < 3 || units.length > 5) return { ok: false, error: 'キャラクターは3～5枚選択してください。' };
  if (magics.length > 10) return { ok: false, error: 'マジックは10枚まで選択してください。' };
  if (active.length !== 3) return { ok: false, error: '出撃キャラクターは3枚必要です。' };
  if (reserve.length > 2) return { ok: false, error: '控えは2枚までです。' };
  if (active.some(id => reserve.includes(id))) return { ok: false, error: '出撃と控えに同じカードがあります。' };
  if (new Set([...active, ...reserve]).size !== units.length || !units.every(id => active.includes(id) || reserve.includes(id))) {
    return { ok: false, error: '出撃・控えの指定が選択キャラクターと一致しません。' };
  }
  const cards = selectedCardMap(source);
  if (units.some(id => !cards.has(id) || !isUnitCard(cards.get(id)))) return { ok: false, error: '選択したキャラクターが使用可能カードではありません。' };
  if (magics.some(id => !cards.has(id) || !isMagicCard(cards.get(id)))) return { ok: false, error: '選択したマジックが使用可能カードではありません。' };
  return { ok: true, unitIds: units, magicIds: magics, active, reserve };
}

function roomSourceForPlayer(r, sid, profileOverride=null) {
  const profile = profileOverride || r.profiles[sid];
  if (!profile) return [];
  if (r.rule === 'rental') return r.profiles[r.ownerId]?.cards || [];
  if (r.rule === 'super_rental' || r.rule === 'random_pot') return [...(r.pools[sid]?.units || []), ...(r.pools[sid]?.magics || [])];
  return profile.cards || [];
}
function deploymentOptionsForPlayer(r, sid) {
  const deck = r.deckSelections[sid];
  if (!deck) return null;
  const source = r.rule === 'rental' ? (r.profiles[r.ownerId]?.cards || []) : (r.profiles[sid]?.cards || []);
  const cardMap = selectedCardMap(source);
  const units = (deck.unitIds || []).map(id => cardMap.get(String(id))).filter(Boolean).map(c => sanitizeCard(c, true));
  const magics = (deck.magicIds || []).map(id => cardMap.get(String(id))).filter(Boolean).map(c => sanitizeCard(c, true));
  return { units, magics, deckId: deck.id, deckName: deck.name };
}
function sendDeploymentOptions(r, sid) {
  const s = sessions.get(sid); const opts = deploymentOptionsForPlayer(r, sid);
  if (!s?.ws || !opts) return;
  const stripImage = c => { const x=clone(c); if (x) { delete x.image; delete x.imageUrl; } return x; };
  const light={...opts,units:(opts.units||[]).map(stripImage),magics:(opts.magics||[]).map(stripImage)};
  send(s.ws, 'deployment_options', light);
  const assets=[...(opts.units||[]),...(opts.magics||[])].filter(c=>typeof c?.image==='string' && c.image).map(c=>({id:String(c.id),image:c.image}));
  sendChunkedJson(s.ws,'deployment_assets',assets,256*1024);
}
function prepareCandidatePools(r) {
  const p1 = r.players[0], p2 = r.players[1];
  const ownerProfile = r.profiles[r.ownerId];
  let source;
  if (r.rule === 'super_rental') source = ownerProfile?.cards || [];
  else source = uniqueById([...(r.profiles[p1.sessionId]?.cards || []), ...(r.profiles[p2.sessionId]?.cards || [])]);
  const chars = source.filter(isUnitCard);
  const mags = source.filter(isMagicCard);
  if (chars.length < 10) throw new Error('候補抽選に必要なキャラクターカードが10枚未満です。');
  if (mags.length < 20) throw new Error('候補抽選に必要なマジックカードが20枚未満です。');
  r.pools[p1.sessionId] = { units: sample(chars, 10), magics: sample(mags, 20) };
  r.pools[p2.sessionId] = { units: sample(chars, 10), magics: sample(mags, 20) };
  for (const p of [p1, p2]) {
    send(p.ws, 'pool_ready', {
      units: r.pools[p.sessionId].units.map(c => sanitizeCard(c, true)),
      magics: r.pools[p.sessionId].magics.map(c => sanitizeCard(c, true))
    });
  }
}

function finiteNumber(value, fallback=0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function hpSnapshot(unit) {
  const max = Math.max(1, finiteNumber(unit?.maxHp, 1));
  const current = Math.max(0, Math.min(max, finiteNumber(unit?.currentHp, max)));
  return { current, max };
}
function buildUnit(card, side, active) {
  const maxHp = Math.max(1, finiteNumber(card.stats?.hp, 1000));
  const atk = finiteNumber(card.stats?.atk, 100);
  const priority = finiteNumber(card.stats?.priority, 0);
  return {
    instanceId: uid('unit'),
    cardId: String(card.id),
    name: card.name,
    mainAttr: card.mainAttr,
    subAttrs: card.subAttrs || [],
    maxHp,
    currentHp:maxHp,
    atk,
    priority,
    skills: clone(card.skills || []),
    image: typeof card.image === 'string' ? card.image : (typeof card.imageUrl === 'string' ? card.imageUrl : null),
    side,
    isActive: !!active,
    buffs: [],
    debuffs: [],
    statuses: [],
    reservedAction: { type: 'attack', targetInstanceId: null }
  };
}
function battlePlayer(b, side) { return side === 'player1' ? b.p1 : b.p2; }
function activeUnits(b, side) { return battlePlayer(b, side).units.filter(u => u.isActive && u.currentHp > 0); }
function allUnits(b) { return [...b.p1.units, ...b.p2.units]; }
function effAtk(u) {
  let x = Number(u.atk || 0);
  for (const a of [...(u.buffs || []), ...(u.debuffs || [])]) {
    if (a.type === 'atk_ratio') x += Math.round(Number(u.atk || 0) * Number(a.val || 0) / 100);
    if (a.type === 'atk_val') x += Number(a.val || 0);
  }
  return x;
}
function effSpeed(u) {
  const base = Number(u.priority || 0) + [...(u.buffs || []), ...(u.debuffs || [])]
    .filter(x => x.type === 'speed')
    .reduce((a, x) => a + Number(x.val || 0), 0);
  return (u.statuses || []).some(x => x.type === 'slow' && x.duration > 0) ? Math.floor(base / 2) : base;
}
function damage(u, amount) {
  let cut = 0;
  for (const a of (u.buffs || [])) if (a.type === 'dmg_cut') cut = Math.max(cut, Number(a.val) || 0);
  const d = Math.max(0, Math.round(Number(amount || 0) * (1 - Math.min(100, cut) / 100)));
  const before = u.currentHp;
  u.currentHp = Math.max(0, u.currentHp - d);
  return { before, after: u.currentHp, damage: d };
}
function addStatus(t, s, isBuff) {
  const arr = isBuff ? (t.buffs || (t.buffs = [])) : (t.debuffs || (t.debuffs = []));
  const idx = s.stackable === false ? arr.findIndex(x => x.type === s.type) : -1;
  if (idx >= 0) arr[idx] = { ...arr[idx], ...s };
  else arr.push({ ...s, appliedTurn: s.appliedTurn ?? null });
}
function addAbnormality(t, status, duration, appliedTurn) {
  if (!t) return false;
  t.statuses = t.statuses || [];
  if (t.statuses.some(x => x.type === status && Number(x.duration) > 0)) return false;
  t.statuses.push({ type:status, duration:Math.max(1, Number(duration)||1), appliedTurn:appliedTurn ?? null });
  return true;
}
function hasStatus(t, status) { return !!(t?.statuses || []).some(x => x.type === status && Number(x.duration) > 0); }
function hasAnyStatus(t) { return !!(t?.statuses || []).some(x => Number(x.duration) > 0); }
function pushPassiveEvent(b, u, sk, result, target=null) {
  b.pendingEvents = b.pendingEvents || [];
  b.pendingEvents.push({ type:'PASSIVE_USE', actor:pubUnit(u,false), target:target && !target.__playerTarget ? pubUnit(target,false) : null, actionName:sk.name, effect:result || 'パッシブ効果', result:result || '発動', description:sk.desc || sk.description || '', cardId:u.cardId });
}
function triggerPassiveTiming(b, timing, subject=null) {
  b._passiveTriggerDepth = Number(b._passiveTriggerDepth||0) + 1;
  if (b._passiveTriggerDepth > 10) { b._passiveTriggerDepth--; return; }
  try {
    const candidates = [];
    for (const u of allUnits(b)) {
      if (u.currentHp <= 0 && timing !== 'death') continue;
      if (!u.isActive && timing !== 'death') continue;
      if (timing === 'death') { if (u !== subject) continue; }
      else if (timing === 'ally_death') { if (!subject || u.side !== subject.side || u === subject) continue; }
      else if (timing === 'hp_increase' || timing === 'hp_decrease') { if (u !== subject) continue; }
      candidates.push(u);
    }
    for (const u of candidates) {
      for (const sk of u.skills || []) {
        if (sk.type !== 'passive' || sk.timing !== timing || !evalCond(b, sk.selfCond, u)) continue;
        b._statusApplicationTiming = timing;
        const before = u.currentHp;
        const ts = targets(b,u,sk.targetType,sk.targetCond,sk.targetInstanceId);
        const lines=[];
        for (const t of ts) { const r=applyEffect(b,sk.mainEffect,t,u,false); if(r) lines.push(r); }
        if (sk.hasSubEffect && sk.subEffect) for (const t of targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond,sk.subEffect.targetInstanceId)) { const r=applyEffect(b,sk.subEffect,t,u,false); if(r) lines.push(r); }
        b._statusApplicationTiming = null;
        pushPassiveEvent(b,u,sk,lines.join('\n')||`HP ${before} → ${u.currentHp}`,ts[0]);
      }
    }
  } finally { b._statusApplicationTiming = null; b._passiveTriggerDepth--; }
}
function flushPendingEvents(r) {
  const b=r?.battle; if(!b?.pendingEvents?.length) return;
  const events=b.pendingEvents.splice(0);
  for (const ev of events) { b.events.push(ev); broadcastBattle(r,'battle_event',{event:ev}); }
}
function targetPool(b, actor, targetType) {
  const own = activeUnits(b, actor.side === 'player1' ? 'player1' : 'player2');
  const opp = activeUnits(b, actor.side === 'player1' ? 'player2' : 'player1');
  if (['select_enemy_1', 'random_enemy_1', 'all_enemy'].includes(targetType)) return opp;
  if (['select_ally_1', 'random_ally_1', 'all_ally'].includes(targetType)) return own;
  if (['all_field', 'random_all_1'].includes(targetType)) return [...own, ...opp];
  return [];
}
function matchesTarget(t, c) {
  if (!c || c.type === 'none') return true;
  if (c.type === 'hp_ratio_gte') return t.maxHp > 0 && t.currentHp / t.maxHp * 100 >= Number(c.val);
  if (c.type === 'hp_ratio_lte') return t.maxHp > 0 && t.currentHp / t.maxHp * 100 <= Number(c.val);
  if (c.type === 'attr_is') return t.mainAttr === c.attr || (t.subAttrs || []).includes(c.attr);
  if (c.type === 'attr_not') return !(t.mainAttr === c.attr || (t.subAttrs || []).includes(c.attr));
  return true;
}
function evalCond(b, cond, actor) {
  if (!cond || cond.type === 'none') return true;
  const isPlayer = actor.side === 'player1';
  const allies = activeUnits(b, actor.side);
  const enemies = activeUnits(b, isPlayer ? 'player2' : 'player1');
  if (cond.type === 'hp_ratio_gte') return actor.maxHp > 0 && actor.currentHp / actor.maxHp * 100 >= Number(cond.val);
  if (cond.type === 'hp_ratio_lte') return actor.maxHp > 0 && actor.currentHp / actor.maxHp * 100 <= Number(cond.val);
  if (cond.type === 'ap_val_gte') return (isPlayer ? b.p1 : b.p2).ap >= Number(cond.val);
  if (cond.type === 'ap_val_lte') return (isPlayer ? b.p1 : b.p2).ap <= Number(cond.val);
  if (cond.type === 'ally_has_attr') return allies.some(u => u !== actor && u.currentHp > 0 && (u.mainAttr === cond.attr || (u.subAttrs || []).includes(cond.attr)));
  if (cond.type === 'enemy_has_attr') return enemies.some(u => u.currentHp > 0 && (u.mainAttr === cond.attr || (u.subAttrs || []).includes(cond.attr)));
  if (cond.type === 'all_ally_attr') return allies.length > 0 && allies.every(u => u.mainAttr === cond.attr || (u.subAttrs || []).includes(cond.attr));
  if (cond.type === 'all_enemy_attr') return enemies.length > 0 && enemies.every(u => u.mainAttr === cond.attr || (u.subAttrs || []).includes(cond.attr));
  if (cond.type === 'turn_lte') return b.turn <= Number(cond.val);
  if (cond.type === 'turn_gte') return b.turn >= Number(cond.val);
  if (cond.type === 'self_status') return hasStatus(actor, cond.status);
  if (cond.type === 'self_any_status') return hasAnyStatus(actor);
  if (cond.type === 'ally_has_status') return allies.some(u => u !== actor && hasStatus(u, cond.status));
  if (cond.type === 'ally_has_any_status') return allies.some(u => u !== actor && hasAnyStatus(u));
  if (cond.type === 'enemy_has_status') return enemies.some(u => hasStatus(u, cond.status));
  if (cond.type === 'enemy_has_any_status') return enemies.some(u => hasAnyStatus(u));
  return true;
}
function targets(b, actor, type, cond, selected, isMagic=false) {
  if (type === 'player_self') return [{ __playerTarget: 'self', name: actor.side === 'player1' ? b.p1.name : b.p2.name }];
  if (type === 'player_opp') return [{ __playerTarget: 'opp', name: actor.side === 'player1' ? b.p2.name : b.p1.name }];
  if (type === 'self') return [actor];
  const pool = targetPool(b, actor, type).filter(t => matchesTarget(t, cond));
  if (!pool.length) return [];
  if (type === 'select_enemy_1' || type === 'select_ally_1') {
    const x = pool.find(t => t.instanceId === selected);
    return x ? [x] : (isMagic ? [pool[0]] : []);
  }
  if (type.startsWith('random_')) return [pool[crypto.randomInt(pool.length)]];
  return pool;
}
function applyEffect(b, eff, target, actor, isMagic=false) {
  if (!eff || eff.type === 'none' || !target) return null;
  if (eff.type === 'mod_ap') {
    const own = actor.side === 'player1' ? b.p1 : b.p2;
    const other = actor.side === 'player1' ? b.p2 : b.p1;
    const q = target.__playerTarget === 'opp' ? other : own;
    q.ap = Math.max(0, Math.min(100, q.ap + Number(eff.val || 0)));
    return `AP ${eff.val >= 0 ? '+' : ''}${eff.val}`;
  }
  if (target.__playerTarget) return null;
  const duration = Math.max(1, Number(eff.duration) || 1);
  const appliedTurn = b._statusApplicationTiming === 'battle_start' ? b.turn - 1 : b.turn;
  if (eff.type === 'dmg_atk_ratio') {
    if (isMagic) return null;
    const r = damage(target, Math.round(eff.val / 100 * effAtk(actor)));
    if (r.damage > 0) triggerPassiveTiming(b,'hp_decrease',target);
    if (target.currentHp <= 0 && r.before > 0) { triggerPassiveTiming(b,'death',target); triggerPassiveTiming(b,'ally_death',target); }
    return `${target.name}に${r.damage}ダメージ`;
  }
  if (eff.type === 'dmg_fixed') {
    const r = damage(target, Number(eff.val) || 0);
    if (r.damage > 0) triggerPassiveTiming(b,'hp_decrease',target);
    if (target.currentHp <= 0 && r.before > 0) { triggerPassiveTiming(b,'death',target); triggerPassiveTiming(b,'ally_death',target); }
    return `${target.name}に${r.damage}ダメージ`;
  }
  if (eff.type === 'heal_fixed' || eff.type === 'heal_max_hp_ratio') {
    if ((target.debuffs || []).some(x => x.type === 'heal_block' && x.duration > 0)) return '回復禁止中';
    const v = eff.type === 'heal_fixed' ? Number(eff.val) || 0 : Math.round(target.maxHp * Number(eff.val || 0) / 100);
    const before = target.currentHp;
    target.currentHp = Math.min(target.maxHp, target.currentHp + v);
    if (target.currentHp > before) triggerPassiveTiming(b,'hp_increase',target);
    return `${target.name}のHP +${target.currentHp - before}`;
  }
  if (eff.type === 'damage_cut_ratio') {
    addStatus(target, { type:'dmg_cut', val:Number(eff.val)||0, duration, source:Number(eff.val)>=0?'buff':'debuff', stackable:eff.stackable!==false, appliedTurn }, Number(eff.val)>=0);
    return `被ダメージ${eff.val}%カット`;
  }
  if (eff.type === 'mod_atk_ratio' || eff.type === 'mod_atk_val') {
    addStatus(target, { type:eff.type==='mod_atk_ratio'?'atk_ratio':'atk_val', val:Number(eff.val)||0, duration, source:Number(eff.val)>=0?'buff':'debuff', stackable:eff.stackable!==false, appliedTurn }, Number(eff.val)>=0);
    return `攻撃力 ${eff.val>=0?'+':''}${eff.val}${eff.type==='mod_atk_ratio'?'%':''}`;
  }
  if (eff.type === 'mod_speed') {
    addStatus(target, { type:'speed', val:Number(eff.val)||0, duration, source:Number(eff.val)>=0?'buff':'debuff', stackable:eff.stackable!==false, appliedTurn }, Number(eff.val)>=0);
    return `行動値 ${eff.val>=0?'+':''}${eff.val}`;
  }
  if (eff.type === 'clear_buffs') { target.buffs = []; return 'バフ全解除'; }
  if (eff.type === 'clear_debuffs') { target.debuffs = []; return 'デバフ全解除'; }
  if (eff.type === 'status_apply') {
    const ok = addAbnormality(target, eff.status || 'poison', duration, appliedTurn);
    const name = abnormalityName(eff.status || 'poison');
    return ok ? `${target.name}に${name}を${duration}ターン付与` : `${target.name}は既に${name}中`;
  }
  if (eff.type === 'status_remove') {
    target.statuses = (target.statuses || []).filter(x => x.type !== (eff.status || 'poison'));
    return `${target.name}の${abnormalityName(eff.status || 'poison')}を解除`;
  }
  if (eff.type === 'clear_statuses') { target.statuses = []; return `${target.name}の全状態異常を解除`; }
  if (eff.type === 'heal_block' || eff.type === 'skill_block') {
    addStatus(target, { type:eff.type, duration, source:'debuff', stackable:eff.stackable!==false, appliedTurn }, false);
    return eff.type === 'heal_block' ? `回復禁止${duration}ターン` : `スキル使用禁止${duration}ターン`;
  }
  return null;
}
function passiveOne(b, timing, u) {
  if (!u || u.currentHp <= 0 || !u.isActive) return;
  for (const sk of u.skills || []) {
    if (sk.type !== 'passive' || sk.timing !== timing || !evalCond(b, sk.selfCond, u)) continue;
    b._statusApplicationTiming = timing;
    const lines=[]; const ts=targets(b,u,sk.targetType,sk.targetCond,sk.targetInstanceId);
    for (const t of ts) { const r=applyEffect(b,sk.mainEffect,t,u,false); if(r) lines.push(r); }
    if (sk.hasSubEffect && sk.subEffect) for (const t of targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond,sk.subEffect.targetInstanceId)) { const r=applyEffect(b,sk.subEffect,t,u,false); if(r) lines.push(r); }
    b._statusApplicationTiming = null;
    pushPassiveEvent(b,u,sk,lines.join('\n')||'発動',ts[0]);
  }
}
function passive(b, timing) { for (const u of allUnits(b)) passiveOne(b, timing, u); }
function tickStatuses(b) {
  for (const u of allUnits(b)) {
    u.buffs = (u.buffs || []).map(x => ({...x, duration:Number(x.duration)-1})).filter(x => x.duration > 0);
    u.debuffs = (u.debuffs || []).map(x => ({...x, duration:Number(x.duration)-1})).filter(x => x.duration > 0);
    u.statuses = (u.statuses || []).map(x => ({...x, duration:Number(x.duration)-1})).filter(x => x.duration > 0);
  }
}
function processEndTurnAbnormalities(r) {
  const b=r.battle;
  for (const u of allUnits(b)) {
    if (u.currentHp <= 0 || !u.isActive) continue;
    if (hasStatus(u,'poison')) {
      const before=u.currentHp; const rmg=damage(u,Math.round(u.maxHp*0.10));
      const ev={type:'STATUS_DAMAGE',actor:pubUnit(u,false),target:pubUnit(u,false),actionName:'毒',effect:'最大HPの10%ダメージ',result:`毒により${rmg.damage}ダメージ${u.currentHp<=0?'／撃破！':''}`,description:'毒：ターン終了間際に最大HPの10%のダメージ。',targetHpBefore:{current:before,max:u.maxHp},targetHpAfter:{current:u.currentHp,max:u.maxHp}};
      b.events.push(ev); broadcastBattle(r,'battle_event',{event:ev});
      if(rmg.damage>0) triggerPassiveTiming(b,'hp_decrease',u);
      if(u.currentHp<=0 && before>0){ triggerPassiveTiming(b,'death',u); triggerPassiveTiming(b,'ally_death',u); flushPendingEvents(r); }
    }
  }
}

function replaceDead(b) {
  for (const side of ['player1','player2']) {
    const pl = battlePlayer(b, side);
    for (const u of pl.units.filter(x => x.isActive && x.currentHp <= 0)) {
      u.isActive = false;
      const id = pl.reserveQueue.shift();
      if (id) {
        const n = pl.units.find(x => x.cardId === id && !x.isActive && x.currentHp > 0);
        if (n) { n.isActive = true; passiveOne(b, 'deploy', n); }
      }
    }
  }
}
function pubUnit(u, includeImage=false) {
  const hp = hpSnapshot(u);
  const out = {
    instanceId:String(u.instanceId), cardId:String(u.cardId), name:String(u.name || ''), mainAttr:u.mainAttr || '', subAttrs:Array.isArray(u.subAttrs)?clone(u.subAttrs):[],
    maxHp:hp.max, currentHp:hp.current, atk:finiteNumber(u.atk,0), priority:finiteNumber(u.priority,0),
    effectiveAtk:finiteNumber(effAtk(u),0), effectiveSpeed:finiteNumber(effSpeed(u),0), side:u.side, isActive:!!u.isActive,
    buffs:clone(u.buffs || []), debuffs:clone(u.debuffs || []), statuses:clone(u.statuses || []),
    skills:clone(u.skills || [])
  };
  if (includeImage) out.image = typeof u.image === 'string' ? u.image : null;
  return out;
}
function publicMagicCards(pl, includeImage=false) {
  return (pl.magicIds || []).map(id => pl.magicCards?.[id]).filter(Boolean).map(c => {
    const x = sanitizeCard(c, true);
    if (!includeImage) { x.image = null; x.imageUrl = null; }
    return x;
  });
}
function publicBattle(b, viewerSide) {
  return {
    battleId:b.battleId, turn:b.turn, phase:b.phase, deadline:b.deadline,
    p1:{name:b.p1.name,ap:finiteNumber(b.p1.ap,0),units:b.p1.units.map(u=>pubUnit(u,false)),reserveQueue:[...b.p1.reserveQueue],magicIds:[...b.p1.magicIds],magicCards:publicMagicCards(b.p1,false),usedMagicIds:[...b.p1.usedMagic]},
    p2:{name:b.p2.name,ap:finiteNumber(b.p2.ap,0),units:b.p2.units.map(u=>pubUnit(u,false)),reserveQueue:[...b.p2.reserveQueue],magicIds:[...b.p2.magicIds],magicCards:publicMagicCards(b.p2,false),usedMagicIds:[...b.p2.usedMagic]},
    yourSide:viewerSide, winner:b.winner, events:(b.events || []).slice(-30)
  };
}
function publicBattleCards(b) {
  const map = new Map();
  for (const pl of [b?.p1,b?.p2]) {
    if (!pl) continue;
    for (const u of pl.units || []) {
      if (!u.cardId || map.has(String(u.cardId))) continue;
      map.set(String(u.cardId), sanitizeCard({
        id:u.cardId, cardType:'unit', name:u.name, mainAttr:u.mainAttr, subAttrs:u.subAttrs,
        stats:{hp:u.maxHp,atk:u.atk,priority:u.priority}, skills:u.skills || [], image:u.image || null
      }, true));
    }
    for (const id of pl.magicIds || []) {
      const c = pl.magicCards?.[id];
      if (!c || map.has(String(c.id))) continue;
      map.set(String(c.id), sanitizeCard(c, true));
    }
  }
  return [...map.values()].map(c=>{ if (!c) return c; c=clone(c); delete c.image; delete c.imageUrl; return c; });
}
function publicBattleAssets(b) {
  const map = new Map();
  for (const pl of [b?.p1,b?.p2]) {
    if (!pl) continue;
    for (const u of pl.units || []) if (u.cardId && typeof u.image === 'string' && u.image) map.set(String(u.cardId), {id:String(u.cardId), image:u.image});
    for (const id of pl.magicIds || []) { const c=pl.magicCards?.[id]; if (c?.id && typeof c.image==='string' && c.image) map.set(String(c.id), {id:String(c.id),image:c.image}); }
  }
  return [...map.values()];
}
function sendChunkedJson(ws, type, items, maxBytes=256*1024) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) { send(ws, type+'_end', {total:0}); return; }
  let batch=[], size=2, batchNo=0;
  const flush=()=>{
    if (!batch.length) return;
    send(ws,type,{items:batch,batch:batchNo,total:0});
    batchNo++; batch=[]; size=2;
  };
  for (const item of arr) {
    const n=Buffer.byteLength(JSON.stringify(item),'utf8');
    if (batch.length && size+n+32>maxBytes) flush();
    batch.push(item); size+=n+1;
  }
  flush();
  // Send the actual total in a second lightweight message so clients know completion.
  send(ws, type+'_end', {total:batchNo});
}
function sendBattleCards(r, ws, viewerSide) {
  if (!r?.battle || !ws) return;
  const cards=publicBattleCards(r.battle);
  const assets=publicBattleAssets(r.battle);
  send(ws,'battle_cards',{cards, viewerSide});
  sendChunkedJson(ws,'battle_assets',assets,256*1024);
}
function sendBattleSnapshot(r, ws, viewerSide, type='battle_state', extra={}) {
  if (!r?.battle || !ws) return;
  sendBattleCards(r,ws,viewerSide);
  send(ws,type,{...extra,state:publicBattle(r.battle,viewerSide)});
}

function buildBattleSide(r, sid, profile, selection, side) {
  const source = roomSourceForPlayer(r, sid, profile);
  const valid = validateBattleSelection(source, selection);
  if (!valid.ok) throw new Error(valid.error);
  const cards = selectedCardMap(source);
  const units = valid.unitIds.map(id => cards.get(id));
  const magicCards = {};
  for (const id of valid.magicIds) magicCards[id] = cards.get(id);
  return {
    sessionId:sid, name:profile.name, side, ap:0,
    units:units.map(c => buildUnit(c, side, valid.active.includes(c.id))),
    reserveQueue:[...valid.reserve],
    magicIds:[...valid.magicIds], magicCards, usedMagic:[], actions:null
  };
}
function getSelectionForPlayer(r, sid) { return r.selected[sid] || null; }
function startBattle(r) {
  const a = r.players[0], b = r.players[1];
  if (!a || !b) throw new Error('対戦相手がまだ入室していません。');
  const pa = r.profiles[a.sessionId], pb = r.profiles[b.sessionId];
  if (!pa || !pb) throw new Error('両者のカードデータ同期が完了していません。');
  const sa = getSelectionForPlayer(r, a.sessionId), sb = getSelectionForPlayer(r, b.sessionId);
  if (!sa || !sb) throw new Error('両者の出撃設定が完了していません。');
  const bstate = {
    battleId:uid('battle'), turn:1, phase:'decision', deadline:null, pausedForDisconnect:false, pausedRemainingMs:DECISION_MS,
    p1:buildBattleSide(r, a.sessionId, pa, sa, 'player1'),
    p2:buildBattleSide(r, b.sessionId, pb, sb, 'player2'), winner:null, events:[], timer:null,
    _statusApplicationTiming:null
  };
  r.status = 'battle';
  r.battle = bstate;
  passive(bstate, 'battle_start');
  for (const u of [...activeUnits(bstate, 'player1'), ...activeUnits(bstate, 'player2')]) passiveOne(bstate, 'deploy', u);
  for (const p of r.players.filter(Boolean)) {
    const side = p === r.players[0] ? 'player1' : 'player2';
    sendBattleSnapshot(r,p.ws,side,'battle_start');
  }
  for (const sid of r.spectators) {
    const s = sessions.get(sid); if (s?.ws) sendBattleSnapshot(r,s.ws,'spectator','battle_start');
  }
  scheduleDecision(r, DECISION_MS);
}
function broadcastBattle(r, type, extra={}) {
  for (const p of r.players.filter(Boolean)) {
    const side = p === r.players[0] ? 'player1' : 'player2';
    send(p.ws, type, {...extra, state:publicBattle(r.battle, side)});
  }
  for (const sid of r.spectators) {
    const s = sessions.get(sid); if (s?.ws) send(s.ws, type, {...extra, state:publicBattle(r.battle, 'spectator')});
  }
}
function checkWin(r, includeTurnLimit=false) {
  const b = r.battle;
  const aAlive = b.p1.units.filter(u => u.currentHp > 0).length;
  const cAlive = b.p2.units.filter(u => u.currentHp > 0).length;
  const a = aAlive > 0, c = cAlive > 0;
  if (!a && !c) b.winner = 'draw';
  else if (!a) b.winner = 'player2';
  else if (!c) b.winner = 'player1';
  else if (includeTurnLimit && b.turn >= 20 && b.phase === 'execution') {
    b.winner = aAlive > cAlive ? 'player1' : cAlive > aAlive ? 'player2' : 'draw';
    b.endReason = '20ターン経過時の生存キャラ数判定';
  }
}
function finishBattle(r, winner, reason=null) {
  if (!r?.battle) return;
  clearTimeout(r.battle.timer);
  r.battle.timer = null;
  r.battle.phase = 'finished';
  r.battle.deadline = null;
  r.battle.winner = winner;
  r.status = 'finished';
  broadcastBattle(r, 'battle_end', { winner, reason });
}
function forfeitBattle(r, sid, reason='プレイヤーが退出しました。') {
  if (!r?.battle) return;
  const slot = playerSlot(r, sid);
  if (slot < 0) return;
  finishBattle(r, slot === 0 ? 'player2' : 'player1', reason);
}
function pauseBattleForDisconnect(r, sid) {
  if (!r?.battle || r.battle.phase === 'finished') return;
  const pslot = playerSlot(r, sid);
  if (pslot < 0) return;
  if (r.battle.phase === 'decision') {
    clearTimeout(r.battle.timer);
    r.battle.pausedRemainingMs = Math.max(1000, (r.battle.deadline || Date.now()) - Date.now());
    r.battle.deadline = null;
    r.battle.phase = 'paused';
    r.battle.pausedForDisconnect = true;
    broadcastBattle(r, 'battle_paused', { reason:'対戦プレイヤーの接続待ちです。', remainingMs:r.battle.pausedRemainingMs });
  }
}
function resumeBattleAfterReconnect(r) {
  if (!r?.battle || !r.battle.pausedForDisconnect || !bothPlayersOnline(r)) return;
  const b = r.battle;
  const ms = Math.max(1000, Number(b.pausedRemainingMs || DECISION_MS));
  clearTimeout(b.timer);
  b.pausedForDisconnect = false;
  b.phase = 'decision';
  b.deadline = Date.now() + ms;
  b.timer = setTimeout(() => expireDecision(r), ms);
  // 再接続時は「新しいターン」ではないため、AP加算・行動リセットを行わない。
  broadcastBattle(r, 'battle_resumed', { remainingMs:ms });
  broadcastBattle(r, 'battle_state');
}
function scheduleDecision(r, duration=DECISION_MS) {
  const b = r.battle; if (!b) return;
  clearTimeout(b.timer);
  if (!bothPlayersOnline(r)) {
    b.phase = 'paused'; b.deadline = null; b.pausedForDisconnect = true; b.pausedRemainingMs = duration;
    broadcastBattle(r, 'battle_paused', { reason:'接続待ちのためタイマーを停止しています。', remainingMs:duration });
    return;
  }
  b.phase = 'decision';
  b.deadline = Date.now() + Math.max(1000, duration);
  b.pausedRemainingMs = Math.max(1000, duration);
  b.p1.ap = Math.min(100, b.p1.ap + 20);
  b.p2.ap = Math.min(100, b.p2.ap + 20);
  for (const u of allUnits(b)) if (u.currentHp > 0) u.reservedAction = {type:'attack',targetInstanceId:null};
  b.p1.actions = null; b.p2.actions = null;
  broadcastBattle(r, 'turn_start');
  b.timer = setTimeout(() => expireDecision(r), Math.max(0, b.deadline - Date.now()));
}
function chooseAutoForSide(b, side) {
  const pl = battlePlayer(b, side);
  let remaining = pl.ap;
  const actions = [];
  for (const u of activeUnits(b, side)) {
    let picked = {type:'attack', targetInstanceId:null};
    const blocked = (u.debuffs || []).some(x => x.type === 'skill_block' && x.duration > 0);
    if (!blocked) {
      for (let i=0; i<(u.skills || []).length; i++) {
        const sk = u.skills[i];
        const cost = Number(sk.cost || 0);
        if (sk.type !== 'active' || remaining < cost || !evalCond(b, sk.selfCond, u)) continue;
        const candidates = targets(b, u, sk.targetType, sk.targetCond, null);
        if ((sk.targetType === 'select_enemy_1' || sk.targetType === 'select_ally_1') && !candidates.length) continue;
        picked = {type:'skill', skillIndex:i, targetInstanceId:candidates[0]?.instanceId || null};
        remaining -= cost;
        break;
      }
    }
    actions.push({unitInstanceId:u.instanceId, ...picked});
  }
  let magicId = null, magicTargetInstanceId = null;
  const magicCandidates = pl.magicIds
    .filter(id => !pl.usedMagic.includes(id))
    .map(id => pl.magicCards[id])
    .filter(Boolean)
    .filter(card => Number(card.effect?.cost || 0) <= remaining)
    .filter(card => card.effect?.targetType !== 'player_opp' || true);
  if (magicCandidates.length) {
    const card = magicCandidates.find(c => c.effect?.targetType === 'player_self') || magicCandidates[0];
    magicId = card.id;
    if (['select_enemy_1','select_ally_1'].includes(card.effect?.targetType)) {
      const actor = {side, name:pl.name, currentHp:1, maxHp:1};
      const ts = targets(b, actor, card.effect.targetType, card.effect.targetCond, null, true);
      magicTargetInstanceId = ts[0]?.instanceId || null;
    }
  }
  return {units:actions, magicId, magicTargetInstanceId, actionId:uid('auto')};
}
function expireDecision(r) {
  const b = r?.battle;
  if (!b || b.phase !== 'decision' || b.pausedForDisconnect) return;
  for (const side of ['player1','player2']) {
    const pl = battlePlayer(b, side);
    if (!pl.actions) pl.actions = chooseAutoForSide(b, side);
  }
  try { executeTurn(r); }
  catch (err) {
    console.error('Battle timeout execution error:', err);
    b.phase = 'decision'; b.p1.actions = null; b.p2.actions = null;
    broadcastBattle(r, 'battle_error', { message:'自動行動処理でエラーが発生しました。行動を再入力してください。' });
    scheduleDecision(r);
  }
}
function validateActionSet(b, side, actions) {
  const pl = battlePlayer(b, side);
  const units = activeUnits(b, side);
  const byId = new Map(units.map(u => [u.instanceId, u]));
  const rawUnits = Array.isArray(actions.units) ? actions.units : [];
  const out = {units:[], magicId:null, magicTargetInstanceId:actions.magicTargetInstanceId || actions.magic?.targetInstanceId || null, actionId:actions.actionId || uid('action')};
  const seen = new Set();
  let totalCost = 0;
  for (const a of rawUnits) {
    const u = byId.get(a?.unitInstanceId);
    if (!u || seen.has(u.instanceId)) throw new Error('不正なキャラクター行動が含まれています。');
    seen.add(u.instanceId);
    if (a.type === 'attack') {
      if (a.targetInstanceId) {
        const opp = activeUnits(b, side === 'player1' ? 'player2' : 'player1');
        if (!opp.some(t => t.instanceId === a.targetInstanceId)) throw new Error('通常攻撃の対象が不正です。');
      }
      out.units.push({unitInstanceId:u.instanceId,type:'attack',targetInstanceId:a.targetInstanceId || null});
      continue;
    }
    if (a.type !== 'skill') throw new Error('不正な行動タイプです。');
    const sk = u.skills?.[Number(a.skillIndex)];
    if (!sk || sk.type !== 'active') throw new Error('存在しないスキルが指定されています。');
    if ((u.debuffs || []).some(x => x.type === 'skill_block' && x.duration > 0)) throw new Error(`「${u.name}」はスキル使用禁止中です。`);
    if (!evalCond(b, sk.selfCond, u)) throw new Error(`「${sk.name}」の発動条件を満たしていません。`);
    const cost = Number(sk.cost || 0);
    totalCost += cost;
    const pool = targetPool(b, u, sk.targetType).filter(t => matchesTarget(t, sk.targetCond));
    if (sk.targetType === 'select_enemy_1' || sk.targetType === 'select_ally_1') {
      if (!a.targetInstanceId || !pool.some(t => t.instanceId === a.targetInstanceId)) throw new Error(`「${sk.name}」の対象が不正です。`);
    }
    if (!pool.length && !['self','player_self','player_opp'].includes(sk.targetType)) throw new Error(`「${sk.name}」の対象が存在しません。`);
    out.units.push({unitInstanceId:u.instanceId,type:'skill',skillIndex:Number(a.skillIndex),targetInstanceId:a.targetInstanceId || null});
  }
  const magicId = actions.magicId || actions.magic?.id || null;
  if (magicId) {
    if (!pl.magicIds.includes(magicId)) throw new Error('そのマジックカードは使用できません。');
    if (pl.usedMagic.includes(magicId)) throw new Error('そのマジックカードはこの対戦ですでに使用済みです。');
    const card = pl.magicCards[magicId];
    if (!card) throw new Error('マジックカード情報がありません。');
    totalCost += Number(card.effect?.cost || 0);
    const eff = card.effect || {};
    const actor = {side, name:pl.name, currentHp:1, maxHp:1};
    const pool = targetPool(b, actor, eff.targetType).filter(t => matchesTarget(t, eff.targetCond));
    if ((eff.targetType === 'select_enemy_1' || eff.targetType === 'select_ally_1') && !out.magicTargetInstanceId) throw new Error(`「${card.name}」の対象を選択してください。`);
    if (out.magicTargetInstanceId && !pool.some(t => t.instanceId === out.magicTargetInstanceId)) throw new Error(`「${card.name}」の対象が不正です。`);
    if (!pool.length && !['player_self','player_opp','self'].includes(eff.targetType)) throw new Error(`「${card.name}」の対象が存在しません。`);
    out.magicId = magicId;
  } else if (out.magicTargetInstanceId) {
    throw new Error('マジック対象だけが指定されています。');
  }
  if (totalCost > pl.ap) throw new Error('APが不足しています。');
  return out;
}
function executeMagic(b, side, card, selectedTargetId=null) {
  const resource = side === 'player1' ? b.p1 : b.p2;
  const cost = Number(card.effect?.cost || 0);
  if (resource.ap < cost) return {type:'MAGIC_USE',actor:{side,name:resource.name},actionName:card.name,effect:'AP不足',result:'不発',description:card.desc || '',card:sanitizeCardNoImage(card,true),cardId:card.id};
  const actor = {side,name:resource.name,currentHp:1,maxHp:1};
  const eff = card.effect || {};
  const main = targets(b, actor, eff.targetType, eff.targetCond, selectedTargetId, true);
  if (['select_enemy_1','select_ally_1'].includes(eff.targetType) && !main.length) return {type:'MAGIC_USE',actor:{side,name:resource.name},actionName:card.name,effect:'指定対象なし',result:'不発',description:card.desc || '',card:sanitizeCardNoImage(card,true),cardId:card.id};
  resource.ap -= cost;
  const before = new Map(main.map(t => [t.instanceId,hpSnapshot(t)]));
  const lines = [];
  for (const t of main) { const r = applyEffect(b, eff.mainEffect, t, actor, true); if (r) lines.push(r); }
  if (eff.hasSubEffect && eff.subEffect) {
    const sub = targets(b, actor, eff.subEffect.targetType || eff.targetType, eff.subEffect.targetCond || eff.targetCond, selectedTargetId, true);
    for (const t of sub) { const r = applyEffect(b, eff.subEffect, t, actor, true); if (r) lines.push(r); }
  }
  const tar = main[0];
  return {
    type:'MAGIC_USE', actor:{side,name:resource.name},
    target:tar?pubUnit(tar,false):null, actionName:card.name,
    effect:lines.join('\n') || '効果なし', result:lines.join('\n') || '変化なし', description:card.desc || '',
    card:sanitizeCardNoImage(card,true), targetHpBefore:tar?before.get(tar.instanceId):null,
    targetHpAfter:tar?hpSnapshot(tar):null, cardId:card.id
  };
}
function executeAction(b, side, u, action) {
  const resource = side === 'player1' ? b.p1 : b.p2;
  if (hasStatus(u,'freeze') || (hasStatus(u,'paralysis') && crypto.randomInt(100) < 50)) {
    const status = hasStatus(u,'freeze') ? '凍結' : '麻痺';
    return {type:'STATUS_FAIL',actor:pubUnit(u,false),actionName:action.type==='skill' ? (u.skills?.[action.skillIndex]?.name || 'スキル') : '通常攻撃',effect:`${status}で行動失敗`,result:`${status}で行動失敗`,description:`${status}：行動に失敗します。`,cardId:u.cardId};
  }
  if (action.type === 'attack') {
    const enemies = activeUnits(b, side === 'player1' ? 'player2' : 'player1');
    if (!enemies.length) return null;
    const t = action.targetInstanceId && enemies.find(x => x.instanceId === action.targetInstanceId) || enemies[crypto.randomInt(enemies.length)];
    const hp = hpSnapshot(t);
    const r = damage(t, finiteNumber(effAtk(u),0));
    return {
      type:'CHARACTER_ATTACK', actor:pubUnit(u,false), target:pubUnit(t,false),
      actorHpBefore:hpSnapshot(u), actorHpAfter:hpSnapshot(u),
      targetHpBefore:hp, targetHpAfter:hpSnapshot(t),
      actionName:'通常攻撃', effect:`基礎攻撃力 ${effAtk(u)}`, result:`${r.damage} ダメージ${t.currentHp<=0?'／撃破！':''}`
    };
  }
  if (action.type !== 'skill') return null;
  const sk = u.skills?.[action.skillIndex];
  if (!sk) return null;
  if ((u.debuffs || []).some(x => x.type === 'skill_block' && x.duration > 0)) return {type:'SKILL_USE',actor:pubUnit(u,false),actionName:sk.name,effect:'スキル使用禁止',result:'不発',description:sk.desc || ''};
  const cost = Number(sk.cost || 0);
  if (resource.ap < cost) return {type:'SKILL_USE',actor:pubUnit(u,false),actionName:sk.name,effect:'AP不足',result:'不発',description:sk.desc || ''};
  const main = targets(b,u,sk.targetType,sk.targetCond,action.targetInstanceId,false);
  if (['select_enemy_1','select_ally_1'].includes(sk.targetType) && !main.length) return {type:'SKILL_USE',actor:pubUnit(u,false),actionName:sk.name,effect:'指定対象なし',result:'不発',description:sk.desc || ''};
  resource.ap -= cost;
  const before = new Map(main.map(t => [t.instanceId,hpSnapshot(t)]));
  const lines=[];
  for (const t of main) { const r=applyEffect(b,sk.mainEffect,t,u,false); if(r) lines.push(r); }
  if (sk.hasSubEffect && sk.subEffect) {
    const sub=targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond,sk.subEffect.targetInstanceId||action.targetInstanceId,false);
    for (const t of sub) { const r=applyEffect(b,sk.subEffect,t,u,false); if(r) lines.push(r); }
  }
  const tar=main[0];
  return {
    type:'SKILL_USE', actor:pubUnit(u,false), target:tar?pubUnit(tar,false):null,
    actionName:sk.name, effect:lines.join('\n')||'効果なし', result:lines.join('\n')||'変化なし', description:sk.desc || sk.description || '',
    actorHpBefore:hpSnapshot(u), actorHpAfter:hpSnapshot(u),
    targetHpBefore:tar?before.get(tar.instanceId):null, targetHpAfter:tar?hpSnapshot(tar):null,
    cardId:u.cardId
  };
}
function executeTurn(r) {
  const b = r.battle;
  if (!b || b.phase !== 'decision') return;
  clearTimeout(b.timer);
  b.phase = 'execution'; b.deadline = null;
  const pending = new Map();
  for (const side of ['player1','player2']) {
    const pl = battlePlayer(b, side);
    const actions = pl.actions || {units:[],magicId:null,magicTargetInstanceId:null};
    for (const a of actions.units || []) {
      const u = pl.units.find(x => x.instanceId === a.unitInstanceId); if (u) pending.set(u.instanceId, {side,u,a});
    }
    if (actions.magicId) {
      const card = pl.magicCards[actions.magicId];
      if (card) pending.set('magic_'+side, {side,magic:card,magicTargetInstanceId:actions.magicTargetInstanceId || null});
    }
  }
  while (pending.size && !b.winner) {
    const arr = [...pending.values()].filter(x => x.magic || (x.u && x.u.currentHp > 0 && x.u.isActive));
    if (!arr.length) break;
    arr.sort((x,y) => {
      const sx = x.magic ? Number(x.magic.stats?.priority ?? 999) : effSpeed(x.u);
      const sy = y.magic ? Number(y.magic.stats?.priority ?? 999) : effSpeed(y.u);
      return (sy - sx) || (crypto.randomInt(2) ? 1 : -1);
    });
    const x = arr[0];
    pending.delete(x.u ? x.u.instanceId : 'magic_'+x.side);
    const ev = x.magic ? executeMagic(b,x.side,x.magic,x.magicTargetInstanceId) : executeAction(b,x.side,x.u,x.a);
    if (x.magic) battlePlayer(b,x.side).usedMagic.push(x.magic.id);
    if (ev) { b.events.push(ev); broadcastBattle(r,'battle_event',{event:ev}); }
    flushPendingEvents(r);
    checkWin(r);
  }
  // マジックカード（最遅）の全処理が終わった後に毒、その後にターン終了パッシブ。
  processEndTurnAbnormalities(r);
  flushPendingEvents(r);
  passive(b,'turn_end');
  flushPendingEvents(r);
  tickStatuses(b);
  replaceDead(b);
  checkWin(r, true);
  if (b.winner) finishBattle(r,b.winner,b.endReason||null);
  else {
    b.turn += 1;
    scheduleDecision(r, DECISION_MS);
  }
}

function playerRoomRecovery(r, sid, ws) {
  const slot = playerSlot(r, sid);
  if (slot < 0) return false;
  const p = r.players[slot]; p.ws = ws; p.online = true; p.lastSeen = Date.now();
  const s = sessions.get(sid); if (s) s.roomId = r.roomId;
  send(ws, 'room_recovered', {
    room:publicRoom(r), slot, ready:!!p.ready, players:playerSummaries(r),
    selection:clone(r.selected[sid] || null), deckSelection:clone(r.deckSelections[sid] || null),
    rentalDecks:r.rule==='rental' ? (r.profiles[r.ownerId]?.decks || []) : [],
    deploymentOptions:deploymentOptionsForPlayer(r,sid)
  });
  if (r.battle) sendBattleSnapshot(r, ws, slot===0?'player1':'player2', 'battle_state');
  return true;
}
function spectatorRecovery(r, sid, ws) {
  if (!r.spectators.has(sid)) return false;
  const s = sessions.get(sid); if (s) { s.ws = ws; s.online = true; s.lastSeen = Date.now(); s.roomId = r.roomId; }
  send(ws,'spectate_recovered',{room:publicRoom(r)});
  if (r.battle) sendBattleSnapshot(r, ws, 'spectator', 'battle_state');
  return true;
}

const server = http.createServer((req,res) => {
  if (req.url === '/') {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-store'});
    res.end(fs.readFileSync(CLIENT)); return;
  }
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,version:SERVER_VERSION,rooms:rooms.size,serverTime:Date.now()})); return;
  }
  res.writeHead(404); res.end('Not found');
});

server.on('upgrade',(req,socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const ws = acceptWebSocket(socket);
  let sid = null;

  ws.on('wsmessage', raw => {
    let m; try { m = JSON.parse(raw); } catch { return send(ws,'error',{code:'BAD_JSON',message:'通信データが不正です。'}); }
    const type = String(m.type || '');

    if (type === 'hello') {
      sid = safeName(m.sessionId || uid('session'), uid('session'), 120);
      const existing = sessions.get(sid);
      const s = existing || {sessionId:sid,name:safeName(m.name),ws,roomId:null,profile:null,online:true,lastSeen:Date.now()};
      s.name = safeName(m.name, s.name); s.ws = ws; s.online = true; s.lastSeen = Date.now(); sessions.set(sid,s);
      send(ws,'hello',{sessionId:sid,serverVersion:SERVER_VERSION});
      send(ws,'room_list',{rooms:[...rooms.values()].filter(r=>r.status!=='closed').map(publicRoom)});
      const rr = s.roomId ? rooms.get(s.roomId) : null;
      if (rr && playerRoomRecovery(rr,sid,ws)) {
        resumeBattleAfterReconnect(rr);
      } else if (rr && spectatorRecovery(rr,sid,ws)) {
        // 観戦者の復帰では対戦を再開しない。
      } else if (rr) {
        s.roomId = null;
      }
      return;
    }
    if (!sid) return send(ws,'error',{code:'NO_SESSION',message:'オンラインセッションを初期化できません。ページを再読み込みしてください。'});
    const s = sessions.get(sid);
    if (!s) return send(ws,'error',{code:'NO_SESSION',message:'オンラインセッションが見つかりません。'});
    s.ws = ws; s.online = true; s.lastSeen = Date.now();

    if (type === 'room_list') {
      return send(ws,'room_list',{rooms:[...rooms.values()].filter(r=>r.status!=='closed').map(publicRoom)});
    }

    if (type === 'profile_sync') {
      s.profile = normalizeProfile(m, s.name);
      setProfileAssetExpectations(s, m.assetIds || []);
      for (const c of s.profile.cards) {
        if (typeof c.image === 'string' && c.image) s.profileAssetReceived.add(String(c.id));
      }
      const r = roomBySession(sid);
      markAssetReadyForRoom(r, sid);
      if (r) r.profiles[sid] = clone(s.profile);
      if (r?.rule === 'rental' && r.ownerId === sid) broadcastRoom(r,'rental_decks',{decks:r.profiles[sid]?.decks||[]});
      if (r) { for (const p of r.players.filter(Boolean)) if (r.deckSelections[p.sessionId]) sendDeploymentOptions(r,p.sessionId); }
      if (r) maybeStartBattle(r);
      return;
    }

    if (type === 'profile_assets') {
      const assets = Array.isArray(m.assets) ? m.assets : [];
      const count = mergeProfileAssets(s, assets);
      markProfileAssetsReceived(s, assets.map(a => a?.id));
      const r = roomBySession(sid);
      if (r) r.profiles[sid] = clone(s.profile);
      markAssetReadyForRoom(r, sid);
      const ready = profileAssetsReady(s);
      const done = ready || (Number(m.batch||0) + 1 >= Number(m.total||1));
      send(ws,'profile_assets_ack',{done,batch:Number(m.batch||0),total:Number(m.total||1),count,ready});
      if (r?.rule === 'rental' && r.ownerId === sid) broadcastRoom(r,'rental_decks',{decks:r.profiles[sid]?.decks||[]});
      if (r) {
        for (const p of r.players.filter(Boolean)) {
          if (r.deckSelections[p.sessionId]) sendDeploymentOptions(r,p.sessionId);
        }
      }
      if (r && ready) maybeStartBattle(r);
      return;
    }

    if (type === 'room_create') {
      if (roomBySession(sid)) return send(ws,'error',{code:'ALREADY_IN_ROOM',message:'すでに別の部屋に参加しています。'});
      if (m.profile) { s.profile = normalizeProfile(m.profile, s.name); setProfileAssetExpectations(s, m.profile.assetIds || []); for (const c of s.profile.cards) if (typeof c.image === 'string' && c.image) s.profileAssetReceived.add(String(c.id)); }
      if (!s.profile) return send(ws,'error',{code:'PROFILE_NOT_READY',message:'カードデータの同期が完了していません。'});
      const r = createRoom(s,{roomName:m.roomName,password:m.password,rule:m.rule,allowSpectators:m.allowSpectators,maxSpectators:m.maxSpectators});
      copySessionProfileToRoom(r,s);
      send(ws,'room_joined',{room:publicRoom(r),slot:0,myDecks:s.profile.decks||[],rentalDecks:r.rule==='rental' ? (r.profiles[r.ownerId]?.decks||[]) : []});
      broadcastPlayers(r);
      return;
    }

    if (type === 'room_join') {
      const r = rooms.get(String(m.roomId||''));
      if (!r) return send(ws,'error',{code:'ROOM_NOT_FOUND',message:'部屋がありません。'});
      if (!['waiting','preparing'].includes(r.status)) return send(ws,'error',{code:'ROOM_NOT_JOINABLE',message:'現在この部屋には入室できません。'});
      const current = roomBySession(sid);
      if (current && current.roomId !== r.roomId) return send(ws,'error',{code:'ALREADY_IN_ROOM',message:'すでに別の部屋に参加しています。'});
      if (r.passwordHash && hashPassword(m.password)!==r.passwordHash) return send(ws,'error',{code:'BAD_PASSWORD',message:'パスワードが違います。'});
      if (m.profile) { s.profile = normalizeProfile(m.profile,s.name); setProfileAssetExpectations(s, m.profile.assetIds || []); for (const c of s.profile.cards) if (typeof c.image === 'string' && c.image) s.profileAssetReceived.add(String(c.id)); }
      if (!s.profile) return send(ws,'error',{code:'PROFILE_NOT_READY',message:'カードデータの同期が完了していません。'});
      const existingIdx = playerSlot(r,sid);
      let idx = existingIdx;
      if (idx < 0) {
        idx = r.players.findIndex(p=>!p);
        if (idx < 0) return send(ws,'error',{code:'FULL',message:'対戦枠が満員です。'});
        r.players[idx] = {sessionId:sid,name:s.name,ws,ready:false,online:true,lastSeen:Date.now(),assetsReady:profileAssetsReady(s)};
      } else {
        r.players[idx].ws = ws; r.players[idx].online = true; r.players[idx].lastSeen = Date.now(); r.players[idx].assetsReady = profileAssetsReady(s);
      }
      setSessionRoom(sid,r.roomId); copySessionProfileToRoom(r,s);
      r.updatedAt = Date.now();
      send(ws,'room_joined',{room:publicRoom(r),slot:idx,myDecks:s.profile.decks||[],rentalDecks:r.rule==='rental' ? (r.profiles[r.ownerId]?.decks||[]) : []});
      if (r.rule==='rental' && r.ownerId===r.players[0]?.sessionId) broadcastRoom(r,'rental_decks',{decks:r.profiles[r.ownerId]?.decks||[]});
      broadcastPlayers(r);
      return;
    }

    if (type === 'spectate_join') {
      const r = rooms.get(String(m.roomId||''));
      if (!r || !r.allowSpectators) return send(ws,'error',{code:'SPECTATE_DISABLED',message:'観戦できません。'});
      if (r.status !== 'battle' && r.status !== 'finished') return send(ws,'error',{code:'NOT_IN_BATTLE',message:'現在観戦できる対戦がありません。'});
      if (r.spectators.size >= r.maxSpectators) return send(ws,'error',{code:'SPECTATOR_FULL',message:'観戦人数が上限です。'});
      const current = roomBySession(sid);
      if (current && current.roomId !== r.roomId) return send(ws,'error',{code:'ALREADY_IN_ROOM',message:'すでに別の部屋に参加しています。'});
      if (isPlayer(r,sid)) return send(ws,'error',{code:'ALREADY_PLAYER',message:'プレイヤーは観戦者になれません。'});
      if (r.passwordHash && hashPassword(m.password)!==r.passwordHash) return send(ws,'error',{code:'BAD_PASSWORD',message:'パスワードが違います。'});
      r.spectators.add(sid); setSessionRoom(sid,r.roomId); s.ws=ws; s.online=true; s.lastSeen=Date.now();
      send(ws,'spectate_joined',{room:publicRoom(r)});
      if (r.battle) sendBattleSnapshot(r, ws, 'spectator', 'battle_state');
      broadcastPlayers(r);
      return;
    }

    const r = roomBySession(sid);
    if (!r && type !== 'room_leave') return send(ws,'error',{code:'NOT_IN_ROOM',message:'部屋に参加していません。'});

    if (type === 'room_leave') {
      if (!r) return send(ws,'left_room');
      if (isSpectator(r,sid)) {
        r.spectators.delete(sid); setSessionRoom(sid,null); send(ws,'left_room'); broadcastPlayers(r); return;
      }
      if (r.battle && playerSlot(r,sid)>=0) {
        const slot = playerSlot(r,sid);
        if (slot >= 0 && r.players[slot]) r.players[slot].online = false;
        forfeitBattle(r,sid,'プレイヤーが退出したため敗北しました。');
        setSessionRoom(sid,null); send(ws,'left_room'); broadcastPlayers(r); return;
      }
      const idx = playerSlot(r,sid);
      if (idx < 0) return send(ws,'left_room');
      if (r.ownerId === sid) {
        r.status='closed'; r.players[idx]=null; rooms.delete(r.roomId); setSessionRoom(sid,null);
        broadcastRoom(r,'room_closed',{reason:'部屋作成者が退出しました。'}); send(ws,'left_room'); return;
      }
      r.players[idx]=null; r.deckSelections[sid]=undefined; r.selected[sid]=undefined; r.pools[sid]=undefined; setSessionRoom(sid,null); r.status='waiting'; r.updatedAt=Date.now();
      send(ws,'left_room'); broadcastPlayers(r); return;
    }

    if (type === 'deck_select') {
      if (r.battle) return send(ws,'error',{code:'BATTLE_STARTED',message:'対戦開始後はデッキを変更できません。'});
      if (r.rule === 'super_rental' || r.rule === 'random_pot') return send(ws,'error',{code:'NO_DECK_SELECT',message:'このルールではデッキ選択は不要です。サーバーが候補カードを抽選します。'});
      const p = r.players.find(x=>x?.sessionId===sid); if (!p) return send(ws,'error',{code:'NOT_PLAYER',message:'プレイヤー枠がありません。'});
      const requested = String(m.deckId||'');
      const sourceProfile = r.rule==='rental' ? r.profiles[r.ownerId] : s.profile;
      const deck = (sourceProfile?.decks||[]).find(d=>d.id===requested);
      const valid = validateDeckForProfile(sourceProfile,deck);
      if (!valid.ok) return send(ws,'error',{code:'INVALID_DECK',message:valid.error});
      const cleanDeck = sanitizeDeck(deck);
      cleanDeck.unitIds=valid.unitIds; cleanDeck.magicIds=valid.magicIds;
      r.deckSelections[sid]=cleanDeck;
      r.selected[sid]=null;
      r.pools={};
      for (const q of r.players.filter(Boolean)) q.ready=false;
      r.status='waiting'; r.updatedAt=Date.now();
      sendDeploymentOptions(r,sid);
      broadcastPlayers(r);
      return;
    }

    if (type === 'battle_select') {
      if (!r.players.some(p=>p?.sessionId===sid)) return send(ws,'error',{code:'NOT_PLAYER',message:'プレイヤーではありません。'});
      if (r.battle) return send(ws,'error',{code:'BATTLE_STARTED',message:'すでに対戦が始まっています。'});
      const source = roomSourceForPlayer(r,sid);
      if (!source.length) return send(ws,'error',{code:'NO_SOURCE',message:'選択可能なカード情報がありません。'});
      const validated = validateBattleSelection(source,m.selection||{});
      if (!validated.ok) return send(ws,'error',{code:'INVALID_SELECTION',message:validated.error});
      if ((r.rule==='unlimited'||r.rule==='rental') && !r.deckSelections[sid]) return send(ws,'error',{code:'NO_DECK',message:'先に使用デッキを選択してください。'});
      if (r.rule!=='super_rental' && r.rule!=='random_pot') {
        const deck = r.deckSelections[sid];
        const deckUnitIds = new Set(deck.unitIds); const deckMagicIds = new Set(deck.magicIds);
        if (!validated.unitIds.every(id=>deckUnitIds.has(id)) || !validated.magicIds.every(id=>deckMagicIds.has(id))) return send(ws,'error',{code:'OUTSIDE_DECK',message:'選択したカードが使用デッキに含まれていません。'});
      } else {
        const pool = r.pools[sid];
        if (!pool) return send(ws,'error',{code:'NO_POOL',message:'候補カードの抽選がまだ完了していません。'});
        const unitSet = new Set(pool.units.map(c=>String(c.id))), magicSet = new Set(pool.magics.map(c=>String(c.id)));
        if (!validated.unitIds.every(id=>unitSet.has(id)) || !validated.magicIds.every(id=>magicSet.has(id))) return send(ws,'error',{code:'OUTSIDE_POOL',message:'候補カードに含まれないカードが指定されています。'});
      }
      r.selected[sid]={...validated, deployConfirmed:true};
      send(ws,'battle_selection_confirmed',{selection:clone(r.selected[sid])});
      if (r.players.length===2 && r.players.every(Boolean) && r.players.every(p=>p.ready) && r.selected[r.players[0].sessionId] && r.selected[r.players[1].sessionId]) {
        maybeStartBattle(r);
      }
      return;
    }

    if (type === 'room_ready') {
      const p = r.players.find(x=>x?.sessionId===sid); if (!p) return send(ws,'error',{code:'NOT_PLAYER',message:'プレイヤーではありません。'});
      if (r.battle) return send(ws,'error',{code:'BATTLE_STARTED',message:'すでに対戦中です。'});
      if (m.ready) {
        if ((r.rule==='unlimited'||r.rule==='rental') && (!r.deckSelections[sid] || !r.selected[sid])) return send(ws,'error',{code:'NOT_DEPLOYED',message:'使用デッキを選び、出撃メンバーを確定してください。'});
      }
      p.ready=!!m.ready; r.updatedAt=Date.now();
      if (!m.ready) {
        if (r.rule==='super_rental'||r.rule==='random_pot') { r.pools={}; r.selected={}; }
        r.status='waiting';
      }
      if (r.players.every(Boolean) && r.players.every(x=>x.ready)) {
        if (r.rule==='super_rental'||r.rule==='random_pot') {
          if (!r.pools[r.players[0].sessionId] || !r.pools[r.players[1].sessionId]) {
            try { r.status='preparing'; prepareCandidatePools(r); } catch (err) { r.status='waiting'; for (const q of r.players) q.ready=false; broadcastRoom(r,'error',{code:'POOL_FAILED',message:err.message}); }
          } else {
            r.status='preparing';
          }
        } else {
          r.status='preparing';
          if (r.selected[r.players[0].sessionId] && r.selected[r.players[1].sessionId]) {
            maybeStartBattle(r);
          }
        }
      }
      broadcastPlayers(r);
      return;
    }

    if (type === 'submit_actions') {
      if (!r.battle || r.battle.phase !== 'decision') return send(ws,'error',{code:'NOT_DECISION',message:'現在は行動入力を受け付けていません。'});
      const p = r.players.find(x=>x?.sessionId===sid); if (!p || !p.online) return send(ws,'error',{code:'OFFLINE_PLAYER',message:'現在の接続状態では行動を送信できません。'});
      if (String(m.battleId || '') !== String(r.battle.battleId || '')) return send(ws,'error',{code:'STALE_BATTLE',message:'古い対戦情報です。現在の対戦状態を再取得してください。'});
      if (Number(m.turn) !== Number(r.battle.turn)) return send(ws,'error',{code:'STALE_TURN',message:'古いターンの行動です。現在のターンで再入力してください。'});
      if (Date.now() >= (r.battle.deadline || Infinity)) return expireDecision(r);
      const side = p === r.players[0] ? 'player1' : 'player2';
      const pl = battlePlayer(r.battle,side);
      if (pl.actions?.actionId === m.actionId) return;
      try {
        pl.actions = validateActionSet(r.battle,side,m.actions||{});
      } catch (err) {
        return send(ws,'battle_error',{code:'INVALID_ACTION',message:err.message});
      }
      broadcastBattle(r,'action_confirmed',{playerId:sid,ready:true});
      if (r.battle.p1.actions && r.battle.p2.actions) {
        try { executeTurn(r); }
        catch (err) {
          console.error('Battle execution error:',err);
          r.battle.phase='decision'; r.battle.p1.actions=null; r.battle.p2.actions=null;
          broadcastBattle(r,'battle_error',{code:'EXECUTION_ERROR',message:'戦闘処理中にエラーが発生しました。行動をリセットして再開します。'});
          scheduleDecision(r);
        }
      }
      return;
    }

    if (type === 'battle_state') {
      if (!r.battle) return;
      const p = r.players.find(x=>x?.sessionId===sid);
      const side = p===r.players[0] ? 'player1' : p===r.players[1] ? 'player2' : 'spectator';
      sendBattleSnapshot(r, ws, side, 'battle_state');
      return;
    }
  });

  ws.on('close',()=>{
    if (!sid) return;
    const s = sessions.get(sid); if (!s) return;
    if (s.ws !== ws) return;
    s.online=false; s.lastSeen=Date.now();
    const r = roomBySession(sid); if (!r) return;
    if (isSpectator(r,sid)) {
      r.spectators.delete(sid); s.roomId=null; broadcastPlayers(r); return;
    }
    const slot = playerSlot(r,sid); if (slot < 0) return;
    const p = r.players[slot]; p.online=false; p.lastSeen=Date.now();
    if (r.battle) pauseBattleForDisconnect(r,sid);
    broadcastRoom(r,'player_disconnected',{playerId:sid});
    broadcastPlayers(r);
  });
});

setInterval(()=>{
  const now=Date.now();
  for (const [sid,s] of sessions) if (!s.online && now-s.lastSeen > 10*60*1000) sessions.delete(sid);
  for (const [rid,r] of rooms) {
    if (r.status==='finished' && now-r.updatedAt > 30*60*1000) { clearTimeout(r.timer); rooms.delete(rid); }
  }
},60_000);

server.listen(PORT,()=>console.log(`Card AI Battle Online v${SERVER_VERSION}: http://localhost:${PORT}`));
