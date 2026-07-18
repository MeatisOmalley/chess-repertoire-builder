"use strict";
(() => {
  const WORKER_URL = chrome.runtime.getURL("maia-worker.js");
  const MODEL_URL = chrome.runtime.getURL("maia3/maia3_simplified.onnx");
  const PIECES = "PNBRQKpnbrqk";
  const PROMOTIONS = "qrbn";
  let worker = null;
  let readyPromise = null;
  let nextId = 1;
  let status = "idle";
  let lastError = "";
  const pending = new Map();

  function setStatus(next) {
    status = next;
    document.dispatchEvent(new CustomEvent("crb-maia-status", { detail: next }));
  }

  function describeError(error) {
    return error?.message || String(error || "Unknown Maia error");
  }

  function rejectPending(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (readyPromise) return readyPromise;
    lastError = "";
    setStatus("loading");
    readyPromise = (async () => {
      let blobUrl = "";
      try {
        // A content script has the page's origin for Worker construction.
        // Chrome rejects a direct chrome-extension:// worker on Chess.com, so
        // fetch the declared web-accessible worker and bootstrap it from Blob.
        const response = await fetch(WORKER_URL);
        if (!response.ok) throw new Error(`Could not load Maia worker (${response.status})`);
        blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
        worker = new Worker(blobUrl);
      } catch (error) {
        readyPromise = null;
        setStatus("error");
        lastError = describeError(error);
        console.error("[Chess Repertoire Builder] Maia worker could not start:", error);
        throw error;
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
      await new Promise((resolve, reject) => {
        const fail = message => {
          const error = message instanceof Error ? message : new Error(String(message || "Maia worker failed"));
          lastError = describeError(error);
          console.error("[Chess Repertoire Builder] Maia failed:", error);
          rejectPending(error);
          readyPromise = null;
          worker?.terminate();
          worker = null;
          setStatus("error");
          reject(error);
        };
        worker.onerror = event => fail(event.error || event.message || "Maia worker crashed");
        worker.onmessage = event => {
          const message = event.data || {};
          if (message.type === "ready") { setStatus("ready"); resolve(); return; }
          if (message.type === "error" && message.id == null) { fail(message.message); return; }
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.type === "error") {
            const error = new Error(message.message || "Maia inference failed");
            lastError = describeError(error);
            console.error("[Chess Repertoire Builder] Maia inference failed:", error);
            request.reject(error);
          } else request.resolve(new Float32Array(message.logits));
        };
        worker.postMessage({ type: "init", modelUrl: MODEL_URL, runtimeBase: chrome.runtime.getURL("") });
      });
    })();
    return readyPromise;
  }

  function mirrorSquare(square) {
    return square[0] + String(9 - Number(square[1]));
  }

  function mirrorMove(uci) {
    return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
  }

  function mirrorFen(fen) {
    const [placement, turn, castling = "-", ep = "-", half = "0", full = "1"] = fen.split(/\s+/);
    const swap = rank => [...rank].map(char => /[a-z]/.test(char) ? char.toUpperCase() : /[A-Z]/.test(char) ? char.toLowerCase() : char).join("");
    const mirroredPlacement = placement.split("/").reverse().map(swap).join("/");
    let mirroredCastling = "";
    if (castling.includes("k")) mirroredCastling += "K";
    if (castling.includes("q")) mirroredCastling += "Q";
    if (castling.includes("K")) mirroredCastling += "k";
    if (castling.includes("Q")) mirroredCastling += "q";
    return `${mirroredPlacement} ${turn === "w" ? "b" : "w"} ${mirroredCastling || "-"} ${ep === "-" ? "-" : mirrorSquare(ep)} ${half} ${full}`;
  }

  function tokenize(fen) {
    const tensor = new Float32Array(64 * 12);
    const rows = fen.split(/\s+/)[0].split("/");
    for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
      let file = 0;
      const rank = 7 - rowIndex;
      for (const char of rows[rowIndex]) {
        if (/\d/.test(char)) {
          file += Number(char);
          continue;
        }
        const piece = PIECES.indexOf(char);
        if (piece >= 0) tensor[(rank * 8 + file) * 12 + piece] = 1;
        file++;
      }
    }
    return tensor;
  }

  function squareIndex(square) {
    return (Number(square[1]) - 1) * 8 + "abcdefgh".indexOf(square[0]);
  }

  function policyIndex(uci) {
    if (uci.length < 5) return squareIndex(uci.slice(0, 2)) * 64 + squareIndex(uci.slice(2, 4));
    const fromFile = "abcdefgh".indexOf(uci[0]);
    const toFile = "abcdefgh".indexOf(uci[2]);
    const piece = PROMOTIONS.indexOf(uci[4].toLowerCase());
    return piece < 0 ? -1 : 4096 + fromFile * 32 + toFile * 4 + piece;
  }

  function randomUnit() {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] / 0x100000000;
  }

  function sampleAllowed(logits, allowed, blackToMove) {
    const scored = allowed.map(uci => {
      const modelMove = blackToMove ? mirrorMove(uci) : uci;
      return { uci, logit: logits[policyIndex(modelMove)] };
    }).filter(item => Number.isFinite(item.logit));
    if (!scored.length) throw new Error("Maia found no compatible repertoire reply");
    const max = Math.max(...scored.map(item => item.logit));
    const weights = scored.map(item => Math.exp(item.logit - max));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = randomUnit() * total;
    for (let index = 0; index < scored.length; index++) {
      target -= weights[index];
      if (target <= 0) return scored[index].uci;
    }
    return scored[scored.length - 1].uci;
  }

  async function logitsFor(fen, selfRating, opponentRating) {
    await ensureWorker();
    const blackToMove = fen.split(/\s+/)[1] === "b";
    const modelFen = blackToMove ? mirrorFen(fen) : fen;
    const tokens = tokenize(modelFen);
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    worker.postMessage({
      type: "infer",
      id,
      tokens: tokens.buffer,
      selfRating: Number(selfRating),
      opponentRating: Number(opponentRating)
    }, [tokens.buffer]);
    return result;
  }

  async function chooseMove(fen, rating, allowedUcis) {
    if (!Array.isArray(allowedUcis) || !allowedUcis.length) throw new Error("No repertoire replies available");
    const logits = await logitsFor(fen, rating, rating);
    return sampleAllowed(logits, allowedUcis, fen.split(/\s+/)[1] === "b");
  }

  window.CRBMaia = {
    load: ensureWorker,
    chooseMove,
    get status() { return status; },
    get lastError() { return lastError; }
  };
})();
