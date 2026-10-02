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
const BOT_NAMES = ["小算","阿數"];
const BOT_JOBS = ["mage","archer"];

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
        raw.phase = "answering";
        raw.claimQueue = [];
        raw.claimIndex = -1;
        raw.currentClaimPlayerId = null;
        raw.skillPauseUntil = 0;
        raw.skillResume = null;
        raw.botClaimDue = 0;
        this.rooms.set(id, raw);
      }
      this.prune();
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    this.prune();

    if (url.pathname === "/rooms" && request.method === "GET") return json(this.publicRooms());

    if (url.pathname === "/rooms" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = cleanName(body.hostName);
      const job = JOBS.has(body.job) ? body.job : null;
      const difficulty = DIFFICULTIES.has(body.difficulty) ? body.difficulty : "basic";
      const training = !!body.training;
      if (!name || !job) return json({error:"資料不完整"}, 400);

      const id = this.makeRoomId();
      this.rooms.set(id, {
        id,
        hostName:name,
        maxPlayers:3,
        difficulty,
        training,
        players:[],
        state:"waiting",
        board:Array.from({length:9}, () => ({owner:null, locked:false})),
        round:0,
        question:null,
        deadline:0,
        phase:"answering",
        claimQueue:[],
        claimIndex:-1,
        currentClaimPlayerId:null,
        skillPauseUntil:0,
        skillResume:null,
        botClaimDue:0,
        createdAt:Date.now()
      });
      await this.persist();
      return json({id});
    }

    const match = url.pathname.match(/^\/room\/([A-Z0-9]{5})\/ws$/);
    if (match && request.headers.get("Upgrade") === "websocket") return this.connect(match[1], url);
    return new Response("Not found", {status:404});
  }

  async connect(roomId, url) {
    const room = this.rooms.get(roomId);
    if (!room) return new Response("Room not found", {status:404});
    if (room.state !== "waiting") return new Response("Game started", {status:409});
    if (room.players.length >= 3) return new Response("Room full", {status:409});

    const name = cleanName(url.searchParams.get("name"));
    const job = JOBS.has(url.searchParams.get("job")) ? url.searchParams.get("job") : null;
    if (!name || !job) return new Response("Invalid player", {status:400});

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const player = this.makePlayer(name, job, false, room.players.length === 0, server);
    room.players.push(player);

    server.addEventListener("message", ev => {
      try { this.onMessage(roomId, player.id, JSON.parse(ev.data)); } catch {}
    });
    server.addEventListener("close", () => this.disconnect(roomId, player.id));
    server.addEventListener("error", () => this.disconnect(roomId, player.id));

    this.send(player, {type:"welcome", playerId:player.id, roomId});

    if (room.training && room.players.length === 1) {
      for (let i=0;i<2;i++) room.players.push(this.makePlayer(BOT_NAMES[i], BOT_JOBS[i], true, false, null));
      room.state = "playing";
      room.round = 0;
      this.resetMatch(room);
      this.startRound(room);
    } else {
      this.broadcast(room);
    }

    await this.persist();
    return new Response(null, {status:101, webSocket:client});
  }

  makePlayer(name, job, isBot=false, host=false, ws=null) {
    return {
      id:crypto.randomUUID(), name, job, isBot, host, ws,
      status:"waiting", correctCount:0, claimRemaining:0,
      lockNextClaim:false, botDue:0,
      totalAnswers:0, correctAnswers:0, totalAnswerMs:0, answerStartedAt:0,
      archerBonusPending:false, mageLineTriggers:0
    };
  }

  resetMatch(room) {
    room.board = Array.from({length:9}, () => ({owner:null, locked:false}));
    room.skillPauseUntil = 0;
    room.skillResume = null;
    room.botClaimDue = 0;
    for (const p of room.players) {
      p.correctCount = 0;
      p.claimRemaining = 0;
      p.lockNextClaim = false;
      p.botDue = 0;
      p.totalAnswers = 0;
      p.correctAnswers = 0;
      p.totalAnswerMs = 0;
      p.answerStartedAt = 0;
      p.archerBonusPending = false;
      p.mageLineTriggers = 0;
    }
  }

  async onMessage(roomId, playerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const p = room.players.find(x => x.id === playerId);
    if (!p || p.isBot) return;

    if (msg.type === "start") {
      if (!p.host || room.state !== "waiting" || room.players.length < 2) return;
      room.state = "playing";
      room.round = 0;
      this.resetMatch(room);
      this.startRound(room);
      return;
    }

    if (msg.type === "answer") {
      if (room.state !== "playing" || p.status !== "answering" || !room.question) return;
      const value = Number(msg.answer);
      if (!Number.isFinite(value)) return;
      this.resolveAnswer(room, p, value === room.question.answer, true, Date.now());
      return;
    }

    if (msg.type === "claim") this.claim(room, p, Number(msg.index), true);
  }

  resolveAnswer(room, p, correct, notify=false, submittedAt=Date.now()) {
    if (p.status !== "answering") return;
    const safeSubmittedAt = Math.max(p.answerStartedAt || submittedAt, submittedAt);
    const elapsed = Math.max(0, Math.min(60000, safeSubmittedAt - (p.answerStartedAt || safeSubmittedAt)));
    p.totalAnswers += 1;
    p.totalAnswerMs += elapsed;
    p.roundAnswerMs = elapsed;
    p.roundSubmittedAt = safeSubmittedAt;
    p.botDue = 0;

    if (correct) {
      p.correctAnswers += 1;
      p.correctCount += 1;
      p.status = "answered";
      p.roundCorrect = true;
      p.claimRemaining = 1;
      p.lockNextClaim = p.job === "warrior" && p.correctCount <= 2;
      p.archerBonusPending = p.job === "archer" && (p.correctCount === 3 || p.correctCount === 5);
    } else {
      p.status = "done";
      p.roundCorrect = false;
      p.claimRemaining = 0;
    }

    this.broadcast(room);
    if (room.players.every(x => x.status !== "answering")) this.beginClaimPhase(room);
    else this.scheduleAlarm();
  }

  beginClaimPhase(room) {
    room.phase = "claiming";
    const correct = room.players
      .filter(p => p.status === "answered" && p.claimRemaining > 0)
      .sort((a,b) => (b.roundSubmittedAt - a.roundSubmittedAt) || (b.roundAnswerMs - a.roundAnswerMs) || a.id.localeCompare(b.id));

    room.claimQueue = correct.map(p => p.id);
    room.claimIndex = -1;

    for (const p of room.players) {
      if (p.status === "answered") p.status = "queued";
      if (!p.isBot) {
        if (p.roundCorrect === true) this.send(p, {type:"answerResult", correct:true, waiting:true, claims:p.claimRemaining});
        else if (p.roundCorrect === false) this.send(p, {type:"answerResult", correct:false, answer:room.question?.answer});
      }
    }

    if (!room.claimQueue.length) {
      room.deadline = 0;
      this.broadcast(room);
      return this.advanceRound(room);
    }

    this.advanceClaimTurn(room);
  }

  advanceClaimTurn(room) {
    const current = room.players.find(p => p.status === "claiming");
    if (current) {
      current.status = "done";
      current.claimRemaining = 0;
      current.lockNextClaim = false;
    }

    room.currentClaimPlayerId = null;
    room.botClaimDue = 0;
    room.claimIndex += 1;
    while (room.claimIndex < room.claimQueue.length) {
      const nextId = room.claimQueue[room.claimIndex];
      const p = room.players.find(x => x.id === nextId);
      if (!p || p.claimRemaining <= 0) {
        room.claimIndex += 1;
        continue;
      }

      p.status = "claiming";
      room.currentClaimPlayerId = p.id;
      room.deadline = Date.now() + 5000;
      this.broadcast(room);

      if (p.isBot) {
        room.botClaimDue = Date.now() + 1200;
      } else {
        room.botClaimDue = 0;
      }
      this.scheduleAlarm();
      return;
    }

    room.currentClaimPlayerId = null;
    room.botClaimDue = 0;
    room.deadline = 0;
    this.advanceRound(room);
  }

  broadcastSkill(room, job, playerId) {
    const payload = {type:"skillEffect", job, playerId};
    for (const p of room.players) this.send(p, payload);
  }

  pauseForSkill(room, job, playerId, resume="advanceClaimTurn") {
    this.broadcastSkill(room, job, playerId);
    room.phase = "skill";
    room.currentClaimPlayerId = null;
    room.botClaimDue = 0;
    room.skillPauseUntil = Date.now() + 2000;
    room.deadline = room.skillPauseUntil;
    room.skillResume = resume;
    this.broadcast(room);
    this.scheduleAlarm();
  }

  advanceRound(room) {
    if (room.round >= 7) this.finish(room);
    else this.startRound(room);
  }

  claim(room, p, index, notify=false) {
    if (room.state !== "playing" || room.phase !== "claiming") return false;
    if (room.currentClaimPlayerId !== p.id || p.status !== "claiming" || p.claimRemaining <= 0) {
      if (notify) this.send(p, {type:"claimError", message:"尚未輪到你選擇"});
      return false;
    }
    if (!Number.isInteger(index) || index < 0 || index > 8) return false;
    const cell = room.board[index];
    if (cell.owner === p.id) {
      if (notify) this.send(p, {type:"claimError", message:"這格已經是你的"});
      return false;
    }
    if (cell.locked && cell.owner !== p.id) {
      const priestCanTakeLockedCenter = p.job === "priest" && index === 4;
      if (!priestCanTakeLockedCenter) {
        if (notify) this.send(p, {type:"claimError", message:"這格已鎖定"});
        return false;
      }
    }

    const warriorSkill = p.job === "warrior" && !!p.lockNextClaim;
    const priestSkill = p.job === "priest" && index === 4;

    cell.owner = p.id;
    cell.locked = !!p.lockNextClaim;
    p.claimRemaining -= 1;

    let skillJob = warriorSkill ? "warrior" : (priestSkill ? "priest" : null);

    if (p.archerBonusPending) {
      p.archerBonusPending = false;
      if (this.randomBonusClaim(room, p.id)) skillJob = "archer";
    }

    const lineCaptured = this.resolveCaptures(room, p.id);
    if (p.job === "mage" && lineCaptured) {
      p.mageLineTriggers = (p.mageLineTriggers || 0) + 1;
      if ((p.mageLineTriggers === 1 || p.mageLineTriggers === 3) && this.randomBonusClaim(room, p.id)) {
        skillJob = "mage";
      }
    }

    if (this.checkFullBoardWinner(room)) {
      if (skillJob) this.broadcastSkill(room, skillJob, p.id);
      return true;
    }

    if (p.claimRemaining <= 0) {
      p.status = "done";
      p.lockNextClaim = false;
      this.broadcast(room);
      if (skillJob) this.pauseForSkill(room, skillJob, p.id, "advanceClaimTurn");
      else this.advanceClaimTurn(room);
      return true;
    }

    this.broadcast(room);
    if (p.isBot && p.status === "claiming" && p.claimRemaining > 0) {
      const nextPick = this.chooseBotClaim(room, p);
      if (nextPick >= 0) return this.claim(room, p, nextPick, false);
      p.status = "done";
      p.claimRemaining = 0;
      this.advanceClaimTurn(room);
      return true;
    }
    this.scheduleAlarm();
    return true;
  }

  startRound(room) {
    room.round += 1;
    if (room.round > 7) return this.finish(room);

    room.phase = "answering";
    room.claimQueue = [];
    room.claimIndex = -1;
    room.currentClaimPlayerId = null;
    room.botClaimDue = 0;
    room.question = makeQuestion(room.difficulty);
    room.deadline = Date.now() + 60000;

    for (const p of room.players) {
      p.status = "answering";
      p.claimRemaining = 0;
      p.lockNextClaim = false;
      p.roundAnswerMs = 0;
      p.roundSubmittedAt = 0;
      p.roundCorrect = null;
      p.answerStartedAt = Date.now();
      p.botDue = p.isBot ? Date.now() + rand(900, 3500) : 0;
    }

    this.broadcast(room);
    this.scheduleAlarm();
  }

  chooseBotClaim(room, p) {
    const choices = [];
    for (let i=0;i<9;i++) {
      const c = room.board[i];
      if (c.owner === p.id) continue;
      if (c.locked && c.owner !== p.id && !(p.job === "priest" && i === 4)) continue;
      let score = Math.random();
      if (i === 4) score += p.job === "priest" ? 12 : 6;
      if (c.owner && c.owner !== p.id) score += 4;

      for (const line of LINES.filter(x => x.includes(i))) {
        const mine = line.filter(x => x !== i && room.board[x].owner === p.id).length;
        const opp = line.filter(x => x !== i && room.board[x].owner && room.board[x].owner !== p.id).length;
        if (mine === 2) score += 14;
        else if (mine === 1) score += 4;
        if (opp === 2) score += 11;
        else if (opp === 1) score += 2;
      }
      choices.push({i,score});
    }
    choices.sort((a,b) => b.score-a.score);
    return choices.length ? choices[0].i : -1;
  }

  checkRound(room) {
    if (room.phase === "answering" && room.players.every(p => p.status !== "answering")) {
      this.beginClaimPhase(room);
    }
  }

  finish(room) {
    room.state = "finished";
    room.deadline = 0;
    room.question = null;
    for (const p of room.players) p.botDue = 0;
    this.broadcast(room, this.scores(room));
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
    }
    return anyLine;
  }

  randomBonusClaim(room, playerId) {
    const targets = room.board
      .map((c,i) => ({c,i}))
      .filter(x => x.c.owner !== playerId && !x.c.locked);
    if (!targets.length) return false;
    const pick = targets[Math.floor(Math.random()*targets.length)].i;
    room.board[pick] = {owner:playerId, locked:false};
    this.resolveCaptures(room, playerId);
    this.checkFullBoardWinner(room);
    return true;
  }

  checkFullBoardWinner(room) {
    if (room.state !== "playing") return false;
    for (const p of room.players) {
      if (room.board.every(c => c.owner === p.id)) {
        this.finish(room);
        return true;
      }
    }
    return false;
  }

  scores(room) {
    return room.players.map(p => {
      let score = 0;
      room.board.forEach((c,i) => {
        if (c.owner !== p.id) return;
        if (i === 4 && p.job === "priest") score += 5;
        else score += 1;
      });
      const occupiedCells = room.board.filter(c => c.owner === p.id).length;
      return {
        id:p.id,name:p.name,job:p.job,score,occupiedCells,
        totalAnswers:p.totalAnswers,correctAnswers:p.correctAnswers,totalAnswerMs:p.totalAnswerMs
      };
    }).sort((a,b) => b.score-a.score);
  }

  publicRoom(room) {
    return {
      id:room.id,
      hostName:room.hostName,
      training:!!room.training,
      maxPlayers:3,
      difficulty:room.difficulty,
      state:room.state,
      round:room.round,
      phase:room.phase,
      currentClaimPlayerId:room.currentClaimPlayerId,
      skillPauseUntil:room.skillPauseUntil||0,
      deadline:room.deadline,
      question:room.question ? {text:room.question.text} : null,
      board:room.board,
      players:room.players.map((p,i) => ({
        id:p.id,name:p.name,job:p.job,host:p.host,isBot:!!p.isBot,status:p.status,
        correctCount:p.correctCount,claimRemaining:p.claimRemaining,colorIndex:i,
        mageLineTriggers:p.mageLineTriggers||0,archerBonusPending:!!p.archerBonusPending,
        totalAnswers:p.totalAnswers,correctAnswers:p.correctAnswers,totalAnswerMs:p.totalAnswerMs
      }))
    };
  }

  broadcast(room, scores=null) {
    const data = {type:"state",room:this.publicRoom(room)};
    if (scores) data.scores = scores;
    for (const p of room.players) this.send(p, data);
  }

  send(player, data) {
    if (!player || player.isBot || !player.ws) return;
    try { player.ws.send(JSON.stringify(data)); } catch {}
  }

  disconnect(roomId, playerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    room.players.splice(idx,1);

    const humans = room.players.filter(p => !p.isBot);
    if (!humans.length) {
      this.rooms.delete(roomId);
    } else {
      if (!humans.some(p => p.host)) humans[0].host = true;
      this.broadcast(room);
    }
    this.persist();
  }

  async alarm() {
    const now = Date.now();

    for (const room of this.rooms.values()) {
      if (room.state !== "playing") continue;

      if (room.phase === "answering") {
        const dueBots = room.players.filter(p => p.isBot && p.status === "answering" && p.botDue && p.botDue <= now);
        for (const p of dueBots) {
          const botSubmittedAt = p.botDue;
          p.botDue = 0;
          this.resolveAnswer(room, p, Math.random() < 0.9, false, botSubmittedAt);
        }

        if (room.phase === "answering" && room.deadline && room.deadline <= now) {
          for (const p of room.players) {
            if (p.status !== "answering") continue;
            p.totalAnswers += 1;
            p.totalAnswerMs += 60000;
            p.roundAnswerMs = 60000;
            p.roundSubmittedAt = room.deadline;
            p.roundCorrect = false;
            p.status = "done";
            p.claimRemaining = 0;
            p.botDue = 0;
            this.send(p, {type:"timeout"});
          }
          this.broadcast(room);
          this.beginClaimPhase(room);
        }
      } else if (room.phase === "skill") {
        if (room.skillPauseUntil && room.skillPauseUntil <= now) {
          const resume = room.skillResume;
          room.skillPauseUntil = 0;
          room.skillResume = null;
          room.deadline = 0;
          room.phase = "claiming";
          if (resume === "advanceClaimTurn") this.advanceClaimTurn(room);
          else if (resume === "advanceRound") this.advanceRound(room);
        }
      } else if (room.phase === "claiming") {
        if (room.botClaimDue && room.botClaimDue <= now) {
          const bot = room.players.find(p => p.id === room.currentClaimPlayerId && p.isBot && p.status === "claiming");
          room.botClaimDue = 0;
          if (bot) {
            const pick = this.chooseBotClaim(room, bot);
            if (pick >= 0) this.claim(room, bot, pick, false);
            else this.advanceClaimTurn(room);
          }
        }

        if (room.phase === "claiming" && room.deadline && room.deadline <= now) {
          const current = room.players.find(p => p.status === "claiming");
          if (current) {
            current.status = "done";
            current.claimRemaining = 0;
            current.lockNextClaim = false;
            this.send(current, {type:"claimTimeout"});
          }
          this.broadcast(room);
          this.advanceClaimTurn(room);
        }
      }
    }

    this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const times = [];
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.state !== "playing") continue;
      if (room.deadline > now) times.push(room.deadline);
      if (room.botClaimDue > now) times.push(room.botClaimDue);
      for (const p of room.players) if (p.isBot && p.status === "answering" && p.botDue > now) times.push(p.botDue);
    }
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter(r => !r.training && r.state === "waiting" && r.players.length < 3)
      .map(r => ({id:r.id,hostName:r.hostName,createdAt:r.createdAt}))
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
        id:r.id,hostName:r.hostName,maxPlayers:3,difficulty:r.difficulty,training:!!r.training,
        state:"waiting",board:Array.from({length:9},()=>({owner:null,locked:false})),
        round:0,question:null,deadline:0,phase:"answering",claimQueue:[],claimIndex:-1,currentClaimPlayerId:null,
        skillPauseUntil:0,skillResume:null,botClaimDue:0,players:[],createdAt:r.createdAt
      };
    }
    await this.ctx.storage.put("rooms", out);
  }
}

function json(value,status=200) {
  return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json;charset=utf-8"}});
}
function cleanName(v) { return String(v || "").trim().slice(0,12); }
function rand(min,max) { return Math.floor(Math.random()*(max-min+1))+min; }

function makeQuestion(level) {
  if (level === "basic") {
    for (let n=0;n<500;n++) {
      const a=rand(1,20),b=rand(1,20),c=rand(1,20);
      const op1=Math.random()<.5?"+":"-",op2=Math.random()<.5?"+":"-";
      const answer=evalThree(a,op1,b,op2,c);
      if (answer===null || !Number.isInteger(answer) || answer<0) continue;
      return {text:a+" "+op1+" "+b+" "+op2+" "+c+"",answer};
    }
    return {text:"12 - 5 + 8",answer:15};
  }
  if (level === "advanced") {
    for (let n=0;n<1000;n++) {
      const a=rand(1,20),b=rand(1,20),c=rand(1,20);
      const op1=["+","-","×","÷"][rand(0,3)],op2=["+","-","×","÷"][rand(0,3)];
      const value=evalThree(a,op1,b,op2,c);
      if (value===null || !Number.isInteger(value) || value<0) continue;
      return {text:a+" "+op1+" "+b+" "+op2+" "+c+"",answer:value};
    }
    return {text:"18 ÷ 3 + 7",answer:13};
  }
  for (let n=0;n<1200;n++) {
    const a=rand(-20,20),b=rand(-20,20),c=rand(-20,20);
    const op1=["+","-","×","÷"][rand(0,3)],op2=["+","-","×","÷"][rand(0,3)];
    const value=evalThree(a,op1,b,op2,c);
    if (value===null || !Number.isInteger(value)) continue;
    return {text:showNumber(a)+" "+op1+" "+showNumber(b)+" "+op2+" "+showNumber(c)+"",answer:value};
  }
  return {text:"(-8) + 12 - 5",answer:-1};
}

function evalThree(a,op1,b,op2,c) {
  const prec=op => (op==="×"||op==="÷")?2:1;
  if (prec(op1)>=prec(op2)) {
    const left=applyOp(a,op1,b);
    if (left===null) return null;
    return applyOp(left,op2,c);
  }
  const right=applyOp(b,op2,c);
  if (right===null) return null;
  return applyOp(a,op1,right);
}
function applyOp(a,op,b) {
  if (op==="+") return a+b;
  if (op==="-") return a-b;
  if (op==="×") return a*b;
  if (op==="÷") {
    if (b===0 || a%b!==0) return null;
    return a/b;
  }
  return null;
}
function showNumber(n) { return n<0 ? "("+n+")" : String(n); }
