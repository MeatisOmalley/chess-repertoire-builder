"use strict";
(() => {
  if (!/(^|\.)chess\.com$/i.test(location.hostname)) return;

  const root = document.documentElement;
  const BOARD_SELECTORS = ["wc-chess-board", "chess-board"];
  let lastSignal = "";

  function analysisContext() {
    return /^\/analysis(?:\/|$)/i.test(location.pathname) ||
      /^\/explorer(?:\/|$)/i.test(location.pathname) ||
      /^\/practice(?:\/|$)/i.test(location.pathname);
  }

  function blockedLiveContext() {
    if (analysisContext()) return false;
    const path = location.pathname.toLowerCase();
    return /^\/play\/online(?:\/|$)/.test(path) ||
      /^\/game\/live(?:\/|$)/.test(path) ||
      /^\/live(?:\/|$)/.test(path);
  }

  function findBoard() {
    let fallback = null;
    for (const selector of BOARD_SELECTORS) {
      for (const board of document.querySelectorAll(selector)) {
        fallback ||= board;
        const rect = board.getBoundingClientRect();
        if (rect.width >= 40 && rect.height >= 40) return board;
      }
    }
    return fallback;
  }

  function findGame(board) {
    if (!board) return null;
    if (board.game) return board.game;
    try {
      for (const key of Object.keys(board)) {
        const value = board[key];
        if (value && typeof value === "object" && (typeof value.getFEN === "function" || typeof value.getHistoryFENs === "function")) return value;
      }
    } catch (_) {}
    return null;
  }

  function callString(game, names) {
    for (const name of names) {
      try {
        if (typeof game?.[name] !== "function") continue;
        const value = game[name]();
        if (typeof value === "string" && value.includes("/")) return value;
      } catch (_) {}
    }
    return "";
  }

  function callArray(game, names) {
    for (const name of names) {
      try {
        if (typeof game?.[name] !== "function") continue;
        const value = game[name]();
        if (Array.isArray(value)) return value.map(item => String(item));
      } catch (_) {}
    }
    return [];
  }

  function snapshot() {
    root.dataset.crbChessComAnalysis = analysisContext() ? "1" : "0";
    if (blockedLiveContext()) return null;
    const board = findBoard();
    const game = findGame(board);
    if (!game) return null;
    const fen = callString(game, ["getFEN"]) || (typeof game.fen === "string" ? game.fen : "");
    if (!fen || !fen.includes("/")) return null;
    const historyFens = callArray(game, ["getHistoryFENs"]);
    const historySans = callArray(game, ["getHistorySANs"]);
    const startFen = callString(game, ["getStartFEN", "getInitialFEN", "getStartingFEN"]);
    return { fen, historyFens, historySans, startFen };
  }

  function publish() {
    const state = snapshot();
    if (!state) return;
    const signal = JSON.stringify(state);
    if (signal === lastSignal) return;
    lastSignal = signal;
    root.dataset.crbChessComState = signal;
    root.dispatchEvent(new Event("crb-chesscom-state"));
  }

  publish();
  const timer = setInterval(publish, 100);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
})();
