import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const socket = io(SERVER_URL);

const TABS = {
  GAME: "game",
  REQUESTS: "requests",
  FEED: "feed",
  LOBBY: "lobby",
};

const DEFAULT_SETTINGS = {
  pointsToWin: 5,
  chaosMode: false,
  chaosIntervalSeconds: 180,
  allowPhysicalQuests: true,
};

const MOTION_STATUS = {
  IDLE: "idle",
  ENABLED: "enabled",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
};

export default function App() {
  const [name, setName] = useState("");
  const [lobbyCodeInput, setLobbyCodeInput] = useState("");
  const [lobby, setLobby] = useState(null);
  const [susPlayer, setSusPlayer] = useState("");
  const [susGuess, setSusGuess] = useState("");
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState(TABS.GAME);
  const [missionHidden, setMissionHidden] = useState(true);
  const [settingsDraft, setSettingsDraft] = useState(DEFAULT_SETTINGS);
  const [motionStatus, setMotionStatus] = useState(MOTION_STATUS.IDLE);

  const audioContextRef = useRef(null);
  const prevPendingCountRef = useRef(0);
  const prevWinnerIdRef = useRef(null);
  const prevSusRevealIdRef = useRef(null);
  const prevStartedRef = useRef(false);
  const prevChaosPulseRef = useRef(0);
  const motionEnabledRef = useRef(false);
  const lastMotionHideRef = useRef(0);

  const me = useMemo(() => {
    return lobby?.players?.find((p) => p.id === socket.id) || null;
  }, [lobby]);

  const incomingGot = useMemo(() => {
    return lobby?.gotRequests?.filter((r) => r.toId === socket.id) || [];
  }, [lobby]);

  const incomingSus = useMemo(() => {
    return lobby?.susRequests?.filter((r) => r.toId === socket.id) || [];
  }, [lobby]);

  const otherPlayers = useMemo(() => {
    return lobby?.players?.filter((p) => p.id !== socket.id) || [];
  }, [lobby]);

  const isHost = lobby?.hostId === socket.id;
  const pendingCount = incomingGot.length + incomingSus.length;

  function ensureAudioContext() {
    if (typeof window === "undefined") return null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => {});
    }

    return audioContextRef.current;
  }

  function unlockAudio() {
    ensureAudioContext();
  }

  function vibrate(pattern) {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }

  function playToneSequence(tones) {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    tones.forEach((tone) => {
      const start = now + (tone.delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = tone.type || "sine";
      osc.frequency.setValueAtTime(tone.frequency, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(
        tone.volume || 0.03,
        start + 0.01
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + tone.duration + 0.02);
    });
  }

  function playSoftRequestChime() {
    playToneSequence([
      { frequency: 740, duration: 0.12, volume: 0.018, delay: 0 },
      { frequency: 880, duration: 0.16, volume: 0.014, delay: 0.09 },
    ]);
  }

  function playSoftSusChime() {
    playToneSequence([
      { frequency: 620, duration: 0.12, volume: 0.02, delay: 0 },
      { frequency: 760, duration: 0.14, volume: 0.016, delay: 0.08 },
    ]);
  }

  function playWinChime() {
    playToneSequence([
      { frequency: 523.25, duration: 0.14, volume: 0.02, delay: 0 },
      { frequency: 659.25, duration: 0.16, volume: 0.02, delay: 0.12 },
      { frequency: 783.99, duration: 0.22, volume: 0.025, delay: 0.24 },
    ]);
  }

  function playChaosChime() {
    playToneSequence([
      { frequency: 560, duration: 0.09, volume: 0.018, delay: 0 },
      { frequency: 700, duration: 0.09, volume: 0.018, delay: 0.08 },
      { frequency: 840, duration: 0.13, volume: 0.02, delay: 0.16 },
    ]);
  }

  function triggerMotionHide() {
    const now = Date.now();
    if (now - lastMotionHideRef.current < 1000) return;
    lastMotionHideRef.current = now;
    setMissionHidden(true);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      setMissionHidden(true);
    }
  }

  function handleDeviceMotion(event) {
    if (!motionEnabledRef.current) return;

    const z = event?.accelerationIncludingGravity?.z;
    if (typeof z === "number" && z < -7) {
      triggerMotionHide();
    }
  }

  function handleDeviceOrientation(event) {
    if (!motionEnabledRef.current) return;

    const beta = event?.beta;
    if (typeof beta === "number" && Math.abs(beta) > 140) {
      triggerMotionHide();
    }
  }

  function attachMotionListeners() {
    if (typeof window === "undefined") {
      setMotionStatus(MOTION_STATUS.UNSUPPORTED);
      return;
    }

    const hasDeviceMotion = "DeviceMotionEvent" in window;
    const hasDeviceOrientation = "DeviceOrientationEvent" in window;

    if (!hasDeviceMotion && !hasDeviceOrientation) {
      setMotionStatus(MOTION_STATUS.UNSUPPORTED);
      return;
    }

    motionEnabledRef.current = true;
    setMotionStatus(MOTION_STATUS.ENABLED);

    window.addEventListener("devicemotion", handleDeviceMotion);
    window.addEventListener("deviceorientation", handleDeviceOrientation);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  function detachMotionListeners() {
    motionEnabledRef.current = false;
    window.removeEventListener("devicemotion", handleDeviceMotion);
    window.removeEventListener("deviceorientation", handleDeviceOrientation);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }

  async function enableMotionPrivacy() {
    unlockAudio();

    if (typeof window === "undefined") {
      setMotionStatus(MOTION_STATUS.UNSUPPORTED);
      setMessage("Motion privacy is not supported here");
      return;
    }

    try {
      if (
        typeof window.DeviceMotionEvent !== "undefined" &&
        typeof window.DeviceMotionEvent.requestPermission === "function"
      ) {
        const response = await window.DeviceMotionEvent.requestPermission();
        if (response !== "granted") {
          setMotionStatus(MOTION_STATUS.DENIED);
          setMessage("Motion privacy permission was denied");
          return;
        }
      }

      if (
        typeof window.DeviceOrientationEvent !== "undefined" &&
        typeof window.DeviceOrientationEvent.requestPermission === "function"
      ) {
        const response = await window.DeviceOrientationEvent.requestPermission();
        if (response !== "granted") {
          setMotionStatus(MOTION_STATUS.DENIED);
          setMessage("Motion privacy permission was denied");
          return;
        }
      }

      attachMotionListeners();
      setMessage("Motion privacy enabled");
    } catch (error) {
      console.error("enableMotionPrivacy error:", error);
      setMotionStatus(MOTION_STATUS.DENIED);
      setMessage("Could not enable motion privacy");
    }
  }

  useEffect(() => {
    function onLobbyUpdated(data) {
      setLobby(data);
      if (data?.settings) {
        setSettingsDraft(data.settings);
      }
    }

    function onLeftLobby() {
      setLobby(null);
      setSusPlayer("");
      setSusGuess("");
      setMessage("");
      setActiveTab(TABS.GAME);
      setMissionHidden(true);
      setSettingsDraft(DEFAULT_SETTINGS);
      prevPendingCountRef.current = 0;
      prevWinnerIdRef.current = null;
      prevSusRevealIdRef.current = null;
      prevStartedRef.current = false;
      prevChaosPulseRef.current = 0;
    }

    function onChaosTriggered(payload) {
      const pulse = payload?.at || Date.now();
      if (pulse !== prevChaosPulseRef.current) {
        prevChaosPulseRef.current = pulse;
        vibrate([60, 50, 60]);
        playChaosChime();
        setMissionHidden(true);
        setMessage("Chaos Mode: everyone got a new quest");
      }
    }

    socket.on("lobbyUpdated", onLobbyUpdated);
    socket.on("leftLobby", onLeftLobby);
    socket.on("chaosTriggered", onChaosTriggered);

    return () => {
      socket.off("lobbyUpdated", onLobbyUpdated);
      socket.off("leftLobby", onLeftLobby);
      socket.off("chaosTriggered", onChaosTriggered);
    };
  }, []);

  useEffect(() => {
    return () => {
      detachMotionListeners();
    };
  }, []);

  useEffect(() => {
    if (!lobby) return;

    const currentPending = pendingCount;
    const previousPending = prevPendingCountRef.current;

    if (currentPending > previousPending) {
      vibrate([90]);
      playSoftRequestChime();
    }

    prevPendingCountRef.current = currentPending;
  }, [pendingCount, lobby]);

  useEffect(() => {
    if (!lobby) return;

    const winnerId = lobby.winner?.id || null;
    if (winnerId && winnerId !== prevWinnerIdRef.current) {
      vibrate([120, 80, 120]);
      playWinChime();
      setMissionHidden(true);
    }

    prevWinnerIdRef.current = winnerId;
  }, [lobby]);

  useEffect(() => {
    if (!lobby?.lastSusReveal) return;

    const revealId = lobby.lastSusReveal.id;
    if (revealId && revealId !== prevSusRevealIdRef.current) {
      vibrate([70]);
      playSoftSusChime();
      setMissionHidden(true);
    }

    prevSusRevealIdRef.current = revealId;
  }, [lobby?.lastSusReveal]);

  useEffect(() => {
    if (!lobby) return;

    if (lobby.started && !prevStartedRef.current) {
      setMissionHidden(true);
    }

    prevStartedRef.current = lobby.started;
  }, [lobby]);

  useEffect(() => {
    if (activeTab !== TABS.GAME) {
      setMissionHidden(true);
    }
  }, [activeTab]);

  function createLobby() {
    unlockAudio();

    if (!name.trim()) {
      setMessage("Enter your name first");
      return;
    }

    socket.emit("createLobby", { name: name.trim() }, (res) => {
      if (res?.success) {
        setLobby(res.lobby);
        setSettingsDraft(res.lobby?.settings || DEFAULT_SETTINGS);
        setMessage("");
        setActiveTab(TABS.LOBBY);
        setMissionHidden(true);
      } else {
        setMessage(res?.message || "Could not create lobby");
      }
    });
  }

  function joinLobby() {
    unlockAudio();

    if (!name.trim() || !lobbyCodeInput.trim()) {
      setMessage("Enter your name and lobby code");
      return;
    }

    socket.emit(
      "joinLobby",
      {
        name: name.trim(),
        lobbyCode: lobbyCodeInput.trim().toUpperCase(),
      },
      (res) => {
        if (res?.success) {
          setLobby(res.lobby);
          setSettingsDraft(res.lobby?.settings || DEFAULT_SETTINGS);
          setMessage("");
          setActiveTab(TABS.LOBBY);
          setMissionHidden(true);
        } else {
          setMessage(res?.message || "Could not join lobby");
        }
      }
    );
  }

  function updateSettings(next) {
    unlockAudio();
    if (!lobby) return;

    socket.emit(
      "updateSettings",
      {
        lobbyCode: lobby.lobbyCode,
        settings: next,
      },
      (res) => {
        if (!res?.success) {
          setMessage(res?.message || "Could not update settings");
        } else {
          setMessage("Settings updated");
        }
      }
    );
  }

  function startGame() {
    unlockAudio();
    if (!lobby) return;

    socket.emit("startGame", { lobbyCode: lobby.lobbyCode }, (res) => {
      if (!res?.success) {
        setMessage(res?.message || "Could not start game");
      } else {
        setMessage("");
        setActiveTab(TABS.GAME);
        setMissionHidden(true);
      }
    });
  }

  function playAgain() {
    unlockAudio();
    if (!lobby) return;

    socket.emit("playAgain", { lobbyCode: lobby.lobbyCode }, (res) => {
      if (!res?.success) {
        setMessage(res?.message || "Could not restart game");
      } else {
        setMessage("");
        setActiveTab(TABS.GAME);
        setMissionHidden(true);
      }
    });
  }

  function sendGot() {
    unlockAudio();
    if (!lobby) return;

    socket.emit("sendGotRequest", { lobbyCode: lobby.lobbyCode }, (res) => {
      if (!res?.success) {
        setMessage(res?.message || "Could not send GOT request");
      } else {
        setMessage("GOT request sent");
        setMissionHidden(true);
      }
    });
  }

  function respondGot(fromId, approved) {
    unlockAudio();
    if (!lobby) return;

    socket.emit(
      "respondGotRequest",
      {
        lobbyCode: lobby.lobbyCode,
        fromId,
        approved,
      },
      (res) => {
        if (!res?.success) {
          setMessage(res?.message || "Could not respond to GOT request");
        } else {
          setMessage("");
          setMissionHidden(true);
        }
      }
    );
  }

  function sendSus() {
    unlockAudio();

    if (!lobby || !susPlayer || !susGuess.trim()) {
      setMessage("Choose a player and enter a guess");
      return;
    }

    socket.emit(
      "sendSusRequest",
      {
        lobbyCode: lobby.lobbyCode,
        targetId: susPlayer,
        guessedQuest: susGuess.trim(),
      },
      (res) => {
        if (!res?.success) {
          setMessage(res?.message || "Could not send SUS");
        } else {
          setSusGuess("");
          setSusPlayer("");
          setMessage("Sus sent");
          setActiveTab(TABS.FEED);
          setMissionHidden(true);
        }
      }
    );
  }

  function susGotMe(fromId) {
    unlockAudio();
    if (!lobby) return;

    socket.emit(
      "susGotMe",
      {
        lobbyCode: lobby.lobbyCode,
        fromId,
      },
      (res) => {
        if (!res?.success) {
          setMessage(res?.message || "Could not resolve SUS");
        } else {
          setMessage("");
          setMissionHidden(true);
        }
      }
    );
  }

  function susWrong(fromId) {
    unlockAudio();
    if (!lobby) return;

    socket.emit(
      "susWrong",
      {
        lobbyCode: lobby.lobbyCode,
        fromId,
      },
      (res) => {
        if (!res?.success) {
          setMessage(res?.message || "Could not resolve SUS");
        } else {
          setMessage("");
          setMissionHidden(true);
        }
      }
    );
  }

  function leaveLobby() {
    unlockAudio();

    socket.emit("leaveLobby", (res) => {
      if (!res?.success) {
        setMessage(res?.message || "Could not leave lobby");
      }
    });
  }

  function updateDraftField(key, value) {
    const next = { ...settingsDraft, [key]: value };
    setSettingsDraft(next);
    updateSettings(next);
  }

  function renderResultsPanel() {
    if (!lobby?.results) return null;

    return (
      <div className="tab-screen">
        <div className="winner-card">
          <div className="winner-label">Winner</div>
          <h2>{lobby.winner?.name || "Winner"}</h2>
          <p>
            {lobby.winner?.name} reached {lobby.winner?.points} points.
          </p>
          {isHost ? (
            <button className="success-btn" onClick={playAgain}>
              Play Again
            </button>
          ) : (
            <div className="subtle-note">Waiting for host to restart</div>
          )}
        </div>

        <div className="panel">
          <h3>Leaderboard</h3>
          <div className="results-list">
            {lobby.results.leaderboard.map((player, index) => (
              <div key={player.id} className="result-row">
                <div className="result-rank">#{index + 1}</div>
                <div className="result-main">
                  <div className="result-name">{player.name}</div>
                  <div className="result-meta">
                    {player.stats.gotApproved} GOT · {player.stats.susCorrect} correct SUS
                  </div>
                </div>
                <div className="result-points">{player.points} pts</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h3>Awards</h3>
          <div className="awards-grid">
            {lobby.results.awards.length ? (
              lobby.results.awards.map((award) => (
                <div key={award.title} className="award-card">
                  <div className="award-title">{award.title}</div>
                  <div className="award-winners">
                    {award.winners.map((winner) => winner.name).join(", ")}
                  </div>
                  <div className="award-subtitle">
                    {award.subtitle} · {award.value}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-card">No awards yet</div>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Round Totals</h3>
          <div className="totals-grid">
            <div className="total-card">
              <div className="total-label">GOT Attempts</div>
              <div className="total-value">{lobby.results.totals.gotSent}</div>
            </div>
            <div className="total-card">
              <div className="total-label">Approved GOT</div>
              <div className="total-value">{lobby.results.totals.gotApproved}</div>
            </div>
            <div className="total-card">
              <div className="total-label">Denied GOT</div>
              <div className="total-value">{lobby.results.totals.gotDenied}</div>
            </div>
            <div className="total-card">
              <div className="total-label">SUS Attempts</div>
              <div className="total-value">{lobby.results.totals.susSent}</div>
            </div>
            <div className="total-card">
              <div className="total-label">Correct SUS</div>
              <div className="total-value">{lobby.results.totals.susCorrect}</div>
            </div>
            <div className="total-card">
              <div className="total-label">Wrong SUS</div>
              <div className="total-value">{lobby.results.totals.susWrong}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderHome() {
    return (
      <div className="mobile-shell auth-shell">
        <div className="hero-card">
          <div className="hero-badge">Mobile Party Game</div>
          <h1>You Got Got</h1>
          <p className="hero-text">
            Get a secret target, complete your quest, call sus, and race to the
            win.
          </p>
          <div className="server-pill">Server: {SERVER_URL}</div>
        </div>

        <div className="panel">
          <label className="field-label">Name</label>
          <input
            placeholder="Enter your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
          />

          <button className="primary-btn" onClick={createLobby}>
            Create Lobby
          </button>

          <div className="divider">or</div>

          <label className="field-label">Lobby Code</label>
          <input
            placeholder="ABCDE"
            value={lobbyCodeInput}
            onChange={(e) => setLobbyCodeInput(e.target.value.toUpperCase())}
            maxLength={5}
          />

          <button className="secondary-btn" onClick={joinLobby}>
            Join Lobby
          </button>

          {message ? <div className="info-banner">{message}</div> : null}
        </div>
      </div>
    );
  }

  function renderGameTab() {
    if (!lobby.started) {
      return (
        <div className="tab-screen">
          <div className="panel">
            <h2>Waiting for game start</h2>
            <p>Join the lobby and wait for the host to start.</p>
            {isHost ? (
              <button className="primary-btn" onClick={startGame}>
                Start Game
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    if (lobby.gameOver && lobby.winner) {
      return renderResultsPanel();
    }

    return (
      <div className="tab-screen">
        <div className="score-strip">
          <div className="score-chip">
            <span className="chip-label">You</span>
            <span className="chip-value">{me?.points ?? 0} pts</span>
          </div>
          <div className="score-chip">
            <span className="chip-label">To Win</span>
            <span className="chip-value">{lobby.winPoints} pts</span>
          </div>
        </div>

        {lobby.settings.chaosMode ? (
          <div className="chaos-banner">
            Chaos Mode On · {Math.round(lobby.settings.chaosIntervalSeconds / 60)} min
          </div>
        ) : null}

        <div className="panel mission-panel">
          <div className="mission-panel-head">
            <div>
              <div className="mini-label">Private Mission</div>
              <div className="privacy-note">
                Keep this hidden from other players.
              </div>
            </div>

            <button
              className={`shield-btn ${missionHidden ? "shield-btn-hidden" : ""}`}
              onClick={() => {
                unlockAudio();
                setMissionHidden((prev) => !prev);
              }}
            >
              {missionHidden ? "Reveal" : "Hide"}
            </button>
          </div>

          <div className="motion-privacy-row">
            <div className="motion-privacy-text">
              <div className="mini-label">Motion Privacy</div>
              <div className="privacy-note">
                Face-down phone auto-hides your mission.
              </div>
            </div>

            {motionStatus !== MOTION_STATUS.ENABLED ? (
              <button className="motion-btn" onClick={enableMotionPrivacy}>
                Enable
              </button>
            ) : (
              <div className="motion-status-pill">On</div>
            )}
          </div>

          {motionStatus === MOTION_STATUS.DENIED ? (
            <div className="subtle-note">
              Motion permission was denied on this device.
            </div>
          ) : null}

          {motionStatus === MOTION_STATUS.UNSUPPORTED ? (
            <div className="subtle-note">
              Motion privacy is not supported here.
            </div>
          ) : null}

          {missionHidden ? (
            <div className="privacy-shield">
              <div className="privacy-icon">🔒</div>
              <div className="privacy-title">Mission Hidden</div>
              <div className="privacy-text">
                Tap Reveal when nobody is looking.
              </div>
            </div>
          ) : (
            <>
              <div className="mini-label">Target</div>
              <div className="target-name">{me?.targetName || "None"}</div>

              <div className="mini-label quest-label">Your Quest</div>
              <div className="quest-card">
                <div className="quest-text">{me?.quest || "No quest assigned"}</div>
              </div>
            </>
          )}

          <button className="got-btn" onClick={sendGot}>
            GOT
          </button>
        </div>

        <div className="panel">
          <h3>Call Sus</h3>

          <label className="field-label">Pick a player</label>
          <select
            value={susPlayer}
            onChange={(e) => setSusPlayer(e.target.value)}
          >
            <option value="">Choose player</option>
            {otherPlayers.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>

          <label className="field-label">What is their quest?</label>
          <textarea
            placeholder="Write your guess"
            value={susGuess}
            onChange={(e) => setSusGuess(e.target.value)}
            maxLength={180}
          />

          <button className="sus-btn" onClick={sendSus}>
            Submit Sus
          </button>
        </div>
      </div>
    );
  }

  function renderRequestsTab() {
    return (
      <div className="tab-screen">
        <div className="panel">
          <div className="section-head">
            <h2>Requests</h2>
            <div className="count-pill">{pendingCount}</div>
          </div>

          {lobby.gameOver ? (
            <div className="subtle-note">Game is over. Requests are locked.</div>
          ) : null}

          <div className="request-group">
            <div className="group-title">Incoming GOT</div>

            {incomingGot.length === 0 ? (
              <div className="empty-card">No GOT requests</div>
            ) : (
              incomingGot.map((req) => (
                <div key={`got-${req.fromId}`} className="request-card">
                  <div className="request-title">
                    <strong>{req.fromName}</strong> says they got you
                  </div>
                  {!lobby.gameOver ? (
                    <div className="request-actions">
                      <button
                        className="success-btn"
                        onClick={() => respondGot(req.fromId, true)}
                      >
                        Approve
                      </button>
                      <button
                        className="danger-btn"
                        onClick={() => respondGot(req.fromId, false)}
                      >
                        Deny
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="request-group">
            <div className="group-title">Incoming Sus</div>

            {incomingSus.length === 0 ? (
              <div className="empty-card">No Sus requests</div>
            ) : (
              incomingSus.map((req) => (
                <div key={`sus-${req.fromId}`} className="request-card">
                  <div className="request-title">
                    <strong>{req.fromName}</strong> says your quest is:
                  </div>

                  <div className="quest-card guess-quest">
                    <div className="mini-label">Their Guess</div>
                    <div className="quest-text">{req.guessedQuest}</div>
                  </div>

                  <div className="quest-card real-quest">
                    <div className="mini-label">Your Real Quest</div>
                    <div className="quest-text">{me?.quest || "No quest assigned"}</div>
                  </div>

                  {!lobby.gameOver ? (
                    <div className="request-actions">
                      <button
                        className="success-btn"
                        onClick={() => susGotMe(req.fromId)}
                      >
                        Got Me
                      </button>
                      <button
                        className="danger-btn"
                        onClick={() => susWrong(req.fromId)}
                      >
                        You're Wrong
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
        </div>
      </div>
    );
  }
  function renderFeedTab() {
    return (
      <div className="tab-screen">
        {lobby.lastSusReveal ? (
          <div className="panel">
            <h3>Last Sus Reveal</h3>
            <div className="reveal-line">
              <strong>{lobby.lastSusReveal.fromName}</strong> sus’d{" "}
              <strong>{lobby.lastSusReveal.toName}</strong>
            </div>

            <div className="quest-card guess-quest">
              <div className="mini-label">Guessed Quest</div>
              <div className="quest-text">{lobby.lastSusReveal.guessedQuest}</div>
            </div>

            <div className="quest-card real-quest">
              <div className="mini-label">Real Quest</div>
              <div className="quest-text">{lobby.lastSusReveal.revealedQuest}</div>
            </div>

            <div className="result-chip">
              {lobby.lastSusReveal.result === "got-me"
                ? "Got Me"
                : "You're Wrong"}
            </div>
          </div>
        ) : null}

        <div className="panel">
          <h2>Game Feed</h2>

          {lobby.feed?.length ? (
            <div className="feed-list">
              {lobby.feed.map((item) => (
                <div key={item.id} className="feed-item">
                  {item.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-card">No activity yet</div>
          )}
        </div>
      </div>
    );
  }

  function renderLobbyTab() {
    return (
      <div className="tab-screen">
        <div className="panel">
          <div className="section-head lobby-head">
            <div>
              <div className="mini-label">Lobby Code</div>
              <div className="lobby-code">{lobby.lobbyCode}</div>
            </div>

            <button className="danger-btn small-btn" onClick={leaveLobby}>
              Leave
            </button>
          </div>

          <div className="lobby-status">
            {lobby.gameOver
              ? "Game Over"
              : lobby.started
              ? "Game In Progress"
              : "Waiting To Start"}
          </div>

          {!lobby.started && isHost ? (
            <>
              <div className="settings-card">
                <div className="settings-title">Game Settings</div>

                <label className="field-label">Points To Win</label>
                <select
                  value={settingsDraft.pointsToWin}
                  onChange={(e) =>
                    updateDraftField("pointsToWin", Number(e.target.value))
                  }
                >
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                  <option value={7}>7</option>
                </select>

                <label className="toggle-row">
                  <span>Chaos Mode</span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.chaosMode}
                    onChange={(e) =>
                      updateDraftField("chaosMode", e.target.checked)
                    }
                  />
                </label>

                {settingsDraft.chaosMode ? (
                  <>
                    <label className="field-label">Chaos Interval</label>
                    <select
                      value={settingsDraft.chaosIntervalSeconds}
                      onChange={(e) =>
                        updateDraftField(
                          "chaosIntervalSeconds",
                          Number(e.target.value)
                        )
                      }
                    >
                      <option value={120}>2 minutes</option>
                      <option value={180}>3 minutes</option>
                      <option value={300}>5 minutes</option>
                    </select>
                  </>
                ) : null}

                <label className="toggle-row">
                  <span>Physical Quests</span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.allowPhysicalQuests}
                    onChange={(e) =>
                      updateDraftField("allowPhysicalQuests", e.target.checked)
                    }
                  />
                </label>
              </div>

              <button className="primary-btn" onClick={startGame}>
                Start Game
              </button>
            </>
          ) : null}

          {lobby.gameOver && isHost ? (
            <button className="success-btn" onClick={playAgain}>
              Play Again
            </button>
          ) : null}
        </div>

        <div className="panel">
          <div className="section-head">
            <h2>Players</h2>
            <div className="count-pill">{lobby.players.length}</div>
          </div>

          <div className="player-list">
            {lobby.players.map((player) => (
              <div key={player.id} className="player-card">
                <div className="player-main">
                  <div className="player-name-row">
                    <span className="player-name">{player.name}</span>
                    {player.id === lobby.hostId ? (
                      <span className="tiny-badge host-badge">Host</span>
                    ) : null}
                    {player.id === socket.id ? (
                      <span className="tiny-badge you-badge">You</span>
                    ) : null}
                  </div>
                  <div className="player-points">{player.points} pts</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {message ? <div className="info-banner">{message}</div> : null}
      </div>
    );
  }

  function renderActiveTab() {
    switch (activeTab) {
      case TABS.REQUESTS:
        return renderRequestsTab();
      case TABS.FEED:
        return renderFeedTab();
      case TABS.LOBBY:
        return renderLobbyTab();
      case TABS.GAME:
      default:
        return renderGameTab();
    }
  }

  if (!lobby) {
    return renderHome();
  }

  return (
    <div className="mobile-shell game-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">You Got Got</div>
          <div className="topbar-sub">
            {lobby.gameOver
              ? "Game Over"
              : lobby.started
              ? "Match Live"
              : "Lobby Open"}
          </div>
        </div>

        <div className="topbar-right">
          <div className="top-pill">{me?.points ?? 0} pts</div>
          {pendingCount > 0 ? (
            <button
              className="top-requests-btn"
              onClick={() => {
                unlockAudio();
                setActiveTab(TABS.REQUESTS);
              }}
            >
              {pendingCount} Req
            </button>
          ) : null}
        </div>
      </header>

      <main className="content-area">{renderActiveTab()}</main>

      <nav className="bottom-nav">
        <button
          className={`nav-btn ${activeTab === TABS.GAME ? "nav-btn-active" : ""}`}
          onClick={() => {
            unlockAudio();
            setActiveTab(TABS.GAME);
          }}
        >
          <span className="nav-icon">🎯</span>
          <span className="nav-label">Game</span>
        </button>

        <button
          className={`nav-btn ${activeTab === TABS.REQUESTS ? "nav-btn-active" : ""}`}
          onClick={() => {
            unlockAudio();
            setActiveTab(TABS.REQUESTS);
          }}
        >
          <span className="nav-icon">📥</span>
          <span className="nav-label">Requests</span>
          {pendingCount > 0 ? (
            <span className="nav-badge">{pendingCount}</span>
          ) : null}
        </button>

        <button
          className={`nav-btn ${activeTab === TABS.FEED ? "nav-btn-active" : ""}`}
          onClick={() => {
            unlockAudio();
            setActiveTab(TABS.FEED);
          }}
        >
          <span className="nav-icon">📜</span>
          <span className="nav-label">Feed</span>
        </button>

        <button
          className={`nav-btn ${activeTab === TABS.LOBBY ? "nav-btn-active" : ""}`}
          onClick={() => {
            unlockAudio();
            setActiveTab(TABS.LOBBY);
          }}
        >
          <span className="nav-icon">👥</span>
          <span className="nav-label">Lobby</span>
        </button>
      </nav>
    </div>
  );
}
