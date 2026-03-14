const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const PORT = process.env.PORT || 3001;
const MAX_FEED_ITEMS = 40;

const DEFAULT_SETTINGS = {
  pointsToWin: 5,
  chaosMode: false,
  chaosIntervalSeconds: 180,
  allowPhysicalQuests: true,
};

const lobbies = {};
const chaosTimers = {};

function normalizeOrigin(value) {
  if (!value) return "";
  return String(value).trim().replace(/\/+$/, "");
}

function buildAllowedOrigins() {
  const raw = [
    process.env.CLIENT_URL,
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  return [...new Set(raw.map(normalizeOrigin).filter(Boolean))];
}

const allowedOrigins = buildAllowedOrigins();

function isAllowedOrigin(origin) {
  if (!origin) return true;

  const cleanOrigin = normalizeOrigin(origin);

  if (allowedOrigins.includes(cleanOrigin)) return true;

  try {
    const url = new URL(cleanOrigin);
    if (url.hostname.endsWith(".vercel.app")) return true;
    if (url.hostname.endsWith(".onrender.com")) return true;
  } catch (error) {
    return false;
  }

  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST"],
  })
);

app.get("/", (_req, res) => {
  res.send("You Got Got server is running");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    allowedOrigins,
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Socket.IO CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST"],
  },
});

function generateLobbyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createUniqueLobbyCode() {
  let code = generateLobbyCode();
  while (lobbies[code]) {
    code = generateLobbyCode();
  }
  return code;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getQuestPools(allowPhysicalQuests) {
  const pools = {
    conversation: [
      "Get TARGET to say your name",
      "Make TARGET ask you a question",
      "Get TARGET to mention food",
      'Make TARGET say "okay"',
      "Get TARGET to mention music",
      "Make TARGET ask what you're doing",
      "Get TARGET to mention the weekend",
      'Make TARGET say "bro"',
    ],
    reaction: [
      "Make TARGET laugh",
      'Get TARGET to say "wait"',
      'Make TARGET say "what?"',
      "Get TARGET to sound confused",
      "Make TARGET react with surprise",
      'Get TARGET to say "no way"',
      "Make TARGET pause before answering you",
      "Get TARGET to repeat what you said",
    ],
    trap: [
      "Get TARGET to ask what your quest is",
      "Make TARGET accuse someone of being suspicious",
      'Get TARGET to say "prove it"',
      "Make TARGET ask if they are your target",
      "Get TARGET to ask who you suspect",
      'Make TARGET say "you\'re lying"',
      "Get TARGET to deny something you just said",
      'Make TARGET say "that sounds fake"',
    ],
    misdirection: [
      "Convince TARGET someone sus'd them",
      "Make TARGET think somebody else is targeting them",
      'Get TARGET to say "that\'s suspicious"',
      "Make TARGET defend the wrong person",
      "Get TARGET to ask about another player's quest",
      "Make TARGET think you already completed your quest",
      "Get TARGET to name the wrong suspect",
      "Make TARGET say someone else is acting weird",
    ],
  };

  if (allowPhysicalQuests) {
    pools.physical = [
      "Make TARGET stand up",
      "Get TARGET to grab their phone",
      "Make TARGET point at someone",
      "Get TARGET to switch seats",
      "Make TARGET look around the room",
      "Get TARGET to hand their phone to someone for a second",
      "Make TARGET tap their screen twice",
      "Get TARGET to move closer to another player",
    ];
  }

  return pools;
}

function createSmartQuest(_playerName, targetName, allowPhysicalQuests) {
  const questPools = getQuestPools(allowPhysicalQuests);
  const categoryKeys = Object.keys(questPools);
  const category = pickRandom(categoryKeys);
  const questTemplate = pickRandom(questPools[category]);
  return questTemplate.replaceAll("TARGET", targetName);
}

function createPlayerStats() {
  return {
    gotSent: 0,
    gotApproved: 0,
    gotDenied: 0,
    gotReceived: 0,
    susSent: 0,
    susCorrect: 0,
    susWrong: 0,
    timesSusd: 0,
  };
}

function createPlayer(id, name) {
  return {
    id,
    name,
    points: 0,
    targetId: null,
    targetName: "",
    quest: "",
    stats: createPlayerStats(),
  };
}

function getPlayer(lobby, id) {
  return lobby.players.find((p) => p.id === id) || null;
}

function findLobbyByPlayer(id) {
  for (const code of Object.keys(lobbies)) {
    const lobby = lobbies[code];
    if (lobby.players.find((p) => p.id === id)) {
      return code;
    }
  }
  return null;
}

function addFeedItem(lobby, text) {
  lobby.feed.unshift({
    id: Date.now() + Math.floor(Math.random() * 100000),
    text,
  });

  if (lobby.feed.length > MAX_FEED_ITEMS) {
    lobby.feed = lobby.feed.slice(0, MAX_FEED_ITEMS);
  }
}

function clearPlayerAssignments(lobby) {
  lobby.players.forEach((player) => {
    player.targetId = null;
    player.targetName = "";
    player.quest = "";
  });
}

function assignTargets(lobby) {
  const players = shuffle(lobby.players);

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    const target = players[(i + 1) % players.length];
    player.targetId = target.id;
    player.targetName = target.name;
    player.quest = createSmartQuest(
      player.name,
      target.name,
      lobby.settings.allowPhysicalQuests
    );
  }
}

function reassignAllQuestsKeepTargets(lobby) {
  lobby.players.forEach((player) => {
    const target = getPlayer(lobby, player.targetId);
    if (!target) return;
    player.targetName = target.name;
    player.quest = createSmartQuest(
      player.name,
      target.name,
      lobby.settings.allowPhysicalQuests
    );
  });
}

function newQuestForPlayer(lobby, playerId) {
  const player = getPlayer(lobby, playerId);
  if (!player) return;

  const targets = lobby.players.filter((p) => p.id !== player.id);
  if (!targets.length) return;

  const target = targets.find((p) => p.id === player.targetId) || pickRandom(targets);
  player.targetId = target.id;
  player.targetName = target.name;
  player.quest = createSmartQuest(
    player.name,
    target.name,
    lobby.settings.allowPhysicalQuests
  );
}

function stopChaosTimer(lobbyCode) {
  if (chaosTimers[lobbyCode]) {
    clearInterval(chaosTimers[lobbyCode]);
    delete chaosTimers[lobbyCode];
  }
}

function startChaosTimer(lobbyCode) {
  stopChaosTimer(lobbyCode);

  const lobby = lobbies[lobbyCode];
  if (!lobby) return;
  if (!lobby.started || lobby.gameOver || !lobby.settings.chaosMode) return;

  const intervalMs = Math.max(30, lobby.settings.chaosIntervalSeconds) * 1000;

  chaosTimers[lobbyCode] = setInterval(() => {
    const currentLobby = lobbies[lobbyCode];
    if (!currentLobby || !currentLobby.started || currentLobby.gameOver) {
      stopChaosTimer(lobbyCode);
      return;
    }

    reassignAllQuestsKeepTargets(currentLobby);
    addFeedItem(currentLobby, "Chaos Mode: everyone's quest changed");
    io.to(lobbyCode).emit("chaosTriggered", { at: Date.now() });
    emitLobby(lobbyCode);
  }, intervalMs);
}

function buildAwards(lobby) {
  const players = [...lobby.players];

  function topBy(statKey, filterFn, title, subtitle) {
    const eligible = players.filter(filterFn || (() => true));
    if (!eligible.length) return null;

    const topValue = Math.max(...eligible.map((p) => p.stats[statKey] || 0));
    if (topValue <= 0) return null;

    const winners = eligible.filter((p) => (p.stats[statKey] || 0) === topValue);

    return {
      title,
      subtitle,
      value: topValue,
      winners: winners.map((p) => ({ id: p.id, name: p.name })),
    };
  }

  return [
    topBy("gotApproved", () => true, "Most Dangerous", "Most approved GOTs"),
    topBy("susCorrect", () => true, "Best Detector", "Most correct SUS calls"),
    topBy("timesSusd", () => true, "Most Sus", "Accused the most times"),
    topBy("susWrong", () => true, "Wild Guesser", "Most wrong SUS calls"),
    topBy("gotDenied", () => true, "Escape Artist", "Most denied GOT attempts"),
  ].filter(Boolean);
}

function buildResults(lobby) {
  const leaderboard = [...lobby.players]
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return a.name.localeCompare(b.name);
    })
    .map((player) => ({
      id: player.id,
      name: player.name,
      points: player.points,
      stats: { ...player.stats },
    }));

  const totals = leaderboard.reduce(
    (acc, player) => {
      acc.gotSent += player.stats.gotSent;
      acc.gotApproved += player.stats.gotApproved;
      acc.gotDenied += player.stats.gotDenied;
      acc.susSent += player.stats.susSent;
      acc.susCorrect += player.stats.susCorrect;
      acc.susWrong += player.stats.susWrong;
      return acc;
    },
    {
      gotSent: 0,
      gotApproved: 0,
      gotDenied: 0,
      susSent: 0,
      susCorrect: 0,
      susWrong: 0,
    }
  );

  return {
    leaderboard,
    totals,
    awards: buildAwards(lobby),
  };
}

function checkWinner(lobby, lobbyCode) {
  if (!lobby.started || lobby.gameOver) return;

  const winner = lobby.players.find(
    (player) => player.points >= lobby.settings.pointsToWin
  );

  if (!winner) return;

  lobby.gameOver = true;
  lobby.winner = {
    id: winner.id,
    name: winner.name,
    points: winner.points,
  };
  lobby.results = buildResults(lobby);

  addFeedItem(lobby, `${winner.name} won the game with ${winner.points} points`);
  stopChaosTimer(lobbyCode);
}

function publicLobby(lobbyCode) {
  const lobby = lobbies[lobbyCode];

  return {
    lobbyCode,
    hostId: lobby.hostId,
    started: lobby.started,
    gameOver: lobby.gameOver,
    winner: lobby.winner,
    settings: lobby.settings,
    players: lobby.players,
    gotRequests: lobby.gotRequests,
    susRequests: lobby.susRequests,
    lastSusReveal: lobby.lastSusReveal,
    feed: lobby.feed,
    winPoints: lobby.settings.pointsToWin,
    results: lobby.results,
  };
}

function emitLobby(lobbyCode) {
  io.to(lobbyCode).emit("lobbyUpdated", publicLobby(lobbyCode));
}

function resetLobbyForNewGame(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  stopChaosTimer(lobbyCode);

  lobby.started = true;
  lobby.gameOver = false;
  lobby.winner = null;
  lobby.results = null;
  lobby.gotRequests = [];
  lobby.susRequests = [];
  lobby.lastSusReveal = null;
  lobby.feed = [];

  lobby.players.forEach((player) => {
    player.points = 0;
    player.stats = createPlayerStats();
  });

  assignTargets(lobby);
  addFeedItem(lobby, "A new game started");

  if (lobby.settings.chaosMode) {
    addFeedItem(
      lobby,
      `Chaos Mode is on (${lobby.settings.chaosIntervalSeconds}s interval)`
    );
    startChaosTimer(lobbyCode);
  }
}

function sanitizeSettings(input) {
  const pointsOptions = [3, 5, 7];
  const intervalOptions = [120, 180, 300];

  return {
    pointsToWin: pointsOptions.includes(Number(input?.pointsToWin))
      ? Number(input.pointsToWin)
      : DEFAULT_SETTINGS.pointsToWin,
    chaosMode: Boolean(input?.chaosMode),
    chaosIntervalSeconds: intervalOptions.includes(Number(input?.chaosIntervalSeconds))
      ? Number(input?.chaosIntervalSeconds)
      : DEFAULT_SETTINGS.chaosIntervalSeconds,
    allowPhysicalQuests:
      typeof input?.allowPhysicalQuests === "boolean"
        ? input.allowPhysicalQuests
        : DEFAULT_SETTINGS.allowPhysicalQuests,
  };
}

function removePlayer(playerId) {
  const lobbyCode = findLobbyByPlayer(playerId);
  if (!lobbyCode) return;

  const lobby = lobbies[lobbyCode];
  const leavingPlayer = getPlayer(lobby, playerId);

  lobby.players = lobby.players.filter((p) => p.id !== playerId);

  lobby.gotRequests = lobby.gotRequests.filter(
    (r) => r.fromId !== playerId && r.toId !== playerId
  );

  lobby.susRequests = lobby.susRequests.filter(
    (r) => r.fromId !== playerId && r.toId !== playerId
  );

  if (lobby.players.length === 0) {
    stopChaosTimer(lobbyCode);
    delete lobbies[lobbyCode];
    return;
  }

  if (leavingPlayer) {
    addFeedItem(lobby, `${leavingPlayer.name} left the lobby`);
  }

  if (lobby.hostId === playerId) {
    lobby.hostId = lobby.players[0].id;
    const newHost = getPlayer(lobby, lobby.hostId);
    if (newHost) {
      addFeedItem(lobby, `${newHost.name} is now the host`);
    }
  }

  if (lobby.players.length < 2) {
    stopChaosTimer(lobbyCode);
    lobby.started = false;
    lobby.gameOver = false;
    lobby.winner = null;
    lobby.results = null;
    lobby.gotRequests = [];
    lobby.susRequests = [];
    lobby.lastSusReveal = null;
    clearPlayerAssignments(lobby);
    addFeedItem(lobby, "Not enough players to continue");
  } else if (lobby.started) {
    assignTargets(lobby);
    addFeedItem(lobby, "Targets and quests were reassigned");
    if (lobby.settings.chaosMode && !lobby.gameOver) {
      startChaosTimer(lobbyCode);
    }
  }

  emitLobby(lobbyCode);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("createLobby", ({ name }, cb) => {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      cb?.({ success: false, message: "Name is required" });
      return;
    }

    const code = createUniqueLobbyCode();

    lobbies[code] = {
      hostId: socket.id,
      started: false,
      gameOver: false,
      winner: null,
      results: null,
      settings: { ...DEFAULT_SETTINGS },
      players: [createPlayer(socket.id, trimmedName)],
      gotRequests: [],
      susRequests: [],
      lastSusReveal: null,
      feed: [{ id: Date.now(), text: `${trimmedName} created the lobby` }],
    };

    socket.join(code);
    emitLobby(code);

    cb?.({ success: true, lobby: publicLobby(code) });
  });

  socket.on("joinLobby", ({ name, lobbyCode }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const trimmedName = String(name || "").trim();
    const lobby = lobbies[code];

    if (!trimmedName) {
      cb?.({ success: false, message: "Name is required" });
      return;
    }

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (lobby.started) {
      cb?.({ success: false, message: "Game already started" });
      return;
    }

    lobby.players.push(createPlayer(socket.id, trimmedName));
    addFeedItem(lobby, `${trimmedName} joined the lobby`);

    socket.join(code);
    emitLobby(code);

    cb?.({ success: true, lobby: publicLobby(code) });
  });

  socket.on("updateSettings", ({ lobbyCode, settings }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (socket.id !== lobby.hostId) {
      cb?.({ success: false, message: "Only the host can update settings" });
      return;
    }

    if (lobby.started) {
      cb?.({
        success: false,
        message: "Settings can only be changed before the game starts",
      });
      return;
    }

    lobby.settings = sanitizeSettings(settings);
    addFeedItem(lobby, "The host updated game settings");
    emitLobby(code);

    cb?.({ success: true, settings: lobby.settings });
  });

  socket.on("startGame", ({ lobbyCode }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (socket.id !== lobby.hostId) {
      cb?.({ success: false, message: "Only the host can start the game" });
      return;
    }

    if (lobby.players.length < 2) {
      cb?.({ success: false, message: "Need at least 2 players" });
      return;
    }

    resetLobbyForNewGame(code);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("playAgain", ({ lobbyCode }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (socket.id !== lobby.hostId) {
      cb?.({ success: false, message: "Only the host can restart the game" });
      return;
    }

    if (lobby.players.length < 2) {
      cb?.({ success: false, message: "Need at least 2 players" });
      return;
    }

    resetLobbyForNewGame(code);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("sendGotRequest", ({ lobbyCode }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (!lobby.started || lobby.gameOver) {
      cb?.({ success: false, message: "Game is not active" });
      return;
    }

    const player = getPlayer(lobby, socket.id);
    if (!player || !player.targetId) {
      cb?.({ success: false, message: "No valid target" });
      return;
    }

    const target = getPlayer(lobby, player.targetId);
    if (!target) {
      cb?.({ success: false, message: "Target not found" });
      return;
    }

    const existing = lobby.gotRequests.find(
      (r) => r.fromId === player.id && r.toId === target.id
    );

    if (existing) {
      cb?.({ success: false, message: "GOT request already pending" });
      return;
    }

    player.stats.gotSent += 1;
    target.stats.gotReceived += 1;

    lobby.gotRequests.push({
      fromId: player.id,
      fromName: player.name,
      toId: target.id,
      toName: target.name,
    });

    addFeedItem(lobby, `${player.name} sent a GOT request to ${target.name}`);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("respondGotRequest", ({ lobbyCode, fromId, approved }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (!lobby.started || lobby.gameOver) {
      cb?.({ success: false, message: "Game is not active" });
      return;
    }

    const requestIndex = lobby.gotRequests.findIndex(
      (r) => r.fromId === fromId && r.toId === socket.id
    );

    if (requestIndex === -1) {
      cb?.({ success: false, message: "GOT request not found" });
      return;
    }

    const req = lobby.gotRequests[requestIndex];
    lobby.gotRequests.splice(requestIndex, 1);

    const attacker = getPlayer(lobby, req.fromId);
    const defender = getPlayer(lobby, req.toId);

    if (!attacker || !defender) {
      emitLobby(code);
      cb?.({ success: false, message: "Players not found" });
      return;
    }

    if (approved) {
      attacker.points += 1;
      attacker.stats.gotApproved += 1;
      addFeedItem(
        lobby,
        `${defender.name} approved the GOT. ${attacker.name} gained 1 point`
      );
      newQuestForPlayer(lobby, attacker.id);
      addFeedItem(lobby, `${attacker.name} received a new quest`);
    } else {
      attacker.stats.gotDenied += 1;
      addFeedItem(lobby, `${defender.name} denied the GOT`);
      newQuestForPlayer(lobby, attacker.id);
      newQuestForPlayer(lobby, defender.id);
      addFeedItem(lobby, `${attacker.name} and ${defender.name} received new quests`);
    }

    checkWinner(lobby, code);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("sendSusRequest", ({ lobbyCode, targetId, guessedQuest }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (!lobby.started || lobby.gameOver) {
      cb?.({ success: false, message: "Game is not active" });
      return;
    }

    const from = getPlayer(lobby, socket.id);
    const to = getPlayer(lobby, targetId);

    if (!from || !to) {
      cb?.({ success: false, message: "Player not found" });
      return;
    }

    if (!guessedQuest || !String(guessedQuest).trim()) {
      cb?.({ success: false, message: "Guess is required" });
      return;
    }

    const existing = lobby.susRequests.find(
      (r) => r.fromId === from.id && r.toId === to.id
    );

    if (existing) {
      cb?.({ success: false, message: "SUS request already pending" });
      return;
    }

    from.stats.susSent += 1;
    to.stats.timesSusd += 1;

    lobby.susRequests.push({
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      guessedQuest: String(guessedQuest).trim(),
    });

    addFeedItem(lobby, `${from.name} sus'd ${to.name}`);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("susGotMe", ({ lobbyCode, fromId }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (!lobby.started || lobby.gameOver) {
      cb?.({ success: false, message: "Game is not active" });
      return;
    }

    const index = lobby.susRequests.findIndex(
      (r) => r.fromId === fromId && r.toId === socket.id
    );

    if (index === -1) {
      cb?.({ success: false, message: "SUS request not found" });
      return;
    }

    const req = lobby.susRequests[index];
    lobby.susRequests.splice(index, 1);

    const accuser = getPlayer(lobby, req.fromId);
    const accused = getPlayer(lobby, req.toId);

    if (!accuser || !accused) {
      emitLobby(code);
      cb?.({ success: false, message: "Players not found" });
      return;
    }

    const revealedQuest = accused.quest;

    accuser.points += 1;
    accuser.stats.susCorrect += 1;

    lobby.lastSusReveal = {
      id: Date.now(),
      fromId: accuser.id,
      fromName: accuser.name,
      toId: accused.id,
      toName: accused.name,
      guessedQuest: req.guessedQuest,
      revealedQuest,
      result: "got-me",
    };

    addFeedItem(lobby, `${accused.name} clicked Got Me. ${accuser.name} gained 1 point`);
    addFeedItem(lobby, `${accused.name}'s quest was revealed: ${revealedQuest}`);

    newQuestForPlayer(lobby, accuser.id);
    newQuestForPlayer(lobby, accused.id);
    addFeedItem(lobby, `${accuser.name} and ${accused.name} received new quests`);

    checkWinner(lobby, code);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("susWrong", ({ lobbyCode, fromId }, cb) => {
    const code = String(lobbyCode || "").trim().toUpperCase();
    const lobby = lobbies[code];

    if (!lobby) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    if (!lobby.started || lobby.gameOver) {
      cb?.({ success: false, message: "Game is not active" });
      return;
    }

    const index = lobby.susRequests.findIndex(
      (r) => r.fromId === fromId && r.toId === socket.id
    );

    if (index === -1) {
      cb?.({ success: false, message: "SUS request not found" });
      return;
    }

    const req = lobby.susRequests[index];
    lobby.susRequests.splice(index, 1);

    const accuser = getPlayer(lobby, req.fromId);
    const accused = getPlayer(lobby, req.toId);

    if (!accuser || !accused) {
      emitLobby(code);
      cb?.({ success: false, message: "Players not found" });
      return;
    }

    const revealedQuest = accused.quest;

    accuser.points -= 1;
    accused.points += 1;
    accuser.stats.susWrong += 1;

    lobby.lastSusReveal = {
      id: Date.now(),
      fromId: accuser.id,
      fromName: accuser.name,
      toId: accused.id,
      toName: accused.name,
      guessedQuest: req.guessedQuest,
      revealedQuest,
      result: "wrong",
    };

    addFeedItem(
      lobby,
      `${accused.name} clicked You're Wrong. ${accuser.name} lost 1 point and ${accused.name} gained 1 point`
    );
    addFeedItem(lobby, `${accused.name}'s quest was revealed: ${revealedQuest}`);

    newQuestForPlayer(lobby, accuser.id);
    newQuestForPlayer(lobby, accused.id);
    addFeedItem(lobby, `${accuser.name} and ${accused.name} received new quests`);

    checkWinner(lobby, code);
    emitLobby(code);

    cb?.({ success: true });
  });

  socket.on("leaveLobby", (cb) => {
    const lobbyCode = findLobbyByPlayer(socket.id);
    if (!lobbyCode) {
      cb?.({ success: false, message: "Lobby not found" });
      return;
    }

    socket.leave(lobbyCode);
    removePlayer(socket.id);
    socket.emit("leftLobby");

    cb?.({ success: true });
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    removePlayer(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Allowed origins:", allowedOrigins);
});
