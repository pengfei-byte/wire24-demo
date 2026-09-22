import { useCallback, useEffect, useRef, useState } from "react";
import { R2Client } from "../lib/r2.js";
import { closeSession, fetchBriefing, fetchHealth, heartbeat, startBroadcast } from "../lib/api.js";

const CONNECT_TIMEOUT_MS = 20_000;
const HIDDEN_CLOSE_MS = 25_000;
const REJOIN_MS = 250;
const NEWS_POLL_MS = 45_000;
const TURN_STALL_MS = 22_000;
const PIPELINE_MS = 2600;

function viewerMessage(text) {
  const clean = String(text || "")
    .replace(/pop\s*vid/gi, "Reverie")
    .replace(/\s+/g, " ")
    .trim();
  return clean || "The live line didn't connect. Try again.";
}

function cueKey(cue) {
  return cue?.title || cue?.id || "";
}

function storyCaption(item) {
  const summary = String(item?.summary || "").trim();
  if (!item?.title) return "";
  return summary ? `${item.title}. ${summary}` : item.title;
}

function handoffAfterVisibleMs(text) {
  const chars = String(text || "").trim().length;
  const playback = Math.max(4500, Math.round((chars / 12) * 1000));
  return Math.max(1800, playback - PIPELINE_MS);
}

function speakingQueue(briefing) {
  if (!briefing) return [];
  if (Array.isArray(briefing.cues) && briefing.cues.length) return [...briefing.cues];
  return (briefing.items || []).filter((item) => item.kind !== "close" && item.cue);
}

function cloneCue(item, prefix) {
  if (!item) return null;
  return { ...item, id: `${prefix}_${crypto.randomUUID()}` };
}

function activeStoryIds(current, currentId) {
  if (current?.story_ids?.length) return new Set(current.story_ids);
  if (currentId) return new Set([currentId]);
  return new Set();
}

function formatClock(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    date: `${get("month")}/${get("day")} ${get("weekday")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

function storiesOnly(items = []) {
  return items.filter((item) => item.kind !== "close");
}

export default function Studio() {
  const videoRef = useRef(null);
  const clientRef = useRef(null);
  const sessionRef = useRef(null);
  const cuesRef = useRef([]);
  const indexRef = useRef(0);
  const mediaReadyRef = useRef(false);
  const startedRef = useRef(false);
  const aheadRef = useRef(false);
  const continueRef = useRef(false);
  const joiningRef = useRef(false);
  const reconnectsRef = useRef(0);
  const turnTimerRef = useRef(null);
  const prefetchTimerRef = useRef(null);
  const onAirRef = useRef(null);
  const turnItemsRef = useRef(new Map());
  const repliesRef = useRef(new Map());
  const hiddenTimerRef = useRef(null);
  const textTimerRef = useRef(null);
  const liveRef = useRef(false);
  const fillerRef = useRef(null);
  const refillingRef = useRef(false);
  const briefingRef = useRef(null);
  const archiveRef = useRef([]);
  const connectTimerRef = useRef(null);
  const showFailRef = useRef(() => {});

  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [health, setHealth] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [phase, setPhase] = useState("lobby");
  const [status, setStatus] = useState("Standby");
  const [onAir, setOnAir] = useState(null);
  const [fail, setFail] = useState(null);
  const [budget, setBudget] = useState(null);
  const [live, setLive] = useState(false);

  const items = briefing?.items || [];
  const stories = storiesOnly(items);
  const activeIds = activeStoryIds(onAir, onAir?.id);

  useEffect(() => {
    const tick = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ realtime: false }));
  }, []);

  const clearTimers = () => {
    clearTimeout(turnTimerRef.current);
    clearTimeout(prefetchTimerRef.current);
    clearTimeout(textTimerRef.current);
    clearTimeout(connectTimerRef.current);
  };

  const shutdown = useCallback((reason = "client_closed") => {
    clearTimers();
    const id = sessionRef.current;
    clientRef.current?.close(reason);
    clientRef.current = null;
    if (id) closeSession(id);
    sessionRef.current = null;
    mediaReadyRef.current = false;
    aheadRef.current = false;
    liveRef.current = false;
    setLive(false);
  }, []);

  const loadQueue = useCallback((data) => {
    briefingRef.current = data;
    fillerRef.current = data?.filler || null;
    const queue = speakingQueue(data);
    cuesRef.current = queue;
    archiveRef.current = queue.slice();
    indexRef.current = 0;
    aheadRef.current = false;
    turnItemsRef.current = new Map();
    repliesRef.current = new Map();
  }, []);

  const absorbNews = useCallback((data) => {
    if (!data) return;
    briefingRef.current = data;
    setBriefing(data);
    if (data.filler) fillerRef.current = data.filler;
    const incoming = speakingQueue(data);
    if (incoming.length) {
      const seen = new Set(incoming.map(cueKey));
      const older = archiveRef.current.filter((cue) => cue?.cue && !seen.has(cueKey(cue)));
      archiveRef.current = [...incoming, ...older].slice(0, 8);
    }
    if (!startedRef.current || !incoming.length) return;
    const recent = new Set(
      cuesRef.current.slice(Math.max(0, indexRef.current - 1), indexRef.current + 4).map(cueKey)
    );
    const fresh = incoming.filter((cue) => cue.cue && !recent.has(cueKey(cue)));
    if (!fresh.length) return;
    const freshKeys = new Set(fresh.map(cueKey));
    const head = cuesRef.current.slice(0, indexRef.current);
    const tail = cuesRef.current.slice(indexRef.current).filter((cue) => !freshKeys.has(cueKey(cue)));
    cuesRef.current = [...head, ...fresh.map((cue) => cloneCue(cue, "new")), ...tail];
  }, []);

  const refillQueue = useCallback(async () => {
    if (refillingRef.current) return;
    refillingRef.current = true;
    try {
      absorbNews(await fetchBriefing(true));
    } catch {
      /* keep the copy already on air */
    } finally {
      refillingRef.current = false;
    }
  }, [absorbNews]);

  useEffect(() => {
    let stop = false;
    const pull = (force = false) => {
      fetchBriefing(force)
        .then((data) => {
          if (!stop) absorbNews(data);
        })
        .catch(() => {});
    };
    pull(true);
    const timer = setInterval(() => pull(false), NEWS_POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [absorbNews]);

  const submitNextRef = useRef(() => {});

  const parkOnAir = useCallback((item) => {
    onAirRef.current = item;
    setOnAir(item);
  }, []);

  const submitNext = useCallback(() => {
    const client = clientRef.current;
    if (!client || aheadRef.current) return;
    clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
    if (cuesRef.current.length - indexRef.current <= 1) refillQueue();
    if (indexRef.current >= cuesRef.current.length) {
      const source = archiveRef.current.length ? archiveRef.current : cuesRef.current;
      const replay = source
        .filter((item) => item && item.kind !== "close" && item.cue)
        .map((item) => cloneCue(item, "again"));
      if (replay.length) {
        cuesRef.current = replay;
        indexRef.current = 0;
      } else {
        const filler = cloneCue(fillerRef.current, "fill");
        if (!filler) return;
        cuesRef.current.push(filler);
      }
    }
    let item = cuesRef.current[indexRef.current];
    while (item && item.kind === "close") {
      indexRef.current += 1;
      item = cuesRef.current[indexRef.current];
    }
    if (!item?.cue) return;
    indexRef.current += 1;
    aheadRef.current = true;
    const turnId = client.say(item.cue);
    turnItemsRef.current.set(turnId, item);
    setStatus(`On air · ${item.category_label}`);
    clearTimeout(turnTimerRef.current);
    turnTimerRef.current = setTimeout(() => {
      aheadRef.current = false;
      submitNextRef.current();
    }, TURN_STALL_MS);
  }, [refillQueue]);

  submitNextRef.current = submitNext;

  const tryStartTalking = useCallback(() => {
    if (startedRef.current) return;
    if (!clientRef.current) return;
    if (!cuesRef.current.length) return;
    startedRef.current = true;
    submitNext();
  }, [submitNext]);

  const joinRef = useRef(null);

  const showFail = useCallback((body) => {
    continueRef.current = false;
    clearTimeout(connectTimerRef.current);
    shutdown("connect_failed");
    setPhase("lobby");
    setStatus("Standby");
    setLive(false);
    setFail({
      title: "Couldn't go live",
      body: viewerMessage(body),
    });
  }, [shutdown]);

  showFailRef.current = showFail;

  const attachClient = useCallback(
    (data) => {
      sessionRef.current = data.session.session_id;
      loadQueue(data.briefing);
      aheadRef.current = false;
      startedRef.current = false;
      mediaReadyRef.current = false;
      const client = new R2Client({
        credentials: data.credentials,
        remoteVideo: videoRef.current,
        onEvent: (msg) => {
          const d = msg.data || {};
          if (msg.type === "session.ready") {
            setStatus("Studio connected");
            tryStartTalking();
          }
          if (msg.type === "turn.text" && d.text) {
            if (d.turn_id) repliesRef.current.set(d.turn_id, d.text);
            setStatus("Anchor speaking");
          }
          if (msg.type === "turn.visible") {
            clearTimeout(turnTimerRef.current);
            aheadRef.current = false;
            const item = turnItemsRef.current.get(d.turn_id);
            if (item) parkOnAir(item);
            setStatus(item ? `On air · ${item.category_label}` : "Picture locked");
            const spoken = repliesRef.current.get(d.turn_id) || item?.cue || "";
            clearTimeout(prefetchTimerRef.current);
            prefetchTimerRef.current = setTimeout(() => {
              prefetchTimerRef.current = null;
              submitNextRef.current();
            }, handoffAfterVisibleMs(spoken));
          }
          if ((msg.type === "usage.tick" || msg.type === "session.renewed") && d.budget_remaining_ms != null) {
            setBudget(d);
          }
          if (msg.type === "media.clip" && d.kind === "idle") {
            if (!startedRef.current) {
              tryStartTalking();
              return;
            }
            if (aheadRef.current) return;
            if (prefetchTimerRef.current) {
              clearTimeout(prefetchTimerRef.current);
              prefetchTimerRef.current = null;
              submitNextRef.current();
            }
          }
        },
        onError: (err) => {
          if (!liveRef.current) showFailRef.current(err.message || err.code || "The live line dropped.");
        },
        onEnded: () => {
          if (clientRef.current !== client) return;
          liveRef.current = false;
          setLive(false);
          if (joiningRef.current) return;
          if (continueRef.current && startedRef.current) {
            setStatus("Next edition…");
            setPhase("joining");
            setTimeout(() => joinRef.current?.(true), REJOIN_MS);
            return;
          }
          if (continueRef.current) showFailRef.current("The live line dropped before the picture came up.");
          else {
            setPhase("lobby");
            setStatus("Standby");
          }
        },
      });
      clientRef.current = client;
      client.start();
      setPhase("onair");
      setStatus("Connecting picture");
    },
    [loadQueue, parkOnAir, submitNext, tryStartTalking]
  );

  const join = useCallback(
    async (isReconnect = false) => {
      if (joiningRef.current) return;
      joiningRef.current = true;
      if (!isReconnect) reconnectsRef.current = 0;
      else {
        reconnectsRef.current += 1;
        if (reconnectsRef.current > 4) {
          joiningRef.current = false;
          showFail("Too many reconnects this hour. Try again in a little while.");
          return;
        }
      }
      clearTimers();
      continueRef.current = true;
      shutdown(isReconnect ? "edition_rollover" : "restart");
      setFail(null);
      parkOnAir(null);
      setBudget(null);
      setPhase("joining");
      setStatus(isReconnect ? "Next edition…" : "Connecting");
      startedRef.current = false;
      try {
        const data = await startBroadcast();
        if (data.briefing) absorbNews(data.briefing);
        if (data.mode === "realtime" && data.credentials) {
          attachClient(data);
          clearTimeout(connectTimerRef.current);
          connectTimerRef.current = setTimeout(() => {
            if (!liveRef.current) showFailRef.current("The picture didn't come up. Try again.");
          }, CONNECT_TIMEOUT_MS);
        } else {
          showFail(data.error?.message || data.message);
        }
      } catch (err) {
        if (err.payload?.briefing) absorbNews(err.payload.briefing);
        showFail(err.message);
      } finally {
        joiningRef.current = false;
      }
    },
    [absorbNews, attachClient, parkOnAir, showFail, shutdown]
  );

  joinRef.current = join;

  useEffect(() => {
    liveRef.current = live;
    if (live) {
      clearTimeout(connectTimerRef.current);
      tryStartTalking();
    }
  }, [live, tryStartTalking]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const onPlay = () => {
      mediaReadyRef.current = true;
      liveRef.current = true;
      setLive(true);
      tryStartTalking();
    };
    video.addEventListener("playing", onPlay);
    return () => video.removeEventListener("playing", onPlay);
  }, [tryStartTalking, phase]);

  useEffect(() => {
    const beat = setInterval(() => heartbeat(sessionRef.current), 10_000);
    const onHide = () => {
      clearTimeout(hiddenTimerRef.current);
      if (document.hidden && sessionRef.current) {
        hiddenTimerRef.current = setTimeout(() => {
          continueRef.current = false;
          shutdown("viewer_hidden");
          setPhase("lobby");
          setStatus("Line released after you left");
        }, HIDDEN_CLOSE_MS);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    const onLeave = () => {
      const id = sessionRef.current;
      if (id) navigator.sendBeacon(`/api/sessions/${id}/close`);
    };
    window.addEventListener("pagehide", onLeave);
    return () => {
      continueRef.current = false;
      clearInterval(beat);
      clearTimeout(hiddenTimerRef.current);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
      shutdown("unmount");
    };
  }, [shutdown]);

  const leave = () => {
    continueRef.current = false;
    shutdown("client_closed");
    setPhase("lobby");
    setStatus("You left the studio");
    parkOnAir(null);
    setFail(null);
  };

  const tickerItems = stories.length ? [...stories, ...stories] : [];
  const remainingSec = budget ? Math.max(0, Math.round(budget.budget_remaining_ms / 1000)) : null;
  const inStudio = phase === "joining" || phase === "onair";
  const showCover = !live || phase !== "onair";
  const connecting = phase === "joining" || (phase === "onair" && !live);

  return (
    <div className="studio">
      <header className="mast">
        <div className="brand">
          <span className="brand-en">WIRE 24</span>
          <span className="brand-tag">LIVE NEWS</span>
        </div>
        <div className="mast-center">
          <span className={`live-pill ${phase === "onair" && live ? "on" : ""}`}>
            <i /> {phase === "onair" && live ? "LIVE" : connecting ? "CONNECTING" : "STANDBY"}
          </span>
          <span className="edition">{briefing?.edition || "Rolling news"}</span>
        </div>
        <div className="mast-clock">
          <span>{clock.date}</span>
          <strong>{clock.time}</strong>
        </div>
      </header>

      <main className="stage">
        <section className="camera">
          <div className="viewfinder">
            <video ref={videoRef} className="anchor-video" autoPlay playsInline />
            {showCover && (
              <div className="poster">
                <img src="/anchor.jpg" alt="Elena Voss, WIRE 24 anchor" />
                {phase === "lobby" && (
                  <button type="button" className="cover-go" onClick={() => join(false)}>
                    Watch live
                  </button>
                )}
                {connecting && (
                  <div className="cover-connect" role="status" aria-live="polite">
                    <div className="pulse" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <strong>Connecting</strong>
                  </div>
                )}
              </div>
            )}
            <div className="finders">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="tally">{phase === "onair" && live ? "ON AIR" : "CAM 1"}</div>
            {onAir && (
              <div className={`lower ${onAir.category || ""}`}>
                <em>{onAir.category_label}</em>
                <div>
                  <strong>{onAir.kind === "close" ? "WIRE 24" : onAir.title}</strong>
                  <p>{onAir.kind === "close" ? "Rolling news" : `${onAir.source} · ${onAir.ago}`}</p>
                </div>
              </div>
            )}
          </div>
          <div className="caption-rail">
            <span className="rail-kicker">
              {onAir && onAir.kind !== "close"
                ? `${onAir.category_label} · ${onAir.source}`
                : status}
            </span>
            <p>{onAir ? storyCaption(onAir) : "The anchor starts talking as soon as the picture is up. No typing required."}</p>
          </div>
        </section>

        <aside className="rundown">
          <div className="rundown-head">
            <p>This hour</p>
            <span>{health?.realtime ? "Desk ready" : "Desk updating"}</span>
          </div>
          <ol>
            {stories.map((item, idx) => (
              <li key={item.id} className={`${item.category} ${activeIds.has(item.id) ? "now" : ""}`}>
                <b>{String(idx + 1).padStart(2, "0")}</b>
                <div>
                  <small>
                    {item.category_label} · {item.source}
                  </small>
                  <strong>{item.title}</strong>
                </div>
              </li>
            ))}
            {!stories.length && <li className="empty">Gathering wires…</li>}
          </ol>
          <div className="controls">
            {inStudio && (
              <button type="button" className="leave" onClick={leave}>
                Leave
              </button>
            )}
            {remainingSec != null && phase === "onair" && <p className="budget">{remainingSec}s left this hour</p>}
            <p className="fine">
              Headlines from BBC, NPR, The Guardian, and MarketWatch. Each item is expanded from the source, then given a short comment.
            </p>
          </div>
        </aside>
      </main>

      <footer className="ticker" aria-label="Headlines">
        <span className="ticker-tag">HEADLINES</span>
        <div className="ticker-mask">
          <div className="ticker-track">
            {tickerItems.map((item, idx) => (
              <span key={`${item.id}-${idx}`}>
                <em className={item.category}>{item.category_label}</em>
                {item.title}
              </span>
            ))}
            {!tickerItems.length && <span>Connecting to the wires…</span>}
          </div>
        </div>
      </footer>
      <p className="powered">Powered by Reverie R2 API</p>
      {fail && (
        <div className="fail-scrim" role="dialog" aria-modal="true" aria-labelledby="fail-title">
          <div className="fail-card">
            <h2 id="fail-title">{fail.title}</h2>
            <p>{fail.body}</p>
            <div className="fail-actions">
              <button type="button" className="primary" onClick={() => join(false)}>
                Try again
              </button>
              <button type="button" className="ghost" onClick={() => setFail(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
