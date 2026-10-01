const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const JOB_NAME = {warrior:"戰士",mage:"法師",archer:"弓手",priest:"牧師"};
const DIFF_NAME = {basic:"基本",advanced:"進階",challenge:"挑戰"};

const state = {
  name: localStorage.getItem("gc_name") || "",
  job: localStorage.getItem("gc_job") || "",
  roomId: null,
  playerId: null,
  room: null,
  ws: null,
  timerId: null
};

$("#playerName").value = state.name;

function page(id) {
  $$(".page").forEach(x => x.classList.toggle("active", x.id === id));
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

$("#fightBtn").addEventListener("click", () => {
  const name = $("#playerName").value.trim();
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
        difficulty:$("#difficulty").value,
        training
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "建立失敗");
    joinRoom(data.id);
  } catch (e) { toast(e.message); }
}
$("#createRoomBtn").addEventListener("click", () => createRoom(false));
$("#trainingRoomBtn").addEventListener("click", () => createRoom(true));

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
      return;
    }
    if (msg.type === "answerResult") {
      if (msg.correct) {
        $("#answerState").textContent = msg.claims === 2 ? "答對，可佔 2 格" : "答對，可佔 1 格";
        $("#answerInput").disabled = true;
      } else {
        $("#answerState").textContent = "答錯";
        $("#answerInput").disabled = true;
      }
      renderBoard();
      return;
    }
    if (msg.type === "claimError") toast(msg.message);
    if (msg.type === "timeout") {
      $("#answerState").textContent = "時間到";
      $("#answerInput").disabled = true;
    }
  };
  ws.onclose = () => {
    if (pageIs("gamePage") && state.room?.state !== "finished") toast("已離開房間");
  };
  ws.onerror = () => toast("無法加入房間");
}

function pageIs(id) { return $("#"+id).classList.contains("active"); }

$("#startBtn").addEventListener("click", () => {
  state.ws?.send(JSON.stringify({type:"start"}));
});

$("#answerForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!state.room || state.room.state !== "playing") return;
  const raw = $("#answerInput").value.trim();
  if (!/^-?\d+$/.test(raw)) return toast("請輸入整數");
  state.ws?.send(JSON.stringify({type:"answer", answer:Number(raw)}));
});

$("#backLobbyBtn").addEventListener("click", () => {
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
  $("#difficultyText").textContent = DIFF_NAME[r.difficulty] || "";
  renderPlayers();
  renderBoard();

  if (r.state === "waiting") {
    $("#waitingPanel").classList.remove("hidden");
    $("#battlePanel").classList.add("hidden");
    $("#resultPanel").classList.add("hidden");
    $("#roundText").textContent = "等待";
    $("#timer").textContent = "60";
    $("#waitingText").textContent = r.players.length+"/3 人";
    const me = r.players.find(p => p.id === state.playerId);
    $("#startBtn").classList.toggle("hidden", !(me?.host && r.players.length >= 2));
    return;
  }

  if (r.state === "playing") {
    $("#waitingPanel").classList.add("hidden");
    $("#battlePanel").classList.remove("hidden");
    $("#resultPanel").classList.add("hidden");
    $("#roundText").textContent = "第 "+r.round+"/5 回合";
    $("#questionText").textContent = r.question?.text || "--";
    syncAnswerUI();
    startTimer(r.deadline);
    return;
  }

  if (r.state === "finished") {
    clearInterval(state.timerId);
    $("#waitingPanel").classList.add("hidden");
    $("#battlePanel").classList.add("hidden");
    $("#resultPanel").classList.remove("hidden");
    $("#roundText").textContent = "結算";
    $("#timer").textContent = "0";
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
    $("#answerState").textContent = "作答";
  } else if (me.status === "claiming") {
    input.disabled = true;
    $("#answerState").textContent = me.claimRemaining === 2 ? "請佔 2 格" : "請選 1 格";
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
    el.innerHTML = "<b>"+escapeHtml(p.name)+"</b><small>"+JOB_NAME[p.job]+" · "+statusText(p.status)+"</small>";
    bar.appendChild(el);
  });
}
function statusText(s) {
  return ({waiting:"等待",answering:"答題",claiming:"佔領",done:"完成"})[s] || s;
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
    const canClaim = me?.status === "claiming" && c.owner !== state.playerId && !(c.locked && c.owner !== state.playerId);
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
    row.className = "result-row";
    row.innerHTML = "<span>"+(i+1)+". "+escapeHtml(x.name)+" · "+JOB_NAME[x.job]+"</span><b>"+x.score+" 分</b>";
    box.appendChild(row);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

setInterval(() => {
  if (pageIs("lobbyPage")) refreshRooms();
}, 3000);
