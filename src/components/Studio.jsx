import { useCallback, useEffect, useRef, useState } from "react";
import { R2Client } from "../lib/r2.js";
import { closeSession, fetchBriefing, fetchHealth, heartbeat, startBroadcast } from "../lib/api.js";

const CONNECT_TIMEOUT_MS = 20_000;
const HIDDEN_CLOSE_MS = 25_000;
const LOW_BUDGET_MS = 12_000;
const REJOIN_MS = 250;
const PIPELINE_MS = 2800;
const TURN_SAFETY_FLOOR_MS = 70_000;
const NEWS_POLL_MS = 45_000;

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

function handoffDelayMs(estMs) {
  const est = Number(estMs);
  if (!Number.isFinite(est) || est < 18_000) return null;
  return Math.max(10_000, est - PIPELINE_MS);
}

function storyCaption(item) {
  if (!item || item.kind === "close") return "That's the hour on WIRE 24. The wires are still moving.";
  const summary = String(item.summary || "").trim();
  return summary ? `${item.title}. ${summary}` : item.title;
}

function continuationCue(item) {
  return `[DIRECTOR — silent]
Live. Dead air forbidden. First word now. No questions. No greeting.
You stopped too early on this same story. Do not read the headline again.
Finish it now in four or five sentences: the reported detail, then two sentences of commentary on why it matters. Use only the facts below. Do not invent numbers, quotes, or events.

${item.title}
${item.summary}
(${item.source})`.slice(0, 2000);
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
  const inFlightRef = useRef(false);
  const spokenRef = useRef(false);
  const mediaReadyRef = useRef(false);
  const startedRef = useRef(false);
  const wrappingRef = useRef(false);
  const continueRef = useRef(false);
  const joiningRef = useRef(false);
  const reconnectsRef = useRef(0);
  const turnTimerRef = useRef(null);
  const prefetchTimerRef = useRef(null);
  const onAirRef = useRef(null);
  const continuesRef = useRef(0);
  const lastTextLenRef = useRef(0);
  const hiddenTimerRef = useRef(null);
  const textTimerRef = useRef(null);
  const liveRef = useRef(false);
  const fillerRef = useRef(null);
  const closingRef = useRef(null);
  const refillingRef = useRef(false);
  const briefingRef = useRef(null);
  const closeSentRef = useRef(false);
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
    inFlightRef.current = false;
    spokenRef.current = false;
    liveRef.current = false;
    setLive(false);
  }, []);

  const loadQueue = useCallback((data) => {
    briefingRef.current = data;
    fillerRef.current = data?.filler || null;
    closingRef.current = data?.closing || null;
    const queue = speakingQueue(data);
    cuesRef.current = queue;
    archiveRef.current = queue.slice();
    indexRef.current = 0;
    wrappingRef.current = false;
    closeSentRef.current = false;
  }, []);

  const absorbNews = useCallback((data) => {
    if (!data) return;
    briefingRef.current = data;
    setBriefing(data);
    if (data.filler) fillerRef.current = data.filler;
    if (data.closing) closingRef.current = data.closing;
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
  const advanceQueueRef = useRef(() => {});

  const parkOnAir = useCallback((item) => {
    onAirRef.current = item;
    setOnAir(item);
  }, []);

  const armSpeechTimers = useCallback((estMs) => {
    clearTimeout(prefetchTimerRef.current);
    clearTimeout(turnTimerRef.current);
    const handoff = handoffDelayMs(estMs);
    if (handoff != null) {
      prefetchTimerRef.current = setTimeout(() => {
        advanceQueueRef.current();
      }, handoff);
    }
    const est = Number(estMs);
    const safety = Math.max(TURN_SAFETY_FLOOR_MS, (Number.isFinite(est) ? est : 0) + 8000);
    turnTimerRef.current = setTimeout(() => {
      advanceQueueRef.current(true);
    }, safety);
  }, []);

  const advanceQueue = useCallback((force = false) => {
    if (!clientRef.current) return;
    if (!force && inFlightRef.current && !spokenRef.current) return;
    inFlightRef.current = false;
    spokenRef.current = false;
    clearTimeout(turnTimerRef.current);
    clearTimeout(prefetchTimerRef.current);
    if (wrappingRef.current) {
      if (!closeSentRef.current && closingRef.current && clientRef.current) {
        closeSentRef.current = true;
        const close = cloneCue(closingRef.current, "close");
        inFlightRef.current = true;
        parkOnAir(close);
        setStatus("Closing");
        clientRef.current.say(close.cue);
      }
      return;
    }
    submitNextRef.current();
  }, [parkOnAir]);

  advanceQueueRef.current = advanceQueue;

  const submitNext = useCallback(() => {
    const client = clientRef.current;
    if (!client || wrappingRef.current || inFlightRef.current) return;
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
    const item = cuesRef.current[indexRef.current];
    indexRef.current += 1;
    inFlightRef.current = true;
    spokenRef.current = false;
    continuesRef.current = 0;
    lastTextLenRef.current = 0;
    parkOnAir(item);
    setStatus(item.kind === "close" ? "Closing" : `On air · ${item.category_label}`);
    if (item.kind === "close") {
      wrappingRef.current = true;
      closeSentRef.current = true;
    }
    client.say(item.cue);
    clearTimeout(turnTimerRef.current);
    clearTimeout(prefetchTimerRef.current);
    turnTimerRef.current = setTimeout(() => {
      advanceQueue(true);
    }, 45_000);
  }, [advanceQueue, parkOnAir, refillQueue]);

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
      inFlightRef.current = false;
      spokenRef.current = false;
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
            spokenRef.current = true;
            lastTextLenRef.current = String(d.text).length;
            setStatus("Anchor speaking");
          }
          if (msg.type === "turn.started" || msg.type === "turn.visible") {
            spokenRef.current = true;
            if (msg.type === "turn.started" && !wrappingRef.current) armSpeechTimers(d.est_ms);
            if (msg.type === "turn.visible") setStatus("Picture locked");
          }
          if (msg.type === "usage.tick") {
            setBudget(d);
            if (d.budget_remaining_ms < LOW_BUDGET_MS && !wrappingRef.current) {
              wrappingRef.current = true;
            }
          }
          if (msg.type === "media.clip" && d.kind === "idle") {
            if (!startedRef.current) {
              tryStartTalking();
              return;
            }
            const item = onAirRef.current;
            const short = lastTextLenRef.current > 0 && lastTextLenRef.current < 320;
            if (
              short &&
              continuesRef.current < 1 &&
              item?.title &&
              item.kind !== "close" &&
              clientRef.current &&
              !wrappingRef.current
            ) {
              continuesRef.current += 1;
              inFlightRef.current = true;
              spokenRef.current = false;
              lastTextLenRef.current = 0;
              clientRef.current.say(continuationCue(item));
              armSpeechTimers(0);
              return;
            }
            advanceQueue();
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
    [advanceQueue, armSpeechTimers, loadQueue, submitNext, tryStartTalking]
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
