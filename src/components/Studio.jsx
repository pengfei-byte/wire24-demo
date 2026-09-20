import { useCallback, useEffect, useRef, useState } from "react";
import { PopvidClient } from "../lib/popvid.js";
import { closeSession, fetchBriefing, fetchHealth, heartbeat, startBroadcast } from "../lib/api.js";

const TEXT_DWELL_MS = 7_000;
const HIDDEN_CLOSE_MS = 25_000;
const LOW_BUDGET_MS = 12_000;
const REJOIN_MS = 250;
const PIPELINE_MS = 2800;
const MIN_LEAD_MS = 1600;
const TURN_SAFETY_PAD_MS = 12_000;
const TURN_FALLBACK_MS = 90_000;

function prefetchDelayMs(estMs) {
  const est = Number(estMs) > 0 ? Number(estMs) : 22_000;
  return Math.max(MIN_LEAD_MS, est - PIPELINE_MS);
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
  const hiddenTimerRef = useRef(null);
  const textTimerRef = useRef(null);
  const liveRef = useRef(false);
  const fillerRef = useRef(null);
  const closingRef = useRef(null);
  const refillingRef = useRef(false);
  const briefingRef = useRef(null);
  const closeSentRef = useRef(false);

  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [health, setHealth] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [phase, setPhase] = useState("lobby");
  const [status, setStatus] = useState("Standby");
  const [caption, setCaption] = useState("");
  const [currentId, setCurrentId] = useState(null);
  const [error, setError] = useState("");
  const [budget, setBudget] = useState(null);
  const [live, setLive] = useState(false);

  const items = briefing?.items || [];
  const stories = storiesOnly(items);
  const current =
    (briefing?.cues || []).find((item) => item.id === currentId) ||
    items.find((item) => item.id === currentId) ||
    null;
  const activeIds = activeStoryIds(current, currentId);

  useEffect(() => {
    const tick = setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ realtime: false }));
    fetchBriefing()
      .then((data) => {
        briefingRef.current = data;
        setBriefing(data);
      })
      .catch((err) => setError(err.message));
  }, []);

  const clearTimers = () => {
    clearTimeout(turnTimerRef.current);
    clearTimeout(prefetchTimerRef.current);
    clearTimeout(textTimerRef.current);
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
    cuesRef.current = speakingQueue(data);
    indexRef.current = 0;
    wrappingRef.current = false;
    closeSentRef.current = false;
  }, []);

  const refillQueue = useCallback(async () => {
    if (refillingRef.current) return;
    refillingRef.current = true;
    try {
      const next = await fetchBriefing(true);
      briefingRef.current = { ...briefingRef.current, ...next, items: next.items };
      setBriefing((prev) => ({
        ...(prev || {}),
        ...next,
        items: next.items?.length ? next.items : prev?.items,
      }));
      const seen = new Set(cuesRef.current.map((item) => item.title));
      const extra = speakingQueue(next).filter((item) => !seen.has(item.title));
      if (extra.length) cuesRef.current = [...cuesRef.current, ...extra];
      if (next.filler) fillerRef.current = next.filler;
      if (next.closing) closingRef.current = next.closing;
    } catch {
      /* keep current queue */
    } finally {
      refillingRef.current = false;
    }
  }, []);

  const submitNextRef = useRef(() => {});
  const advanceQueueRef = useRef(() => {});

  const armSpeechTimers = useCallback((estMs) => {
    clearTimeout(prefetchTimerRef.current);
    clearTimeout(turnTimerRef.current);
    const est = Math.max(4000, Number(estMs) || 22_000);
    prefetchTimerRef.current = setTimeout(() => {
      advanceQueueRef.current();
    }, prefetchDelayMs(est));
    turnTimerRef.current = setTimeout(() => {
      advanceQueueRef.current(true);
    }, est + TURN_SAFETY_PAD_MS);
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
        setCurrentId(close.id);
        setStatus("Closing");
        clientRef.current.say(close.cue);
      }
      return;
    }
    submitNextRef.current();
  }, []);

  advanceQueueRef.current = advanceQueue;

  const submitNext = useCallback(() => {
    const client = clientRef.current;
    if (!client || wrappingRef.current || inFlightRef.current) return;
    if (cuesRef.current.length - indexRef.current <= 1) refillQueue();
    if (indexRef.current >= cuesRef.current.length) {
      const filler = cloneCue(fillerRef.current, "fill");
      if (filler) cuesRef.current.push(filler);
      else {
        wrappingRef.current = true;
        const close = cloneCue(closingRef.current, "close");
        if (close) {
          closeSentRef.current = true;
          inFlightRef.current = true;
          spokenRef.current = false;
          setCurrentId(close.id);
          client.say(close.cue);
        }
        return;
      }
    }
    const item = cuesRef.current[indexRef.current];
    indexRef.current += 1;
    inFlightRef.current = true;
    spokenRef.current = false;
    setCurrentId(item.id);
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
    }, TURN_FALLBACK_MS);
  }, [advanceQueue, refillQueue]);

  submitNextRef.current = submitNext;

  const tryStartTalking = useCallback(() => {
    if (startedRef.current) return;
    if (!clientRef.current) return;
    if (!cuesRef.current.length) return;
    startedRef.current = true;
    submitNext();
  }, [submitNext]);

  const joinRef = useRef(null);

  const runTextEdition = useCallback((nextBriefing) => {
    shutdown("text_mode");
    continueRef.current = true;
    setPhase("text");
    setStatus("Teleprompter");
    loadQueue(nextBriefing);
    const step = () => {
      if (!continueRef.current) return;
      if (indexRef.current >= cuesRef.current.length) {
        const filler = cloneCue(fillerRef.current, "fill");
        if (filler) cuesRef.current.push(filler);
        else {
          setStatus("Hour complete. Next edition…");
          textTimerRef.current = setTimeout(() => joinRef.current?.(true), REJOIN_MS);
          return;
        }
      }
      const item = cuesRef.current[indexRef.current];
      indexRef.current += 1;
      setCurrentId(item.id);
      setCaption(item.cue ? `${item.category_label} | ${item.title}. ${item.summary}` : item.title);
      setStatus(item.kind === "close" ? "Closing" : `Reading · ${item.category_label}`);
      if (cuesRef.current.length - indexRef.current <= 1) refillQueue();
      textTimerRef.current = setTimeout(step, item.kind === "close" ? 5000 : TEXT_DWELL_MS);
    };
    step();
  }, [loadQueue, refillQueue, shutdown]);

  const attachClient = useCallback(
    (data) => {
      sessionRef.current = data.session.session_id;
      loadQueue(data.briefing);
      inFlightRef.current = false;
      spokenRef.current = false;
      startedRef.current = false;
      mediaReadyRef.current = false;
      const client = new PopvidClient({
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
            setCaption(d.text);
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
            advanceQueue();
          }
        },
        onError: (err) => {
          setError(err.message || err.code || "Studio signal dropped");
        },
        onEnded: () => {
          liveRef.current = false;
          setLive(false);
          if (joiningRef.current) return;
          if (!startedRef.current && continueRef.current && cuesRef.current.length) {
            runTextEdition(briefingRef.current || { cues: cuesRef.current });
            return;
          }
          if (continueRef.current) {
            setStatus("Next edition…");
            setTimeout(() => joinRef.current?.(true), REJOIN_MS);
          } else {
            setPhase("lobby");
            setStatus("Signal lost");
          }
        },
      });
      clientRef.current = client;
      client.start();
      setPhase("onair");
      setStatus("Connecting picture");
    },
    [advanceQueue, armSpeechTimers, loadQueue, runTextEdition, submitNext, tryStartTalking]
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
          continueRef.current = false;
          setPhase("lobby");
          setStatus("Hourly cap reached");
          setError("Too many joins this hour. Click Watch live to try again.");
          return;
        }
      }
      clearTimers();
      continueRef.current = true;
      shutdown(isReconnect ? "edition_rollover" : "restart");
      setError("");
      setCaption("");
      setCurrentId(null);
      setBudget(null);
      setPhase("joining");
      setStatus(isReconnect ? "Next edition…" : "Entering the studio");
      try {
        const data = await startBroadcast();
        if (data.briefing) {
          briefingRef.current = data.briefing;
          setBriefing(data.briefing);
        }
        if (data.mode === "realtime" && data.credentials) {
          attachClient(data);
        } else {
          runTextEdition(data.briefing);
          if (data.error?.message) setError(data.error.message);
          else if (data.message) setError(data.message);
        }
      } catch (err) {
        setError(err.message);
        if (err.payload?.briefing) {
          setBriefing(err.payload.briefing);
          runTextEdition(err.payload.briefing);
        } else {
          continueRef.current = false;
          setPhase("lobby");
          setStatus("Join failed");
        }
      } finally {
        joiningRef.current = false;
      }
    },
    [attachClient, runTextEdition, shutdown]
  );

  joinRef.current = join;

  useEffect(() => {
    liveRef.current = live;
    if (live) tryStartTalking();
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
    setCaption("");
    setCurrentId(null);
    setError("");
  };

  const tickerItems = stories.length ? [...stories, ...stories] : [];
  const remainingSec = budget ? Math.max(0, Math.round(budget.budget_remaining_ms / 1000)) : null;
  const inStudio = phase === "joining" || phase === "onair" || phase === "text";

  return (
    <div className="studio">
      <header className="mast">
        <div className="brand">
          <span className="brand-en">WIRE 24</span>
          <span className="brand-tag">LIVE NEWS</span>
        </div>
        <div className="mast-center">
          <span className={`live-pill ${phase === "onair" && live ? "on" : ""}`}>
            <i /> {phase === "onair" && live ? "LIVE" : phase === "text" ? "TEXT" : "STANDBY"}
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
            {(!live || phase !== "onair") && (
              <div className="poster" aria-hidden>
                <img src="/anchor.jpg" alt="Elena Voss, WIRE 24 anchor" />
                {phase === "text" && <span className="poster-mode">TELEPROMPTER</span>}
                {phase === "joining" && <span className="poster-mode">HOLDING FOR LINE</span>}
              </div>
            )}
            <div className="finders">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="tally">{phase === "onair" && live ? "ON AIR" : "CAM 1"}</div>
            {current && (
              <div className={`lower ${current.category || ""}`}>
                <em>{current.category_label}</em>
                <div>
                  <strong>{current.kind === "close" ? "WIRE 24" : current.title}</strong>
                  <p>{current.kind === "close" ? "Rolling news" : `${current.source} · ${current.ago}`}</p>
                </div>
              </div>
            )}
          </div>
          <div className="caption-rail">
            <span className="rail-kicker">{status}</span>
            <p>{caption || "The anchor starts talking as soon as the picture is up. No typing required."}</p>
          </div>
        </section>

        <aside className="rundown">
          <div className="rundown-head">
            <p>This hour</p>
            <span>{health?.realtime ? "PopVid line ready" : "Teleprompter backup"}</span>
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
            {!inStudio ? (
              <button type="button" className="go-live" onClick={() => join(false)}>
                Watch live
              </button>
            ) : (
              <button type="button" className="leave" onClick={leave}>
                Leave
              </button>
            )}
            {remainingSec != null && phase === "onair" && <p className="budget">{remainingSec}s left this hour</p>}
            {error && <p className="err">{error}</p>}
            <p className="fine">
              Headlines from BBC, NPR, The Guardian, and MarketWatch. The anchor reads title and summary only.
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
    </div>
  );
}
