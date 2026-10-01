export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const id = env.GAME_HUB.idFromName("global");
      const stub = env.GAME_HUB.get(id);
      const next = new URL(request.url);
      next.hostname = "hub";
      next.pathname = url.pathname.replace(/^\/api/, "");
      return stub.fetch(new Request(next, request));
    }
    return env.ASSETS.fetch(request);
  }
};

const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

const JOBS = new Set(["warrior","mage","archer","priest"]);
const DIFFICULTIES = new Set(["basic","advanced","challenge"]);

export class GameHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rooms = new Map();
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = (await this.ctx.storage.get("rooms")) || {};
      for (const [id, raw] of Object.entries(saved)) {
        raw.players = [];
        raw.state = "waiting";
        raw.board = Array.from({length:9}, () => ({owner:null, locked:false}));
        raw.round = 0;
        raw.question = null;
        raw.deadline = 0;
        this.rooms.set(id, raw);
      }
      this.prune();
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    this.prune();

    if (url.pathname === "/rooms" && request.method === "GET") {
      return json(this.publicRooms());
    }

    if (url.pathname === "/rooms" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = cleanName(body.hostName);
      const job = JOBS.has(body.job) ? body.job : null;
      const difficulty = DIFFICULTIES.has(body.difficulty) ? body.difficulty : "basic";
      const maxPlayers = Number(body.maxPlayers) === 3 ? 3 : 2;
      if (!name || !job) return json({error:"資料不完整"}, 400);

      const id = this.makeRoomId();
      this.rooms.set(id, {
        id,
        hostToken: crypto.randomUUID(),
        hostName: name,
        maxPlayers,
        difficulty,
        players: [],
        state: "waiting",
        board: Array.from({length:9}, () => ({owner:null, locked:false})),
        round: 0,
        question: null,
        deadline: 0,
        createdAt: Date.now()
      });
      await this.persist();
      return json({id});
    }

    const match = url.pathname.match(/^\/room\/([A-Z0-9]{5})\/ws$/);
    if (match && request.headers.get("Upgrade") === "websocket") {
      return this.connect(match[1], url);
    }

    return new Response("Not found", {status:404});
  }

  async connect(roomId, url) {
    const room = this.rooms.get(roomId);
    if (!room) return new Response("Room not found", {status:404});
    if (room.state !== "waiting") return new Response("Game started", {status:409});
    if (room.players.length >= room.maxPlayers) return new Response("Room full", {status:409});

    const name = cleanName(url.searchParams.get("name"));
    const job = JOBS.has(url.searchParams.get("job")) ? url.searchParams.get("job") : null;
    if (!name || !job) return new Response("Invalid player", {status:400});

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const player = {
      id: crypto.randomUUID(),
      name,
      job,
      ws: server,
      host: room.players.length === 0,
      status: "waiting",
      correctCount: 0,
      claimRemaining: 0,
      lockNextClaim: false
    };
    room.players.push(player);

    server.addEventListener("message", ev => {
      try { this.onMessage(roomId, player.id, JSON.parse(ev.data)); }
      catch {}
    });
    server.addEventListener("close", () => this.disconnect(roomId, player.id));
    server.addEventListener("error", () => this.disconnect(roomId, player.id));

    this.send(player, {type:"welcome", playerId:player.id, roomId});
    this.broadcast(room);
    this.persist();
    return new Response(null, {status:101, webSocket:client});
  }

  async onMessage(roomId, playerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const p = room.players.find(x => x.id === playerId);
    if (!p) return;

    if (msg.type === "start") {
      if (!p.host || room.state !== "waiting" || room.players.length < 2) return;
      room.state = "playing";
      room.round = 0;
      for (const x of room.players) x.correctCount = 0;
      this.startRound(room);
      return;
    }

    if (msg.type === "answer") {
      if (room.state !== "playing" || p.status !== "answering" || !room.question) return;
      const value = Number(msg.answer);
      if (!Number.isFinite(value)) return;
      if (value === room.question.answer) {
        p.correctCount += 1;
        p.status = "claiming";
        p.claimRemaining = (p.job === "archer" && p.correctCount === 3) ? 2 : 1;
        p.lockNextClaim = p.job === "warrior" && p.correctCount <= 2;
        this.send(p, {type:"answerResult", correct:true, claims:p.claimRemaining});
      } else {
        p.status = "done";
        p.claimRemaining = 0;
        this.send(p, {type:"answerResult", correct:false});
      }
      this.broadcast(room);
      this.checkRound(room);
      return;
    }

    if (msg.type === "claim") {
      if (room.state !== "playing" || p.status !== "claiming" || p.claimRemaining <= 0) return;
      const index = Number(msg.index);
      if (!Number.isInteger(index) || index < 0 || index > 8) return;
      const cell = room.board[index];
      if (cell.owner === p.id) return this.send(p, {type:"claimError", message:"這格已經是你的"});
      if (cell.locked && cell.owner !== p.id) return this.send(p, {type:"claimError", message:"這格已鎖定"});

      cell.owner = p.id;
      cell.locked = !!p.lockNextClaim;
      p.claimRemaining -= 1;

      const lineCaptured = this.resolveCaptures(room, p.id);
      if (p.job === "mage" && lineCaptured) this.mageBonus(room, p.id);

      if (p.claimRemaining <= 0) {
        p.status = "done";
        p.lockNextClaim = false;
      }
      this.broadcast(room);
      this.checkRound(room);
    }
  }

  startRound(room) {
    room.round += 1;
    if (room.round > 5) return this.finish(room);
    room.question = makeQuestion(room.difficulty);
    room.deadline = Date.now() + 60000;
    for (const p of room.players) {
      p.status = "answering";
      p.claimRemaining = 0;
      p.lockNextClaim = false;
    }
    this.scheduleAlarm();
    this.broadcast(room);
  }

  checkRound(room) {
    if (room.players.length < 2) return;
    if (room.players.every(p => p.status === "done")) {
      if (room.round >= 5) this.finish(room);
      else this.startRound(room);
    }
  }

  finish(room) {
    room.state = "finished";
    room.deadline = 0;
    room.question = null;
    const scores = this.scores(room);
    this.broadcast(room, scores);
    this.persist();
  }

  resolveCaptures(room, playerId) {
    let anyLine = false;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      for (const line of LINES) {
        const mine = line.filter(i => room.board[i].owner === playerId);
        const others = line.filter(i => room.board[i].owner && room.board[i].owner !== playerId && !room.board[i].locked);
        if (mine.length >= 2 && others.length) {
          for (const i of others) {
            room.board[i] = {owner:playerId, locked:false};
            changed = true;
            anyLine = true;
          }
        }
      }

      for (let i=0;i<9;i++) {
        const c = room.board[i];
        if (!c.owner || c.owner === playerId || c.locked) continue;
        const ns = orthogonal(i);
        if (ns.length >= 2 && ns.every(n => room.board[n].owner === playerId)) {
          room.board[i] = {owner:playerId, locked:false};
          changed = true;
        }
      }
    }
    return anyLine;
  }

  mageBonus(room, playerId) {
    const targets = room.board
      .map((c,i) => ({c,i}))
      .filter(x => x.c.owner !== playerId && !x.c.locked);
    if (!targets.length) return;
    const pick = targets[Math.floor(Math.random()*targets.length)].i;
    room.board[pick] = {owner:playerId, locked:false};
    this.resolveCaptures(room, playerId);
  }

  scores(room) {
    const result = room.players.map(p => {
      let score = 0;
      room.board.forEach((c,i) => {
        if (c.owner !== p.id) return;
        if (i === 4 && p.job === "priest") score += 5;
        else score += i === 4 ? 2 : 1;
      });
      return {id:p.id, name:p.name, job:p.job, score};
    });
    return result.sort((a,b) => b.score-a.score);
  }

  publicRoom(room) {
    return {
      id: room.id,
      maxPlayers: room.maxPlayers,
      difficulty: room.difficulty,
      state: room.state,
      round: room.round,
      deadline: room.deadline,
      question: room.question ? {text:room.question.text} : null,
      board: room.board,
      players: room.players.map((p,i) => ({
        id:p.id, name:p.name, job:p.job, host:p.host, status:p.status,
        correctCount:p.correctCount, claimRemaining:p.claimRemaining, colorIndex:i
      }))
    };
  }

  broadcast(room, scores = null) {
    const data = {type:"state", room:this.publicRoom(room)};
    if (scores) data.scores = scores;
    for (const p of room.players) this.send(p, data);
  }

  send(player, data) {
    try { player.ws.send(JSON.stringify(data)); } catch {}
  }

  disconnect(roomId, playerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    room.players.splice(idx,1);
    if (!room.players.length) {
      this.rooms.delete(roomId);
    } else {
      if (!room.players.some(p => p.host)) room.players[0].host = true;
      this.broadcast(room);
    }
    this.persist();
  }

  async alarm() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.state === "playing" && room.deadline && room.deadline <= now) {
        for (const p of room.players) {
          if (p.status !== "done") {
            p.status = "done";
            p.claimRemaining = 0;
            this.send(p, {type:"timeout"});
          }
        }
        if (room.round >= 5) this.finish(room);
        else this.startRound(room);
      }
    }
    this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const deadlines = [...this.rooms.values()]
      .filter(r => r.state === "playing" && r.deadline > Date.now())
      .map(r => r.deadline);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter(r => r.state === "waiting" && r.players.length < r.maxPlayers)
      .map(r => ({id:r.id, players:r.players.length, maxPlayers:r.maxPlayers, difficulty:r.difficulty, createdAt:r.createdAt}))
      .sort((a,b) => b.createdAt-a.createdAt);
  }

  prune() {
    const cutoff = Date.now() - 3*60*60*1000;
    for (const [id,r] of this.rooms) if (!r.players.length && r.createdAt < cutoff) this.rooms.delete(id);
  }

  makeRoomId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id;
    do {
      id = Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
    } while (this.rooms.has(id));
    return id;
  }

  async persist() {
    const out = {};
    for (const [id,r] of this.rooms) {
      out[id] = {
        id:r.id, hostToken:r.hostToken, hostName:r.hostName,
        maxPlayers:r.maxPlayers, difficulty:r.difficulty, state:"waiting",
        board:Array.from({length:9}, () => ({owner:null,locked:false})),
        round:0, question:null, deadline:0, players:[], createdAt:r.createdAt
      };
    }
    await this.ctx.storage.put("rooms", out);
  }
}

function json(value, status=200) {
  return new Response(JSON.stringify(value), {status, headers:{"content-type":"application/json;charset=utf-8"}});
}
function cleanName(v) {
  return String(v || "").trim().slice(0,12);
}
function rand(min,max) {
  return Math.floor(Math.random()*(max-min+1))+min;
}
function orthogonal(i) {
  const r = Math.floor(i/3), c = i%3, out = [];
  if (r>0) out.push(i-3);
  if (r<2) out.push(i+3);
  if (c>0) out.push(i-1);
  if (c<2) out.push(i+1);
  return out;
}
function makeQuestion(level) {
  if (level === "basic") {
    // 3 個數字 + 2 個符號；只使用加減，所有數字與結果維持 0～20。
    for (let n=0;n<300;n++) {
      const a=rand(0,20), b=rand(0,20), c=rand(0,20);
      const op1 = Math.random() < .5 ? "+" : "-";
      const op2 = Math.random() < .5 ? "+" : "-";
      const first = op1 === "+" ? a+b : a-b;
      const answer = op2 === "+" ? first+c : first-c;
      if (first < 0 || first > 20 || answer < 0 || answer > 20) continue;
      return {text:a+" "+op1+" "+b+" "+op2+" "+c+" = ?", answer};
    }
    return {text:"12 - 5 + 8 = ?", answer:15};
  }

  if (level === "advanced") {
    // 3 個正整數 + 2 個四則符號；依正常先乘除後加減規則，答案必為整數。
    for (let n=0;n<500;n++) {
      const a=rand(1,20), b=rand(1,20), c=rand(1,20);
      const op1 = ["+","-","×","÷"][rand(0,3)];
      const op2 = ["+","-","×","÷"][rand(0,3)];
      const value = evalThree(a, op1, b, op2, c);
      if (value === null || !Number.isInteger(value) || value < 0) continue;
      return {text:a+" "+op1+" "+b+" "+op2+" "+c+" = ?", answer:value};
    }
    return {text:"18 ÷ 3 + 7 = ?", answer:13};
  }

  // 挑戰：3 個 -20～20 的整數 + 2 個四則符號；答案必為 -20～20 的整數。
  for (let n=0;n<800;n++) {
    const a=rand(-20,20), b=rand(-20,20), c=rand(-20,20);
    const op1 = ["+","-","×","÷"][rand(0,3)];
    const op2 = ["+","-","×","÷"][rand(0,3)];
    const value = evalThree(a, op1, b, op2, c);
    if (value === null || !Number.isInteger(value) || value < -20 || value > 20) continue;
    return {
      text:showNumber(a)+" "+op1+" "+showNumber(b)+" "+op2+" "+showNumber(c)+" = ?",
      answer:value
    };
  }
  return {text:"(-8) + 12 - 5 = ?", answer:-1};
}

function evalThree(a, op1, b, op2, c) {
  const prec = op => (op === "×" || op === "÷") ? 2 : 1;
  if (prec(op1) >= prec(op2)) {
    const left = applyOp(a, op1, b);
    if (left === null) return null;
    return applyOp(left, op2, c);
  }
  const right = applyOp(b, op2, c);
  if (right === null) return null;
  return applyOp(a, op1, right);
}

function applyOp(a, op, b) {
  if (op === "+") return a+b;
  if (op === "-") return a-b;
  if (op === "×") return a*b;
  if (op === "÷") {
    if (b === 0 || a % b !== 0) return null;
    return a/b;
  }
  return null;
}

function showNumber(n) {
  return n < 0 ? "("+n+")" : String(n);
}
