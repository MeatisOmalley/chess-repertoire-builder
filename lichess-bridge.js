"use strict";
(() => {
  if (!/(^|\.)lichess\.org$/i.test(location.hostname)) return;

  const root = document.documentElement;
  let subscribed = false;
  let lastFen = "";
  let lastCapability = "";

  function analysisApi() {
    return window.lichess?.analysis;
  }

  function chessgroundApi() {
    try {
      return window.lichess?.chessground?.() || null;
    } catch {
      return null;
    }
  }

  function publishState(fen) {
    const api = analysisApi();
    const capability = api && typeof api.playUci === "function" ? "1" : "0";
    let changed = capability !== lastCapability;
    if (changed) {
      lastCapability = capability;
      root.dataset.crbLichessAnalysis = capability;
    }
    const nextFen = fen || chessgroundApi()?.getFen?.() || "";
    if (nextFen && nextFen !== lastFen) {
      lastFen = nextFen;
      root.dataset.crbLichessFen = nextFen;
      changed = true;
    }
    if (changed) root.dispatchEvent(new Event("crb-lichess-state"));
  }

  function subscribe() {
    const lichess = window.lichess;
    if (!lichess) return;
    if (!subscribed && lichess.events?.on) {
      try {
        lichess.events.on("analysis.change", fen => publishState(fen));
        subscribed = true;
      } catch {
        // The public API may not be ready on the first poll.
      }
    }
    publishState();
  }

  root.addEventListener("crb-lichess-play", () => {
    const uci = root.dataset.crbLichessPlay || "";
    try {
      const api = analysisApi();
      if (!uci || typeof api?.playUci !== "function") throw new Error("analysis API unavailable");
      api.playUci(uci);
      root.dataset.crbLichessPlayResult = "ok";
    } catch {
      root.dataset.crbLichessPlayResult = "error";
    }
    publishState();
  });

  root.addEventListener("crb-lichess-navigate", () => {
    const action = root.dataset.crbLichessNav || "";
    try {
      const navigate = analysisApi()?.navigate;
      const method = action === "first" ? navigate?.first
        : action === "last" ? navigate?.last
          : action === "prev" ? navigate?.prev
            : action === "next" ? navigate?.next
              : null;
      if (typeof method !== "function") throw new Error("navigation API unavailable");
      method.call(navigate);
      root.dataset.crbLichessNavResult = "ok";
    } catch {
      root.dataset.crbLichessNavResult = "error";
    }
    publishState();
  });

  root.addEventListener("crb-lichess-flip", () => {
    try { chessgroundApi()?.toggleOrientation?.(); } catch {}
  });

  subscribe();
  const timer = setInterval(subscribe, 250);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
})();
