const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const JOB_NAME = {warrior:"戰士",mage:"法師",archer:"弓手",priest:"牧師"};
const JOB_IMG = {warrior:"/assets/warrior.png",mage:"/assets/mage.png",archer:"/assets/archer.png",priest:"/assets/priest.png"};
const SKILL_IMG = {
  warrior:"/assets/skill-warrior.png",
  mage:"/assets/skill-mage.png",
  archer:"/assets/skill-archer.png",
  priest:"/assets/skill-priest.png"
};
const DIFF_NAME = {basic:"基本",advanced:"進階",challenge:"挑戰"};

const AUDIO = {
  lobby:new Audio("/assets/audio/lobby.mp3"),
  room:new Audio("/assets/audio/room.mp3")
};
Object.values(AUDIO).forEach(a => {
  a.loop = true;
  a.preload = "auto";
  a.volume = 0.38;
});
let audioUnlocked = false;
let currentBgm = null;

function desiredBgm() {
  if (pageIs("gamePage")) {
    if (state.room?.state === "playing") return "room";
    return "lobby";
  }
  return "lobby";
}

function playBgm(name = desiredBgm()) {
  if (!audioUnlocked || !AUDIO[name]) return;
  if (currentBgm === name && !AUDIO[name].paused) return;
  for (const [key, audio] of Object.entries(AUDIO)) {
    if (key === name) continue;
    audio.pause();
    audio.currentTime = 0;
  }
  currentBgm = name;
  const audio = AUDIO[name];
  audio.play().catch(() => {});
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  playBgm();
}

document.addEventListener("pointerdown", unlockAudio, {once:true});
document.addEventListener("keydown", unlockAudio, {once:true});

const state = {
  name: localStorage.getItem("gc_name") || "",
  job: localStorage.getItem("gc_job") || "",
  roomId: null,
  playerId: null,
  room: null,
  ws: null,
  timerId: null,
  lineProfile: null,
  lineSession: localStorage.getItem("gc_line_session") || ""
};

const playerNameInput = $("#playerName");
if (playerNameInput) playerNameInput.value = state.name;

async function loadLineProfile() {
  try {
    const res = await fetch("/api/auth/me", {credentials:"include"});
    const data = await res.json();
    const box = $("#lineProfile");
    const loginBtn = $("#lineLoginBtn");
    if (!data.loggedIn || !data.profile) {
      state.lineProfile = null;
      if (box) box.classList.add("hidden");
      if (loginBtn) loginBtn.classList.remove("hidden");
      return;
    }
    state.lineProfile = data.profile;
    state.name = data.profile.displayName || state.name;
    if (playerNameInput && !playerNameInput.value.trim()) playerNameInput.value = state.name;
    saveIdentity();
    if (loginBtn) loginBtn.classList.add("hidden");
    if (box) {
      const p = data.profile;
      const avatar = p.pictureUrl ? '<img src="'+p.pictureUrl+'" alt="LINE頭像">' : '';
      box.innerHTML = avatar +
        '<div class="line-profile-main"><strong>'+escapeHtml(p.displayName)+'</strong>' +
        '<button id="lineLogoutBtn" type="button">登出</button></div>';
      box.classList.remove("hidden");
      $("#lineLogoutBtn")?.addEventListener("click", async () => {
        await fetch("/api/auth/logout", {method:"POST", credentials:"include"});
        location.reload();
      });
    }
  } catch {}
}

$("#lineLoginBtn")?.addEventListener("click", () => {
  location.href = "/api/auth/line/login";
});
loadLineProfile();

function page(id) {
  document.querySelectorAll(".page").forEach(el => {
    el.classList.toggle("active", el.id === id);
  });
  requestAnimationFrame(() => playBgm());
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 1800);
}
function saveIdentity() {
  localStorage.setItem("gc_name", state.name);
  localStorage.setItem("gc_job", state.job);
}
function requireIdentity() {
  if (!state.name) { page("homePage"); return false; }
  if (!state.job) { page("lobbyPage"); return false; }
  return true;
}

$("#fightBtn")?.addEventListener("click", () => {
  const name = ($("#playerName")?.value || "").trim();
  if (!name) return toast("請輸入名字");
  state.name = name.slice(0,12);
  saveIdentity();
  page("lobbyPage");
  refreshRooms();
});
$$("[data-go]").forEach(b => b.addEventListener("click", () => page(b.dataset.go)));

$$(".class-card").forEach(card => {
  if (card.dataset.job === state.job) card.classList.add("selected");
  card.addEventListener("click", () => {
    $$(".class-card").forEach(x => x.classList.remove("selected"));
    card.classList.add("selected");
    state.job = card.dataset.job;
    saveIdentity();
  });
});

async function createRoom(training=false) {
  if (!state.job) return toast("請選擇職業");
  try {
    const res = await fetch("/api/rooms", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        hostName:state.name,
        job:state.job,
        maxPlayers:3,
        difficulty:document.querySelector('input[name="difficulty"]:checked')?.value || "basic",
        training
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "建立失敗");
    joinRoom(data.id);
  } catch (e) { toast(e.message); }
}
$("#createRoomBtn")?.addEventListener("click", () => createRoom(false));
$("#trainingRoomBtn")?.addEventListener("click", () => createRoom(true));

async function refreshRooms() {
  try {
    const res = await fetch("/api/rooms");
    const rooms = await res.json();
    const list = $("#roomList");
    list.innerHTML = "";
    if (!rooms.length) {
      list.innerHTML = '<div class="room-item"><span>目前沒有房間</span></div>';
      return;
    }
    rooms.forEach(r => {
      const el = document.createElement("div");
      el.className = "room-item";
      el.innerHTML = '<div class="room-meta"><b>'+escapeHtml(r.hostName)+'的房間</b></div>';
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "加入";
      btn.onclick = () => {
        if (!state.job) return toast("請選擇職業");
        joinRoom(r.id);
      };
      el.appendChild(btn);
      list.appendChild(el);
    });
  } catch { toast("讀取失敗"); }
}

function joinRoom(id) {
  if (!requireIdentity()) return;
  if (state.ws) try { state.ws.close(); } catch {}
  state.roomId = id;
  state.playerId = null;
  state.room = null;
  page("gamePage");
  $("#roomTitle").textContent = "房間 " + id;
  $("#waitingPanel").classList.remove("hidden");
  $("#battlePanel").classList.add("hidden");
  $("#resultPanel").classList.add("hidden");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto+"//"+location.host+"/api/room/"+id+"/ws?name="+encodeURIComponent(state.name)+"&job="+encodeURIComponent(state.job);
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "welcome") {
      state.playerId = msg.playerId;
      return;
    }
    if (msg.type === "state") {
      state.room = msg.room;
      renderRoom(msg.scores || null);
      playBgm();
      return;
    }
    if (msg.type === "answerResult") {
      if (msg.correct) {
        $("#answerState").textContent = "答對　等待輪到你選擇";
        $("#answerInput").disabled = true;
      } else {
        $("#answerState").textContent = "答錯　正解：" + msg.answer;
        $("#answerInput").disabled = true;
      }
      renderBoard();
      return;
    }
    if (msg.type === "skillEffect") {
      showSkillEffect(msg.job);
      return;
    }
    if (msg.type === "claimError") toast(msg.message);
    if (msg.type === "timeout") {
      $("#answerState").textContent = "時間到";
      $("#answerInput").disabled = true;
    }
    if (msg.type === "claimTimeout") {
      $("#answerState").textContent = "選擇時間到";
    }
  };
  ws.onclose = () => {
    if (pageIs("gamePage") && state.room?.state !== "finished") toast("已離開房間");
  };
  ws.onerror = () => toast("無法加入房間");
}

function showSkillEffect(job) {
  const overlay = $("#skillOverlay");
  const img = $("#skillOverlayImg");
  const src = SKILL_IMG[job];
  if (!overlay || !img || !src) return;
  clearTimeout(showSkillEffect.t);
  img.src = src;
  img.alt = (JOB_NAME[job] || "") + "技能發動";
  overlay.classList.remove("hidden");
  showSkillEffect.t = setTimeout(() => {
    overlay.classList.add("hidden");
    img.src = "";
  }, 2000);
}

function pageIs(id) {
  const el = document.getElementById(id);
  return !!el && el.classList.contains("active");
}

$("#startBtn")?.addEventListener("click", () => {
  state.ws?.send(JSON.stringify({type:"start"}));
});

$("#answerForm")?.addEventListener("submit", e => {
  e.preventDefault();
  if (!state.room || state.room.state !== "playing") return;
  const raw = $("#answerInput").value.trim();
  if (!/^-?\d+$/.test(raw)) return toast("請輸入整數");
  state.ws?.send(JSON.stringify({type:"answer", answer:Number(raw)}));
});

$("#backLobbyBtn")?.addEventListener("click", () => {
  try { state.ws?.close(); } catch {}
  state.ws = null;
  state.room = null;
  state.roomId = null;
  state.playerId = null;
  page("lobbyPage");
  refreshRooms();
});

function renderRoom(scores) {
  const r = state.room;
  if (!r) return;
  $("#difficultyText").textContent = "";
  renderPlayers();
  renderBoard();

  if (r.state === "waiting") {
    $("#waitingPanel").classList.remove("hidden");
    $("#battlePanel").classList.add("hidden");
    $("#resultPanel").classList.add("hidden");
    $("#playersBar").classList.remove("hidden");
    $("#roundText").textContent = "";
    $("#roomTitle").textContent = "";
    $("#waitingText").textContent = "";
    $("#timer").textContent = "";
    $("#timer").classList.add("hidden");
    const me = r.players.find(p => p.id === state.playerId);
    $("#startBtn").classList.toggle("hidden", !(me?.host && r.players.length >= 2));
    return;
  }

  if (r.state === "playing") {
    $("#waitingPanel").classList.add("hidden");
    $("#battlePanel").classList.remove("hidden");
    $("#resultPanel").classList.add("hidden");
    $("#playersBar").classList.add("hidden");
    $("#roundText").textContent = "";
    $("#difficultyText").textContent = DIFF_NAME[r.difficulty] || "";
    $("#timer").classList.remove("hidden");
    $("#questionText").textContent = (r.question?.text || "--").replace(/\s*=\s*\?\s*$/, "");
    syncAnswerUI();
    startTimer(r.deadline);
    return;
  }

  if (r.state === "finished") {
    clearInterval(state.timerId);
    $("#waitingPanel").classList.add("hidden");
    $("#battlePanel").classList.add("hidden");
    $("#resultPanel").classList.remove("hidden");
    $("#playersBar").classList.add("hidden");
    $("#roundText").textContent = "";
    $("#difficultyText").textContent = "";
    $("#timer").classList.add("hidden");
    renderResults(scores || []);
  }
}

function syncAnswerUI() {
  const me = state.room?.players.find(p => p.id === state.playerId);
  const input = $("#answerInput");
  if (!me) return;

  if (me.status === "answering") {
    if (input.dataset.round !== String(state.room.round)) {
      input.value = "";
      input.dataset.round = String(state.room.round);
      input.disabled = false;
      setTimeout(() => input.focus(), 50);
    }
    $("#answerState").textContent = "";
  } else if (me.status === "answered") {
    input.disabled = true;
    $("#answerState").textContent = "已送出　等待其他玩家";
  } else if (me.status === "queued") {
    input.disabled = true;
    $("#answerState").textContent = "答對　等待輪到你選擇";
  } else if (me.status === "claiming") {
    input.disabled = true;
    $("#answerState").textContent = state.room.currentClaimPlayerId === state.playerId
      ? (me.claimRemaining === 2 ? "輪到你　請選2格　5秒" : "輪到你　請選一格　5秒")
      : "等待上一位玩家完成選擇";
  } else {
    input.disabled = true;
  }
}

function renderPlayers() {
  const bar = $("#playersBar");
  bar.innerHTML = "";
  (state.room?.players || []).forEach(p => {
    const el = document.createElement("div");
    el.className = "player-chip p"+p.colorIndex+(p.id===state.playerId?" me":"");
    const img = JOB_IMG[p.job] || "";
    el.innerHTML = '<div class="player-main"><img class="player-job-icon" src="'+img+'" alt="'+escapeHtml(JOB_NAME[p.job] || "")+'"><b>'+escapeHtml(p.name)+'</b></div><div class="player-record-space" aria-hidden="true"></div>';
    bar.appendChild(el);
  });
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  const r = state.room;
  const me = r?.players.find(p => p.id === state.playerId);
  for (let i=0;i<9;i++) {
    const c = r?.board?.[i] || {owner:null,locked:false};
    const owner = r?.players.find(p => p.id === c.owner);
    const btn = document.createElement("button");
    btn.className = "cell"+(i===4?" center":"")+(c.locked?" locked":"");
    if (owner) btn.classList.add("p"+owner.colorIndex);
    const canClaim = r?.phase === "claiming" &&
      me?.status === "claiming" &&
      r?.currentClaimPlayerId === state.playerId &&
      !r?.roundTouched?.[i] &&
      c.owner !== state.playerId &&
      (!(c.locked && c.owner !== state.playerId) || (me?.job === "priest" && i === 4));
    if (canClaim) btn.classList.add("claimable");
    btn.disabled = !canClaim;
    btn.innerHTML = owner ? '<span class="owner">'+escapeHtml(owner.name)+'</span>' : "";
    btn.onclick = () => state.ws?.send(JSON.stringify({type:"claim", index:i}));
    board.appendChild(btn);
  }
}

function startTimer(deadline) {
  clearInterval(state.timerId);
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline-Date.now())/1000));
    $("#timer").textContent = String(left);
  };
  tick();
  state.timerId = setInterval(tick, 250);
}

function renderResults(scores) {
  const box = $("#resultList");
  box.innerHTML = "";
  scores.forEach((x,i) => {
    const row = document.createElement("div");
    row.className = "result-card p"+i;
    const accuracy = x.totalAnswers ? Math.round((x.correctAnswers / x.totalAnswers) * 100) : 0;
    const seconds = (x.totalAnswerMs / 1000).toFixed(1);
    row.innerHTML =
      '<div class="result-visual">' +
        '<div class="result-art-line">' +
          (i === 0 ? '<img class="result-winner-icon" src="/assets/winner.png" alt="Winner">' : '') +
          '<img class="result-job-icon" src="'+(JOB_IMG[x.job] || "")+'" alt="'+escapeHtml(JOB_NAME[x.job] || "")+'">' +
        '</div>' +
        '<div class="result-name">'+escapeHtml(x.name)+'</div>' +
      '</div>' +
      '<div class="result-stats">' +
        '<div><span>總得分</span><strong>'+x.score+'</strong></div>' +
        '<div><span>答對率</span><strong>'+accuracy+'%</strong></div>' +
        '<div><span>全部曾經取得的格子數</span><strong>'+(x.gainedCellsTotal ?? x.occupiedCells ?? 0)+'</strong></div>' +
        '<div><span>總答題時間</span><strong>'+seconds+' 秒</strong></div>' +
      '</div>';
    box.appendChild(row);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

setInterval(() => {
  if (pageIs("lobbyPage")) refreshRooms();
}, 3000);
