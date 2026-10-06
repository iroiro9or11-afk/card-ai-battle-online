const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const CLIENT = path.join(__dirname, '..', 'client', 'index.html');
const rooms = new Map();
const sessions = new Map();

function uid(prefix='id'){ return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`; }
function hashPassword(v){ return v ? crypto.createHash('sha256').update(String(v)).digest('hex') : ''; }
function safeName(v, fallback='プレイヤー'){ return String(v||fallback).slice(0,40); }
function publicRoom(r){ return {roomId:r.roomId,roomName:r.roomName,ownerName:r.ownerName,rule:r.rule,status:r.status,players:r.players.filter(Boolean).length,spectators:r.spectators.size,password:!!r.passwordHash,maxSpectators:r.maxSpectators}; }
function wsSend(ws, data){ if(!ws || ws.destroyed) return; const buf=Buffer.from(typeof data==='string'?data:JSON.stringify(data)); let head;if(buf.length<126)head=Buffer.from([0x81,buf.length]);else if(buf.length<65536){head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(buf.length,2);}else{head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(buf.length),2);}ws.write(Buffer.concat([head,buf])); }
function send(ws,type,payload={}){ if(ws && !ws.destroyed) wsSend(ws,JSON.stringify({type,...payload})); }
function acceptWebSocket(socket){socket.on('error',()=>{});socket.readyState=1;socket.destroyed=false;let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=2){const b0=buffer[0],b1=buffer[1],masked=!!(b1&0x80);let len=b1&0x7f,off=2;if(len===126){if(buffer.length<4)break;len=buffer.readUInt16BE(2);off=4;}else if(len===127){if(buffer.length<10)break;len=Number(buffer.readBigUInt64BE(2));off=10;}const need=off+(masked?4:0)+len;if(buffer.length<need)break;let mask=null;if(masked){mask=buffer.subarray(off,off+4);off+=4;}const payload=Buffer.from(buffer.subarray(off,off+len));buffer=buffer.subarray(need);if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];if((b0&0x0f)===0x8){socket.end();return;}if((b0&0x0f)===0x9){const h=Buffer.from([0x8a,payload.length]);socket.write(Buffer.concat([h,payload]));continue;}if((b0&0x0f)===0x1){socket.emit('wsmessage',payload.toString('utf8'));}}});socket.on('close',()=>{socket.destroyed=true;});return socket;}
function broadcastRoom(r,type,payload){ for(const p of r.players.filter(Boolean)) send(p.ws,type,payload); for(const id of r.spectators){ const s=sessions.get(id); if(s?.ws) send(s.ws,type,payload); } }
function roomBySession(sid){ const s=sessions.get(sid); return s?.roomId ? rooms.get(s.roomId) : null; }
function allSockets(r){ return [...r.players.filter(Boolean).map(p=>p.ws), ...[...r.spectators].map(id=>sessions.get(id)?.ws).filter(Boolean)]; }

function sanitizeCard(c, includePrivate=false){
  if(!c) return null;
  const base={id:c.id,cardType:c.cardType,name:c.name,mainAttr:c.mainAttr,subAttrs:c.subAttrs||[],stats:c.stats||{},image:typeof c.image==='string'?c.image:null,imageUrl:typeof c.imageUrl==='string'?c.imageUrl:null};
  if(includePrivate){ base.skills=c.skills||[]; base.effect=c.effect||null; base.desc=c.desc||c.description||''; }
  return base;
}
function sanitizeDeck(d){ return d ? {id:d.id,name:d.name,unitIds:d.unitIds||[],magicIds:d.magicIds||[]} : null; }
function uniqueById(arr){ const m=new Map(); for(const x of arr||[]) if(x?.id && !m.has(x.id)) m.set(x.id,x); return [...m.values()]; }
function sample(arr,n){ const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];} return a.slice(0,n); }

function copySessionProfileToRoom(r,s){ if(s?.profile) r.profiles[s.sessionId]=JSON.parse(JSON.stringify(s.profile)); }
function createRoom(owner, cfg){
  const room={roomId:uid('room'),roomName:safeName(cfg.roomName,'カードバトル'),ownerId:owner.sessionId,ownerName:owner.name,passwordHash:hashPassword(cfg.password),rule:['unlimited','rental','super_rental','random_pot'].includes(cfg.rule)?cfg.rule:'unlimited',allowSpectators:cfg.allowSpectators!==false,maxSpectators:Math.max(0,Math.min(50,Number(cfg.maxSpectators)||10)),status:'waiting',players:[null,null],spectators:new Set(),profiles:{},selected:{},pools:{},battle:null,createdAt:Date.now(),updatedAt:Date.now()};
  room.players[0]={sessionId:owner.sessionId,name:owner.name,ws:owner.ws,ready:false,online:true,lastSeen:Date.now()}; rooms.set(room.roomId,room); owner.roomId=room.roomId; return room;
}
function joinPlayer(r,sid,ws,password){
  if(r.passwordHash && hashPassword(password)!==r.passwordHash) return {ok:false,error:'パスワードが違います。'};
  const idx=r.players.findIndex(p=>p?.sessionId===sid); if(idx>=0){r.players[idx].ws=ws;r.players[idx].online=true;return {ok:true,index:idx};}
  const slot=r.players.findIndex(p=>!p); if(slot<0)return {ok:false,error:'対戦枠が満員です。'};
  r.players[slot]={sessionId:sid,name:sessions.get(sid).name,ws,ready:false,online:true,lastSeen:Date.now()}; sessions.get(sid).roomId=r.roomId; r.updatedAt=Date.now(); return {ok:true,index:slot};
}
function leaveRoom(sid){ const r=roomBySession(sid); if(!r)return; const s=sessions.get(sid); if(r.battle && r.players.some(p=>p?.sessionId===sid)){ const p=r.players.find(p=>p?.sessionId===sid); if(p){p.online=false;p.lastSeen=Date.now();} broadcastRoom(r,'player_disconnected',{playerId:sid}); return; } r.players=r.players.map(p=>p?.sessionId===sid?null:p); r.spectators.delete(sid); if(r.ownerId===sid){r.status='closed';broadcastRoom(r,'room_closed',{reason:'部屋作成者が退出しました。'});rooms.delete(r.roomId);return;} if(s) s.roomId=null; broadcastRoom(r,'room_update',{room:publicRoom(r),players:r.players.map(p=>p?{playerId:p.sessionId,name:p.name,ready:p.ready,online:p.online}:null)}); }

function buildUnit(card,side,active){ return {instanceId:uid('unit'),cardId:card.id,name:card.name,mainAttr:card.mainAttr,subAttrs:card.subAttrs||[],maxHp:Number(card.stats?.hp||1000),currentHp:Number(card.stats?.hp||1000),atk:Number(card.stats?.atk||100),priority:Number(card.stats?.priority||0),skills:JSON.parse(JSON.stringify(card.skills||[])),image:typeof card.image==='string'?card.image:(typeof card.imageUrl==='string'?card.imageUrl:null),side,isActive:!!active,buffs:[],debuffs:[],reservedAction:{type:'attack',targetInstanceId:null}}; }
function battlePlayer(b,side){return side==='player1'?b.p1:b.p2;}
function activeUnits(b,side){return battlePlayer(b,side).units.filter(u=>u.isActive&&u.currentHp>0);}
function allUnits(b){return [...b.p1.units,...b.p2.units];}
function effAtk(u){let x=u.atk;for(const a of [...u.buffs,...u.debuffs]){if(a.type==='atk_ratio')x+=Math.round(u.atk*a.val/100);if(a.type==='atk_val')x+=a.val;}return Math.max(100,x);}
function effSpeed(u){return u.priority+[...u.buffs,...u.debuffs].filter(x=>x.type==='speed').reduce((a,x)=>a+x.val,0);}
function damage(u,amount){let cut=0;for(const a of (u.buffs||[]))if(a.type==='dmg_cut')cut=Math.max(cut,Number(a.val)||0);const d=Math.max(0,Math.round(amount*(1-cut/100)));const before=u.currentHp;u.currentHp=Math.max(0,u.currentHp-d);return {before,after:u.currentHp,damage:d};}
function addStatus(t,s,isBuff){const arr=isBuff?(t.buffs||(t.buffs=[])):(t.debuffs||(t.debuffs=[]));const idx=s.stackable===false?arr.findIndex(x=>x.type===s.type):-1;if(idx>=0)arr[idx]={...arr[idx],...s};else arr.push({...s,appliedTurn:s.appliedTurn??null});}
function targetPool(b,actor,targetType){const own=activeUnits(b,actor.side==='player1'?'player1':'player2'), opp=activeUnits(b,actor.side==='player1'?'player2':'player1');if(['select_enemy_1','random_enemy_1','all_enemy'].includes(targetType))return opp;if(['select_ally_1','random_ally_1','all_ally'].includes(targetType))return own;if(['all_field','random_all_1'].includes(targetType))return [...own,...opp];return [];}
function matches(t,c){if(!c||c.type==='none')return true;if(c.type==='hp_ratio_gte')return t.currentHp/t.maxHp*100>=c.val;if(c.type==='hp_ratio_lte')return t.currentHp/t.maxHp*100<=c.val;if(c.type==='attr_is')return t.mainAttr===c.attr||(t.subAttrs||[]).includes(c.attr);if(c.type==='attr_not')return !(t.mainAttr===c.attr||(t.subAttrs||[]).includes(c.attr));return true;}
function evalCond(b,cond,actor){if(!cond||cond.type==='none')return true;const isPlayer=actor.side==='player1';const allies=activeUnits(b,actor.side),enemies=activeUnits(b,isPlayer?'player2':'player1');if(cond.type==='hp_ratio_gte')return actor.maxHp>0&&actor.currentHp/actor.maxHp*100>=Number(cond.val);if(cond.type==='hp_ratio_lte')return actor.maxHp>0&&actor.currentHp/actor.maxHp*100<=Number(cond.val);if(cond.type==='ap_val_gte')return (isPlayer?b.p1:b.p2).ap>=Number(cond.val);if(cond.type==='ap_val_lte')return (isPlayer?b.p1:b.p2).ap<=Number(cond.val);if(cond.type==='ally_has_attr')return allies.some(u=>u!==actor&&u.currentHp>0&&(u.mainAttr===cond.attr||(u.subAttrs||[]).includes(cond.attr)));if(cond.type==='enemy_has_attr')return enemies.some(u=>u.currentHp>0&&(u.mainAttr===cond.attr||(u.subAttrs||[]).includes(cond.attr)));if(cond.type==='all_ally_attr'){const alive=allies.filter(u=>u.currentHp>0);return alive.length>0&&alive.every(u=>u.mainAttr===cond.attr||(u.subAttrs||[]).includes(cond.attr));}if(cond.type==='all_enemy_attr'){const alive=enemies.filter(u=>u.currentHp>0);return alive.length>0&&alive.every(u=>u.mainAttr===cond.attr||(u.subAttrs||[]).includes(cond.attr));}return true;}
function targets(b,actor,type,cond,selected,isMagic=false){if(type==='player_self')return [{__playerTarget:'self',name:actor.side==='player1'?b.p1.name:b.p2.name}];if(type==='player_opp')return [{__playerTarget:'opp',name:actor.side==='player1'?b.p2.name:b.p1.name}];if(type==='self')return [actor];const pool=targetPool(b,actor,type).filter(t=>matches(t,cond));if(!pool.length)return[];if(type==='select_enemy_1'||type==='select_ally_1'){const x=pool.find(t=>t.instanceId===selected);return x?[x]:(isMagic?[pool[0]]:[]);}if(type.startsWith('random_'))return [pool[crypto.randomInt(pool.length)]];return pool;}
function applyEffect(b,eff,target,actor,isMagic=false){if(!eff||eff.type==='none'||!target)return null;if(eff.type==='mod_ap'){const p=actor.side==='player1'?b.p1:b.p2;const q=target.__playerTarget==='opp'?(actor.side==='player1'?b.p2:b.p1):p;q.ap=Math.max(0,Math.min(100,q.ap+Number(eff.val||0)));return `AP ${eff.val>=0?'+':''}${eff.val}`;}if(target.__playerTarget)return null;const duration=Math.max(1,Number(eff.duration)||1);if(eff.type==='dmg_atk_ratio'){if(isMagic)return null;const r=damage(target,Math.round(eff.val/100*effAtk(actor)));return `${target.name}に${r.damage}ダメージ`;}if(eff.type==='dmg_fixed'){const r=damage(target,Number(eff.val)||0);return `${target.name}に${r.damage}ダメージ`;}if(eff.type==='heal_fixed'||eff.type==='heal_max_hp_ratio'){if(target.debuffs.some(x=>x.type==='heal_block'&&x.duration>0))return '回復禁止中';const v=eff.type==='heal_fixed'?Number(eff.val)||0:Math.round(target.maxHp*Number(eff.val||0)/100);const before=target.currentHp;target.currentHp=Math.min(target.maxHp,target.currentHp+v);return `${target.name}のHP +${target.currentHp-before}`;}if(eff.type==='damage_cut_ratio'){addStatus(target,{type:'dmg_cut',val:Number(eff.val)||0,duration,source:Number(eff.val)>=0?'buff':'debuff',stackable:eff.stackable!==false,appliedTurn:b._statusApplicationTiming==='battle_start'?b.turn-1:b.turn},Number(eff.val)>=0);return `被ダメージ${eff.val}%カット`;}if(eff.type==='mod_atk_ratio'||eff.type==='mod_atk_val'){addStatus(target,{type:eff.type==='mod_atk_ratio'?'atk_ratio':'atk_val',val:Number(eff.val)||0,duration,source:Number(eff.val)>=0?'buff':'debuff',stackable:eff.stackable!==false,appliedTurn:b._statusApplicationTiming==='battle_start'?b.turn-1:b.turn},Number(eff.val)>=0);return `攻撃力 ${eff.val>=0?'+':''}${eff.val}${eff.type==='mod_atk_ratio'?'%':''}`;}if(eff.type==='mod_speed'){addStatus(target,{type:'speed',val:Number(eff.val)||0,duration,source:Number(eff.val)>=0?'buff':'debuff',stackable:eff.stackable!==false,appliedTurn:b._statusApplicationTiming==='battle_start'?b.turn-1:b.turn},Number(eff.val)>=0);return `行動値 ${eff.val>=0?'+':''}${eff.val}`;}if(eff.type==='clear_buffs'){target.buffs=(target.buffs||[]).filter(x=>x.source&&x.source!=='buff');return 'バフ全解除';}if(eff.type==='clear_debuffs'){target.debuffs=[];return 'デバフ全解除';}if(eff.type==='heal_block'||eff.type==='skill_block'){addStatus(target,{type:eff.type,duration,source:'debuff',stackable:eff.stackable!==false,appliedTurn:b._statusApplicationTiming==='battle_start'?b.turn-1:b.turn},false);return eff.type==='heal_block'?`回復禁止${duration}ターン`:`スキル使用禁止${duration}ターン`;}return null;}
function passive(b,timing){for(const u of allUnits(b)){if(u.currentHp<=0||!u.isActive)continue;for(const sk of u.skills||[]){if(sk.type!=='passive'||sk.timing!==timing||!evalCond(b,sk.selfCond,u))continue;b._statusApplicationTiming=timing;const tg=targets(b,u,sk.targetType,sk.targetCond,sk.targetInstanceId);for(const t of tg)applyEffect(b,sk.mainEffect,t,u,false);if(sk.hasSubEffect&&sk.subEffect)for(const t of targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond,sk.subEffect.targetInstanceId))applyEffect(b,sk.subEffect,t,u,false);b._statusApplicationTiming=null;}}}
function tickStatuses(b){for(const u of allUnits(b)){u.buffs=u.buffs.map(x=>({...x,duration:Number(x.duration)-1})).filter(x=>x.duration>0);u.debuffs=u.debuffs.map(x=>({...x,duration:Number(x.duration)-1})).filter(x=>x.duration>0);}}
function chooseAuto(b,side){const units=activeUnits(b,side);const opp=side==='player1'?'player2':'player1';for(const u of units){let picked=null;const ap=(side==='player1'?b.p1:b.p2).ap;for(let i=0;i<(u.skills||[]).length;i++){const sk=u.skills[i];if(sk.type!=='active'||!evalCond(b,sk.selfCond,u)||ap<(sk.cost||0)||u.debuffs.some(x=>x.type==='skill_block'&&x.duration>0))continue;const cs=targets(b,u,sk.targetType,sk.targetCond);if((sk.targetType==='select_enemy_1'||sk.targetType==='select_ally_1')&&!cs.length)continue;picked={type:'skill',skillIndex:i,targetInstanceId:cs[0]?.instanceId||null};break;}u.reservedAction=picked||{type:'attack',targetInstanceId:null};}}
function executeMagic(b,side,card){if(!card)return null;const resource=side==='player1'?b.p1:b.p2;const cost=Number(card.effect?.cost||0);if(resource.ap<cost)return {type:'MAGIC_USE',actor:{side:side,name:resource.name},actionName:card.name,effect:'AP不足',result:'不発',description:card.desc||''};resource.ap-=cost;const actor={side,currentHp:1,maxHp:1,name:resource.name};const eff=card.effect||{};const main=targets(b,actor,eff.targetType,eff.targetCond);const before=new Map(main.map(t=>[t.instanceId,{current:t.currentHp,max:t.maxHp}]));const lines=[];for(const t of main){const r=applyEffect(b,eff.mainEffect,t,actor,true);if(r)lines.push(r);}if(eff.hasSubEffect&&eff.subEffect){for(const t of targets(b,actor,eff.subEffect.targetType||eff.targetType,eff.subEffect.targetCond||eff.targetCond)){const r=applyEffect(b,eff.subEffect,t,actor,true);if(r)lines.push(r);}}const tar=main[0];return {type:'MAGIC_USE',actor:{side,name:resource.name,image:typeof card.image==='string'?card.image:null},target:tar?pubUnit(tar,true):null,actionName:card.name,effect:lines.join('\n')||'効果なし',result:lines.join('\n')||'変化なし',description:card.desc||'',card:sanitizeCard(card,true),targetHpBefore:tar?before.get(tar.instanceId):null,targetHpAfter:tar?{current:tar.currentHp,max:tar.maxHp}:null,cardId:card.id};}
function executeAction(b,side,u,action){const actorSide=side;const resource=side==='player1'?b.p1:b.p2;if(action.type==='attack'){const enemies=activeUnits(b,side==='player1'?'player2':'player1');if(!enemies.length)return null;const t=action.targetInstanceId&&enemies.find(x=>x.instanceId===action.targetInstanceId)||enemies[crypto.randomInt(enemies.length)];const hp={before:t.currentHp,max:t.maxHp};const r=damage(t,effAtk(u));return {type:'CHARACTER_ATTACK',actor:pubUnit(u,true),target:pubUnit(t,true),actorHpBefore:{current:u.currentHp,max:u.maxHp},actorHpAfter:{current:u.currentHp,max:u.maxHp},targetHpBefore:hp,targetHpAfter:{current:t.currentHp,max:t.maxHp},actionName:'通常攻撃',effect:`基礎攻撃力 ${effAtk(u)}`,result:`${r.damage} ダメージ${t.currentHp<=0?'／撃破！':''}`};}
 if(action.type!=='skill')return null;const sk=u.skills[action.skillIndex];if(!sk)return null;if(u.debuffs.some(x=>x.type==='skill_block'&&x.duration>0))return {type:'SKILL_USE',actor:pubUnit(u,true),actionName:sk.name,effect:'スキル使用禁止',result:'不発',description:sk.desc||''};const cost=Number(sk.cost||0);if(resource.ap<cost)return {type:'SKILL_USE',actor:pubUnit(u,true),actionName:sk.name,effect:'AP不足',result:'不発',description:sk.desc||''};resource.ap-=cost;const main=targets(b,u,sk.targetType,sk.targetCond,action.targetInstanceId);if((sk.targetType==='select_enemy_1'||sk.targetType==='select_ally_1')&&!main.length)return {type:'SKILL_USE',actor:pubUnit(u,true),actionName:sk.name,effect:'指定対象なし',result:'不発',description:sk.desc||''};const before=new Map(main.map(t=>[t.instanceId,{current:t.currentHp,max:t.maxHp}]));const lines=[];for(const t of main){const r=applyEffect(b,sk.mainEffect,t,u,false);if(r)lines.push(r);}if(sk.hasSubEffect&&sk.subEffect){for(const t of targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond,sk.subEffect.targetInstanceId||action.targetInstanceId)){const r=applyEffect(b,sk.subEffect,t,u,false);if(r)lines.push(r);}}const tar=main[0];return {type:'SKILL_USE',actor:pubUnit(u,true),target:tar?pubUnit(tar,true):null,actionName:sk.name,effect:lines.join('\n')||'効果なし',result:lines.join('\n')||'変化なし',description:sk.desc||'' ,actorHpBefore:{current:u.currentHp,max:u.maxHp},actorHpAfter:{current:u.currentHp,max:u.maxHp},targetHpBefore:tar?before.get(tar.instanceId):null,targetHpAfter:tar?{current:tar.currentHp,max:tar.maxHp}:null};}
function pubUnit(u,includeSkills=false){const x={instanceId:u.instanceId,cardId:u.cardId,name:u.name,mainAttr:u.mainAttr,subAttrs:u.subAttrs,maxHp:u.maxHp,currentHp:u.currentHp,atk:u.atk,priority:u.priority,effectiveAtk:effAtk(u),effectiveSpeed:effSpeed(u),side:u.side,isActive:u.isActive,buffs:u.buffs,debuffs:u.debuffs,image:u.image||null};if(includeSkills)x.skills=u.skills;return x;}
function publicBattle(b,viewerSide){return {battleId:b.battleId,turn:b.turn,phase:b.phase,deadline:b.deadline,p1:{name:b.p1.name,ap:b.p1.ap,units:b.p1.units.map(u=>pubUnit(u,viewerSide==='player1')),magicIds:viewerSide==='player1'?b.p1.magicIds:[]},p2:{name:b.p2.name,ap:b.p2.ap,units:b.p2.units.map(u=>pubUnit(u,viewerSide==='player2')),magicIds:viewerSide==='player2'?b.p2.magicIds:[]},yourSide:viewerSide,winner:b.winner,events:(b.events||[]).slice(-30)};}
function startBattle(r){
 const a=r.players[0],c=r.players[1];
 const ca=r.profiles[a.sessionId],cb=r.profiles[c.sessionId];
 const da=r.selected[a.sessionId],db=r.selected[c.sessionId];
 if(!ca||!cb||!da||!db)return false;
 function sourceFor(sessionId,profile){
   if(r.rule==='rental') return r.profiles[r.ownerId]?.cards||[];
   if(r.rule==='super_rental'||r.rule==='random_pot') return [...(r.pools[sessionId]?.units||[]),...(r.pools[sessionId]?.magics||[])];
   return profile.cards||[];
 }
 const make=(sessionId,profile,sel,side)=>{
   const source=sourceFor(sessionId,profile),cards=new Map(source.map(x=>[x.id,x]));
   const units=(sel.unitIds||[]).map(id=>cards.get(id)).filter(Boolean);
   const active=(sel.active&&sel.active.length?sel.active:units.slice(0,3).map(x=>x.id)).filter(id=>units.some(x=>x.id===id)).slice(0,3);
   const reserve=(sel.reserve||units.filter(x=>!active.includes(x.id)).map(x=>x.id)).filter(id=>units.some(x=>x.id===id)&&!active.includes(id)).slice(0,2);
   return {sessionId,name:profile.name,side,ap:0,units:units.map(x=>buildUnit(x,side,active.includes(x.id))),reserveQueue:reserve,magicIds:(sel.magicIds||[]).filter(id=>cards.has(id)),usedMagic:[],actions:null};
 };
 if((da.unitIds||[]).length<3||(db.unitIds||[]).length<3)return false;
 r.status='battle';
 r.battle={battleId:uid('battle'),turn:1,phase:'decision',deadline:Date.now()+90000,p1:make(a.sessionId,ca,da,'player1'),p2:make(c.sessionId,cb,db,'player2'),winner:null,events:[]};
 passive(r.battle,'battle_start');passive(r.battle,'deploy');broadcastBattle(r,'battle_start');scheduleTurn(r);return true;
}
function broadcastBattle(r,type,extra={}){for(const p of r.players.filter(Boolean)){const side=p===r.players[0]?'player1':'player2';send(p.ws,type,{...extra,state:publicBattle(r.battle,side)});}for(const sid of r.spectators){const s=sessions.get(sid);if(s?.ws)send(s.ws,type,{...extra,state:publicBattle(r.battle,'spectator')});}}
function scheduleTurn(r){if(!r.battle)return;clearTimeout(r.timer);r.battle.deadline=Date.now()+90000;r.battle.phase='decision';r.battle.p1.ap=Math.min(100,r.battle.p1.ap+20);r.battle.p2.ap=Math.min(100,r.battle.p2.ap+20);for(const u of allUnits(r.battle))if(u.currentHp>0)u.reservedAction={type:'attack',targetInstanceId:null};r.battle.p1.actions=null;r.battle.p2.actions=null;broadcastBattle(r,'turn_start');r.timer=setTimeout(()=>{if(!r.battle||r.battle.phase!=='decision')return;for(const side of ['player1','player2']){const pl=battlePlayer(r.battle,side);if(!pl.actions){chooseAuto(r.battle,side);pl.actions={units:pl.units.filter(u=>u.isActive&&u.currentHp>0).map(u=>({unitInstanceId:u.instanceId,...u.reservedAction})),magicId:null,actionId:uid('timeout')};}}try{executeTurn(r);}catch(err){console.error('Battle timeout execution error:',err);r.battle.phase='decision';r.battle.p1.actions=null;r.battle.p2.actions=null;broadcastBattle(r,'battle_error',{message:'自動行動処理でエラーが発生しました。'});scheduleTurn(r);}},90000);}
function validateActionSet(b,side,actions){const pl=side==='player1'?b.p1:b.p2;const units=activeUnits(b,side);const byId=new Map(units.map(u=>[u.instanceId,u]));const out={units:[],magicId:null,actionId:actions.actionId||uid('action')};for(const a of actions.units||[]){const u=byId.get(a.unitInstanceId);if(!u)continue;if(a.type==='attack'){out.units.push({unitInstanceId:u.instanceId,type:'attack',targetInstanceId:a.targetInstanceId||null});}else if(a.type==='skill'){const sk=u.skills[a.skillIndex];if(!sk||sk.type!=='active')continue;if(pl.ap<Number(sk.cost||0))continue;out.units.push({unitInstanceId:u.instanceId,type:'skill',skillIndex:a.skillIndex,targetInstanceId:a.targetInstanceId||null});}}if(actions.magicId && pl.magicIds.includes(actions.magicId)) out.magicId=actions.magicId;return out;}
function executeTurn(r){const b=r.battle;if(!b||b.phase!=='decision')return;clearTimeout(r.timer);b.phase='execution';const pending=new Map();for(const side of ['player1','player2']){const pl=battlePlayer(b,side);const actions=pl.actions||{units:[],magicId:null};for(const a of actions.units||[]){const u=pl.units.find(x=>x.instanceId===a.unitInstanceId);if(u)pending.set(u.instanceId,{side,u,a});}if(actions.magicId){const card=(r.profiles[pl.sessionId]?.cards||[]).find(c=>c.id===actions.magicId);if(card)pending.set('magic_'+side,{side,magic:card,a:{type:'magic'}});}}
 while(pending.size&&!b.winner){const arr=[...pending.values()].filter(x=>x.magic|| (x.u&&x.u.currentHp>0&&x.u.isActive));if(!arr.length)break;arr.sort((x,y)=>(x.magic?(x.magic.stats?.priority??999):effSpeed(x.u))-(y.magic?(y.magic.stats?.priority??999):effSpeed(y.u))||crypto.randomInt(2)-0.5);const x=arr[0];const key=x.u?x.u.instanceId:'magic_'+x.side;pending.delete(key);const ev=x.magic?executeMagic(b,x.side,x.magic):executeAction(b,x.side,x.u,x.a);if(ev){b.events.push(ev);broadcastBattle(r,'battle_event',{event:ev});}checkWin(r);}
 passive(b,'turn_end');tickStatuses(b);replaceDead(b);checkWin(r);if(!b.winner){b.turn++;scheduleTurn(r);}else{r.status='finished';broadcastBattle(r,'battle_end',{winner:b.winner});}}
function replaceDead(b){for(const side of ['player1','player2']){const pl=battlePlayer(b,side);for(const u of pl.units.filter(x=>x.isActive&&x.currentHp<=0)){u.isActive=false;const id=pl.reserveQueue.shift();if(id){const n=pl.units.find(x=>x.cardId===id&&!x.isActive&&x.currentHp>0);if(n){n.isActive=true;passiveOne(b,'deploy',n);}}}}}
function passiveOne(b,timing,u){for(const sk of u.skills||[]){if(sk.type==='passive'&&sk.timing===timing&&evalCond(b,sk.selfCond,u)){b._statusApplicationTiming=timing;for(const t of targets(b,u,sk.targetType,sk.targetCond,sk.targetInstanceId))applyEffect(b,sk.mainEffect,t,u,false);if(sk.hasSubEffect&&sk.subEffect)for(const t of targets(b,u,sk.subEffect.targetType||sk.targetType,sk.subEffect.targetCond||sk.targetCond))applyEffect(b,sk.subEffect,t,u,false);b._statusApplicationTiming=null;}}}
function checkWin(r){const b=r.battle;const a=activeUnits(b,'player1').length||b.p1.units.some(u=>u.currentHp>0);const c=activeUnits(b,'player2').length||b.p2.units.some(u=>u.currentHp>0);if(!a&&!c)b.winner='draw';else if(!a)b.winner='player2';else if(!c)b.winner='player1';}

const server=http.createServer((req,res)=>{if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(fs.readFileSync(CLIENT));return;}if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;}res.writeHead(404);res.end('Not found');});
server.on('upgrade',(req,socket)=>{const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return;}const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const ws=acceptWebSocket(socket);let sid=null;ws.on('wsmessage',raw=>{let m;try{m=JSON.parse(raw)}catch{return;}const type=m.type;
 if(type==='hello'){
   sid=m.sessionId||uid('session');
   const existing=sessions.get(sid);
   const s=existing||{sessionId:sid,name:safeName(m.name),ws,roomId:null,profile:null};
   s.name=safeName(m.name,s.name);s.ws=ws;s.online=true;s.lastSeen=Date.now();sessions.set(sid,s);
   send(ws,'hello',{sessionId:sid});
   send(ws,'room_list',{rooms:[...rooms.values()].filter(r=>r.status!=='closed').map(publicRoom)});
   // ページ更新・一時切断からの自動復帰
   const rr=s.roomId?rooms.get(s.roomId):null;
   if(rr){
     const pi=rr.players.findIndex(p=>p?.sessionId===sid);
     if(pi>=0){
       rr.players[pi].ws=ws;rr.players[pi].online=true;rr.players[pi].lastSeen=Date.now();
       send(ws,'room_recovered',{room:publicRoom(rr),slot:pi,ready:!!rr.players[pi].ready,players:rr.players.map(p=>p?{playerId:p.sessionId,name:p.name,ready:p.ready,online:p.online}:null)});
       if(rr.battle){send(ws,'battle_state',{state:publicBattle(rr.battle,pi===0?'player1':'player2')});resumeBattleAfterReconnect(rr);}
     } else if(rr.spectators.has(sid)) {
       send(ws,'spectate_recovered',{room:publicRoom(rr)});
       if(rr.battle)send(ws,'battle_state',{state:publicBattle(rr.battle,'spectator')});
     } else { s.roomId=null; }
   }
   return;
 }
 if(!sid)return;const s=sessions.get(sid);s.ws=ws;s.lastSeen=Date.now();
 if(type==='room_list'){send(ws,'room_list',{rooms:[...rooms.values()].filter(r=>r.status!=='closed').map(publicRoom)});return;}
 if(type==='room_create'){const r=createRoom(s,{roomName:m.roomName,password:m.password,rule:m.rule,allowSpectators:m.allowSpectators,maxSpectators:m.maxSpectators});send(ws,'room_joined',{room:publicRoom(r),slot:0,rentalDecks:r.rule==='rental'&&r.profiles[s.sessionId]?r.profiles[s.sessionId].decks:[]});broadcastRoom(r,'room_update',{room:publicRoom(r),players:r.players.map(p=>p?{playerId:p.sessionId,name:p.name,ready:p.ready,online:p.online}:null)});return;}
 if(type==='room_join'){const r=rooms.get(m.roomId);if(!r)return send(ws,'error',{message:'部屋がありません。'});const res=joinPlayer(r,sid,ws,m.password);if(!res.ok)return send(ws,'error',{message:res.error});copySessionProfileToRoom(r,s);send(ws,'room_joined',{room:publicRoom(r),slot:res.index,rentalDecks:r.rule==='rental'&&r.profiles[r.ownerId]?r.profiles[r.ownerId].decks:[]});broadcastRoom(r,'room_update',{room:publicRoom(r),players:r.players.map(p=>p?{playerId:p.sessionId,name:p.name,ready:p.ready,online:p.online}:null)});return;}
 const r=roomBySession(sid);
 if(type==='room_leave'){leaveRoom(sid);send(ws,'left_room');return;}
 if(type==='spectate_join'){const r2=rooms.get(m.roomId);if(!r2||!r2.allowSpectators)return send(ws,'error',{message:'観戦できません。'});if(r2.spectators.size>=r2.maxSpectators)return send(ws,'error',{message:'観戦人数が上限です。'});if(r2.passwordHash&&hashPassword(m.password)!==r2.passwordHash)return send(ws,'error',{message:'パスワードが違います。'});r2.spectators.add(sid);s.roomId=r2.roomId;send(ws,'spectate_joined',{room:publicRoom(r2)});if(r2.battle)send(ws,'battle_state',{state:publicBattle(r2.battle,'spectator')});return;}
 if(!r)return;
 if(type==='profile_sync'){const profile={name:s.name,cards:uniqueById((m.cards||[]).map(x=>sanitizeCard(x,true))),decks:(m.decks||[]).map(sanitizeDeck)};s.profile=profile;if(r){r.profiles[sid]=JSON.parse(JSON.stringify(profile));if(r.rule==='rental'&&r.ownerId===sid)broadcastRoom(r,'rental_decks',{decks:r.profiles[sid].decks});}return;}
 if(type==='room_ready'){
   const p=r.players.find(x=>x?.sessionId===sid);if(!p)return;
   p.ready=!!m.ready;r.updatedAt=Date.now();
   if(r.players.every(Boolean)&&r.players.every(x=>x.ready))r.status='preparing';
   broadcastRoom(r,'room_update',{room:publicRoom(r),players:r.players.map(p=>p?{playerId:p.sessionId,name:p.name,ready:p.ready,online:p.online}:null)});
   return;
 }
 if(type==='battle_select'){
   if(!r.players.some(p=>p?.sessionId===sid))return;
   r.selected[sid]=m.selection||{};r.updatedAt=Date.now();
   if(r.players.every(Boolean)&&r.players.every(p=>p.ready)&&r.selected[r.players[0].sessionId]&&r.selected[r.players[1].sessionId]){
     if((r.rule==='super_rental'||r.rule==='random_pot')&&!r.pools[r.players[0].sessionId]){
       const a=r.profiles[r.players[0].sessionId],b=r.profiles[r.players[1].sessionId];
       if(!a||!b)return broadcastRoom(r,'error',{message:'カード情報の同期を待っています。もう一度準備完了を押してください。'});
       let source=r.rule==='super_rental'?a.cards:uniqueById([...a.cards,...b.cards]);
       const chars=source.filter(x=>x.cardType==='unit'),mags=source.filter(x=>x.cardType==='magic');
       if(chars.length<10||mags.length<20)return broadcastRoom(r,'error',{message:'抽選に必要なカードが不足しています。'});
       for(const p of r.players){r.pools[p.sessionId]={units:sample(chars,10),magics:sample(mags,20)};send(p.ws,'pool_ready',{units:r.pools[p.sessionId].units.map(x=>sanitizeCard(x,true)),magics:r.pools[p.sessionId].magics.map(x=>sanitizeCard(x,true))});}
       return;
     }
     const ok=startBattle(r);
     if(!ok)broadcastRoom(r,'error',{message:'対戦開始に必要なデッキ情報が不足しています。デッキを確認して、準備完了を押し直してください。'});
   }
   return;
 }
 if(type==='submit_actions'){if(!r.battle||r.battle.phase!=='decision')return;const p=r.players.find(x=>x?.sessionId===sid);if(!p)return;const side=p===r.players[0]?'player1':'player2';const pl=side==='player1'?r.battle.p1:r.battle.p2;if(pl.actions&&pl.actions.actionId===m.actionId)return;pl.actions=validateActionSet(r.battle,side,m.actions||{});broadcastBattle(r,'action_confirmed',{playerId:sid,ready:true});if(r.battle.p1.actions&&r.battle.p2.actions){try{executeTurn(r);}catch(err){console.error('Battle execution error:',err);r.battle.phase='decision';r.battle.p1.actions=null;r.battle.p2.actions=null;broadcastBattle(r,'battle_error',{message:'戦闘処理中にエラーが発生しました。行動をリセットして再開します。',detail:String(err?.message||err)});scheduleTurn(r);}}return;}
 if(type==='battle_state'){if(r.battle){const p=r.players.find(x=>x?.sessionId===sid);const side=p===r.players[0]?'player1':p===r.players[1]?'player2':'spectator';send(ws,'battle_state',{state:publicBattle(r.battle,side)});}return;}
 });
 ws.on('close',()=>{if(!sid)return;const s=sessions.get(sid);if(s){s.online=false;s.lastSeen=Date.now();}const r=roomBySession(sid);if(r&&r.battle){pauseBattleForDisconnect(r);broadcastRoom(r,'player_disconnected',{playerId:sid});}});
});

function pauseBattleForDisconnect(r){
  if(!r?.battle||r.battle.phase!=='decision') return;
  clearTimeout(r.timer);
  r.battle.pausedRemainingMs=Math.max(0,(r.battle.deadline||Date.now())-Date.now());
  r.battle.deadline=null;
  r.battle.pausedForDisconnect=true;
  broadcastBattle(r,'battle_paused',{reason:'対戦相手の接続待ちです。',remainingMs:r.battle.pausedRemainingMs});
}
function resumeBattleAfterReconnect(r){
  if(!r?.battle||!r.battle.pausedForDisconnect) return;
  if(!r.players.every(p=>p?.online)) return;
  const ms=Math.max(1000,Number(r.battle.pausedRemainingMs||90000));
  r.battle.pausedForDisconnect=false;
  r.battle.deadline=Date.now()+ms;
  clearTimeout(r.timer);
  r.timer=setTimeout(()=>{if(!r.battle||r.battle.phase!=='decision'||r.battle.pausedForDisconnect)return;for(const side of ['player1','player2']){const pl=battlePlayer(r.battle,side);if(!pl.actions){chooseAuto(r.battle,side);pl.actions={units:pl.units.filter(u=>u.isActive&&u.currentHp>0).map(u=>({unitInstanceId:u.instanceId,...u.reservedAction})),magicId:null,actionId:uid('timeout')};}}try{executeTurn(r);}catch(err){console.error('Battle timeout execution error:',err);r.battle.phase='decision';r.battle.p1.actions=null;r.battle.p2.actions=null;broadcastBattle(r,'battle_error',{message:'自動行動処理でエラーが発生しました。'});scheduleTurn(r);}},ms);
  broadcastBattle(r,'battle_resumed');
  broadcastBattle(r,'turn_start');
}

setInterval(()=>{for(const [sid,s] of sessions){if(!s.online&&Date.now()-s.lastSeen>10*60*1000) sessions.delete(sid);}},60000);
server.listen(PORT,()=>console.log(`Card AI Battle Online: http://localhost:${PORT}`));
