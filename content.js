"use strict";
(() => {
  const C = window.CRBChess;
  const MAIA = window.CRBMaia;
  const ROOT = "crb-panel";
  const SITE = /(^|\.)lichess\.org$/i.test(location.hostname) ? "lichess" : "chesscom";
  const SITE_LABEL = SITE === "lichess" ? "Lichess" : "Chess.com";
  const PANEL_POSITION_VERSION = 2;
  const STORE = "crbDataV1";
  const UI = "crbUiV1";
  const STUDY_STORE = "crbStudyV1";
  const OFFICIAL_REPERTOIRES_STORE = "crbOfficialRepertoiresV1";
  const OFFICIAL_REPERTOIRES_VERSION = 1;
  const OPENING_CHAPTERS_URL = chrome.runtime.getURL("opening-chapters.json");
  const OFFICIAL_REPERTOIRES = [
    { name: "Danish Gambit - Official", file: "official-repertoires/Danish_Gambit_-_Official.pgn" },
    { name: "Stafford Gambit - Official", file: "official-repertoires/Stafford_Gambit_-_Official.pgn" }
  ];
  const INITIAL = C.parseFen(C.START);
  const INITIAL_PLACEMENT = C.placement(INITIAL);
  const CORRECTION_CONTEXT_PLIES = 4;
  const CORRECTION_TRIGGER_PLIES = 1;
  const STUDY_REVIEW_INTERVALS_MS = [
    10 * 60 * 1000,
    24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
    14 * 24 * 60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000,
    60 * 24 * 60 * 60 * 1000
  ];
  const OPPONENT_PLAY_DELAY = 275;
  const LIVE_MOVE_EXPLANATION_MIN_MS = 3000;
  const STUDY_ADVANCE_DELAY = 350;
  const COMMENT_AUTO_MIN_DELAY = 1100;
  const COMMENT_AUTO_MAX_DELAY = 5200;
  const COMMENT_AUTO_MS_PER_CHAR = 24;

  let data = { repertoires: [], activeId: null };
  let studyData = { repertoires: {} };
  let history = [{ state: INITIAL, placement: INITIAL_PLACEMENT, move: null }];
  let cursor = 0;
  let lastTransition = null;
  let boardObserver = null;
  let boardAnnotationResizeObserver = null;
  let sampleTimer = null;
  let quietTimer = null;
  let burstPoll = null;
  let renderFrame = null;
  let observedPlacement = "";
  let latestUnmatched = "";
  let syncNotice = "";
  let uiState = {};
  let orderingCache = new Map();
  let study = freshStudyState();
  let livePractice = freshLivePracticeState();
  let lichessAuth = { checked: false, connected: false, error: "" };
  let openingChapterIndex = { meta: {}, positions: {} };
  let openingChapterLoadError = "";
  let migrationDirty = false;
  const chapterDiscoveryCache = new Map();
  let lastBoardPointerAt = 0;
  let lastNavigationIntentAt = 0;
  let boardPointerDown = false;
  let safetyTimer = null;
  let chapterNavigation = null;
  let lastChapterAutoSyncToken = "";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const stateKey = state => C.fen(state).split(/\s+/).slice(0, 4).join(" ");
  const repertoireTurn = rep => rep.color === "white" ? "w" : "b";

  function freshStudyState() {
    return {
      active: false,
      phase: "idle",
      message: "",
      comment: "",
      pendingAction: null,
      decisionCount: 0,
      correctCount: 0,
      mistakeCount: 0,
      lineCount: 0,
      lineVariantCount: 0,
      targetKey: null,
      targetKind: "new",
      targetPath: [],
      targetNext: new Map(),
      targetPositionIndex: new Map(),
      scopeRootKey: null,
      scopeRootState: null,
      scopeRootPlacement: INITIAL_PLACEMENT,
      scopeRootHistoryIndex: 0,
      scopeRootSetupPath: [],
      rootKey: null,
      rootState: null,
      rootPlacement: INITIAL_PLACEMENT,
      rootHistoryIndex: 0,
      rootSetupPath: [],
      rootIndexInScope: 0,
      lineStartHistoryIndex: 0,
      lineStartChapterId: null,
      lineStartLabel: "",
      scopeLinePath: [],
      linePath: [],
      scopedFromCurrent: false,
      scopeType: "all",
      scopeLabel: "All chapters",
      chapterId: null,
      setupAdvance: null,
      onTargetRoute: true,
      reachedTarget: false,
      catalog: [],
      catalogByKey: new Map(),
      shownTargets: new Set(),
      reviewQueue: [],
      lineVisited: new Set(),
      commentsShown: new Set(),
      expectedAuto: null,
      expectedAssisted: null,
      navigationLock: false,
      timer: null,
      navigationTimer: null,
      autoFailTimer: null,
      autoCommentTimer: null,
      wrong: null,
      answerShown: false,
      showAnswerLine: false,
      alternativeOffer: null,
      optionalLine: null,
      preferredPractice: null,
      lastIncomingEdge: null,
      correction: null
    };
  }

  function freshLivePracticeState() {
    return { active: false, phase: "idle", message: "", playerColor: "white", expectedAuto: null, retryAuto: null, lastUserChoices: null, timer: null, autoFailTimer: null, moves: 0, source: "" };
  }

  function clearLivePracticeTimers() {
    if (livePractice.timer) clearTimeout(livePractice.timer);
    if (livePractice.autoFailTimer) clearTimeout(livePractice.autoFailTimer);
    livePractice.timer = null;
    livePractice.autoFailTimer = null;
  }

  const save = () => chrome.storage.local.set({ [STORE]: data });
  const saveUi = () => chrome.storage.local.set({ [UI]: uiState });
  const saveStudy = () => chrome.storage.local.set({ [STUDY_STORE]: studyData });
  const scheduleRender = () => {
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      render();
    });
  };

  function migrateData() {
    let changed = false;
    for (const rep of data.repertoires || []) {
      if (rep.schemaVersion !== 4) changed = true;
      rep.schemaVersion = 4;
      const seenChapterRoots = new Set();
      const originalChapters = Array.isArray(rep.chapters) ? rep.chapters : [];
      rep.chapters = originalChapters.filter(chapter => {
        if (!chapter?.rootKey || !String(chapter.name || "").trim() || seenChapterRoots.has(chapter.rootKey)) {
          changed = true;
          return false;
        }
        seenChapterRoots.add(chapter.rootKey);
        const type = chapter.type === "auto" ? "auto" : "manual";
        if (chapter.type !== type) changed = true;
        chapter.type = type;
        return true;
      });
      // Superseded by persisted automatic chapters. Keeping this legacy state
      // would imply that chapters can still regenerate during rendering.
      if ("hiddenAutoChapters" in rep) {
        delete rep.hiddenAutoChapters;
        changed = true;
      }
      if ("autoChapterNames" in rep) {
        delete rep.autoChapterNames;
        changed = true;
      }
      for (const pos of Object.values(rep.positions || {})) {
        let preferredSeen = false;
        for (const edge of Object.values(pos.moves || {})) {
          if (typeof edge.preferred !== "boolean") {
            edge.preferred = edge.role === "main" || edge.role === "opponent-main";
            changed = true;
          }
          if (edge.preferred && !preferredSeen) {
            preferredSeen = true;
            if (!edge.preferredAt) {
              edge.preferredAt = edge.updatedAt || edge.createdAt || Date.now();
              changed = true;
            }
          } else if (edge.preferred) {
            edge.preferred = false;
            delete edge.preferredAt;
            changed = true;
          } else {
            if ("preferredAt" in edge) {
              delete edge.preferredAt;
              changed = true;
            }
          }
          if ("role" in edge) {
            delete edge.role;
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  const load = () => new Promise(resolve => chrome.storage.local.get([STORE, UI, STUDY_STORE], result => {
    if (result[STORE]) data = result[STORE];
    if (result[STUDY_STORE]) studyData = result[STUDY_STORE];
    migrationDirty = migrateData();
    resolve(result[UI] || {});
  }));

  function chessComContextBlocked() {
    const path = location.pathname.toLowerCase();
    return path.includes("/play/online") || path.includes("/game/live") || path.includes("/live");
  }

  function chessComCorrespondenceContext() {
    const path = location.pathname.toLowerCase();
    if (/^\/(?:analysis|explorer|practice)(?:\/|$)/.test(path)) return false;
    return /^\/game\/daily(?:\/|$)/.test(path) ||
      /^\/play\/daily(?:\/|$)/.test(path) ||
      /(?:^|\/)correspondence(?:\/|$)/.test(path);
  }

  function lichessAnalysisCapable() {
    return document.documentElement.dataset.crbLichessAnalysis === "1";
  }

  function lichessAnalysisContext() {
    const path = location.pathname.toLowerCase();
    return lichessAnalysisCapable() || /^\/analysis(?:\/|$)/.test(path) || /^\/study(?:\/|$)/.test(path) || !!$("main.analyse");
  }

  function lichessPageDescription() {
    return [
      $("meta[name='description']")?.content,
      $("meta[property='og:description']")?.content
    ].filter(Boolean).join(" ");
  }

  function lichessBotContext() {
    if ($$(".utitle").some(element => /^bot$/i.test(element.textContent.trim()))) return true;
    const users = $$(".ruser, .round__app .user-link, .game__meta").map(element => element.textContent || "").join(" ");
    const text = `${users} ${lichessPageDescription()}`;
    return /\bBOT\b/i.test(text) || /Stockfish\s+(?:level\s*)?\d+/i.test(text);
  }

  function lichessCorrespondenceContext() {
    return !!$(".rclock-correspondence") || /\bcorrespondence\b/i.test(lichessPageDescription());
  }

  function realCorrespondenceGameContext() {
    if (SITE === "chesscom") return chessComCorrespondenceContext();
    return lichessCorrespondenceContext() && !lichessAnalysisContext();
  }

  function contextAllowedNow() {
    if (SITE === "chesscom") return !chessComContextBlocked();
    return lichessAnalysisContext() || lichessBotContext() || lichessCorrespondenceContext();
  }

  function definitelyUnsafeLiveContext() {
    if (SITE === "chesscom") return chessComContextBlocked();
    return !!$(".round__app") && !lichessAnalysisContext() && !lichessBotContext() && !lichessCorrespondenceContext();
  }

  function fullBoardControlAvailable() {
    if (realCorrespondenceGameContext()) return false;
    return SITE === "chesscom" ? !chessComContextBlocked() : lichessAnalysisCapable();
  }

  async function waitForAllowedContext() {
    if (SITE === "chesscom") return contextAllowedNow();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (contextAllowedNow()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  function findBoard() {
    if (SITE === "lichess") return $("cg-board");
    for (const selector of ["wc-chess-board", "chess-board", "#board-layout-chessboard", ".board", ".chessboard", "[data-cy='board']"]) {
      const board = $(selector);
      if (board) return board;
    }
    return null;
  }

  function boardIsFlipped(board) {
    if (SITE === "lichess") return !!board.closest(".cg-wrap")?.classList.contains("orientation-black");
    return /flipped|black/.test(`${board.className} ${board.getAttribute("orientation")}`.toLowerCase());
  }

  function setBoardOrientation(color) {
    const board = findBoard();
    const wantFlipped = color === "black";
    if (board && boardIsFlipped(board) === wantFlipped) return;
    if (SITE === "lichess") {
      document.documentElement.dispatchEvent(new Event("crb-lichess-flip"));
      return;
    }
    const controls = [...document.querySelectorAll("button,[role='button'],[aria-label],[title]")]
      .filter(element => !element.closest?.(`#${ROOT}`) && !element.disabled);
    const flip = controls.find(element => /flip (the )?board|board orientation|switch sides/i.test(`${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("title") || ""} ${element.textContent || ""}`));
    flip?.click();
  }

  function boardPoint(square, rect, flipped) {
    const file = "abcdefgh".indexOf(square?.[0]);
    const rank = Number(square?.[1]) - 1;
    if (file < 0 || rank < 0 || rank > 7) return null;
    const size = rect.width / 8;
    const column = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return { x: (column + .5) * size, y: (row + .5) * size, size };
  }

  function clearBoardAnnotations() {
    $("#crb-board-annotations")?.remove();
  }

  function renderBoardAnnotations(rep, state, lastEdge = null) {
    clearBoardAnnotations();
    const board = findBoard();
    if (!board || !rep || !state) return;
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const flipped = boardIsFlipped(board);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "crb-board-annotations";
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    svg.setAttribute("width", `${rect.width}`);
    svg.setAttribute("height", `${rect.height}`);
    svg.setAttribute("aria-hidden", "true");
    Object.assign(svg.style, {
      position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      pointerEvents: "none", zIndex: "2147483000", overflow: "visible"
    });
    const make = name => document.createElementNS("http://www.w3.org/2000/svg", name);
    const nag = nagSymbol(lastEdge?.nag);
    if (nag && lastEdge?.uci) {
      const destination = boardPoint(lastEdge.uci.slice(2, 4), rect, flipped);
      if (destination) {
        const badgeX = destination.x + destination.size * .31;
        const badgeY = destination.y - destination.size * .31;
        const badge = make("text");
        badge.textContent = nag;
        badge.setAttribute("x", `${badgeX}`);
        badge.setAttribute("y", `${badgeY}`);
        badge.setAttribute("text-anchor", "middle");
        badge.setAttribute("dominant-baseline", "central");
        badge.setAttribute("font-family", "Arial, sans-serif");
        badge.setAttribute("font-size", `${Math.max(16, destination.size * .34)}`);
        badge.setAttribute("font-weight", "800");
        badge.setAttribute("fill", [1, 3].includes(lastEdge.nag) ? "#a9cf83" : [2, 4].includes(lastEdge.nag) ? "#dc8b7f" : "#d8b570");
        badge.setAttribute("stroke", "rgba(18, 18, 18, .88)");
        badge.setAttribute("stroke-width", `${Math.max(1.5, destination.size * .045)}`);
        badge.setAttribute("paint-order", "stroke");
        badge.setAttribute("opacity", "1");
        svg.append(badge);
      }
    }

    document.body.append(svg);
  }

  function placementFromPieces(pieces) {
    if (pieces.size < 2) return "";
    const rows = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "";
      let empty = 0;
      for (const file of "abcdefgh") {
        const piece = pieces.get(file + rank);
        if (!piece) empty++;
        else {
          if (empty) { row += empty; empty = 0; }
          row += piece;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join("/");
  }

  function readChessComPlacement(board) {
    const pieces = new Map();
    for (const element of board.querySelectorAll(".piece, [class*='square-']")) {
      const className = typeof element.className === "string" ? element.className : "";
      const square = className.match(/(?:^|\s)square-([1-8])([1-8])(?:\s|$)/);
      const piece = className.match(/(?:^|\s)([wb][prnbqk])(?:\s|$)/i);
      if (!square || !piece) continue;
      const file = "abcdefgh"[+square[1] - 1];
      const rank = square[2];
      const code = piece[1].toLowerCase();
      pieces.set(file + rank, code[0] === "w" ? code[1].toUpperCase() : code[1]);
    }
    return placementFromPieces(pieces);
  }

  function readLichessPlacement(board) {
    const bridgedFen = document.documentElement.dataset.crbLichessFen;
    if (lichessAnalysisCapable() && bridgedFen?.includes("/")) return bridgedFen.split(/\s+/)[0];
    if (boardPointerDown || board.querySelector("piece.dragging, piece.anim, piece.fading")) return "";
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return "";
    const wrap = board.closest(".cg-wrap");
    const flipped = !!wrap?.classList.contains("orientation-black");
    const roleCodes = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
    const pieces = new Map();
    for (const element of board.querySelectorAll("piece")) {
      if (element.classList.contains("ghost") || element.style.display === "none") continue;
      const color = element.classList.contains("white") ? "white" : element.classList.contains("black") ? "black" : null;
      const role = Object.keys(roleCodes).find(name => element.classList.contains(name));
      if (!color || !role) continue;
      const transform = element.style.transform || "";
      const match = transform.match(/translate(?:3d)?\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/i);
      if (!match) continue;
      const col = Math.round(+match[1] / (rect.width / 8));
      const row = Math.round(+match[2] / (rect.height / 8));
      if (col < 0 || col > 7 || row < 0 || row > 7) continue;
      const fileIndex = flipped ? 7 - col : col;
      const rank = flipped ? row + 1 : 8 - row;
      const code = roleCodes[role];
      pieces.set("abcdefgh"[fileIndex] + rank, color === "white" ? code.toUpperCase() : code);
    }
    return placementFromPieces(pieces);
  }

  function readPlacement() {
    const board = findBoard();
    if (!board) return "";
    return SITE === "lichess" ? readLichessPlacement(board) : readChessComPlacement(board);
  }

  function active() {
    return data.repertoires.find(rep => rep.id === data.activeId) || null;
  }

  function repertoireRecord(name, color) {
    return {
      id: uid(),
      schemaVersion: 4,
      name: name.trim() || `${color === "white" ? "White" : "Black"} Repertoire`,
      color,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rootKey: stateKey(INITIAL),
      positions: {},
      chapters: []
    };
  }

  function newRep(name, color) {
    const rep = repertoireRecord(name, color);
    data.repertoires.push(rep);
    data.activeId = rep.id;
    save();
    render();
  }

  function ensurePos(rep, key) {
    return rep.positions[key] || (rep.positions[key] = { key, moves: {}, comment: "" });
  }

  function addStoredChapter(rep, name, rootKey, type = "manual", details = {}) {
    const cleanName = String(name || "").replace(/\s+/g, " ").trim();
    if (!cleanName || !rootKey) return null;
    rep.chapters ||= [];
    // A chapter is a position checkpoint, so each repertoire position can
    // own at most one chapter regardless of its name or origin.
    const existing = rep.chapters.find(chapter => chapter.rootKey === rootKey);
    if (existing) return existing;
    const now = Date.now();
    const chapter = {
      id: `${type}-${uid()}`,
      type,
      name: cleanName,
      rootKey,
      createdAt: now,
      updatedAt: now,
      ...details
    };
    rep.chapters.push(chapter);
    return chapter;
  }

  function createAutomaticChapterForPosition(rep, key) {
    const record = openingChapterIndex.positions?.[key];
    if (!record?.name) return null;
    // This runs only when a position is first created. The root-key guard in
    // addStoredChapter prevents duplicates at this position without hiding a
    // distinct catalog position that happens to share the same opening name.
    return addStoredChapter(rep, record.name, key, "auto", {
      originalName: record.name,
      eco: record.eco || "",
      line: record.line || ""
    });
  }

  function currentState() {
    return history[cursor].state;
  }

  function currentPos(rep) {
    return rep ? rep.positions[stateKey(currentState())] || null : null;
  }

  function moveOwner(rep, mover) {
    return repertoireTurn(rep) === mover ? "repertoire" : "opponent";
  }

  function setPreferredAtPosition(pos, target) {
    const now = Date.now();
    for (const edge of Object.values(pos.moves || {})) {
      edge.preferred = edge === target;
      if (edge.preferred) edge.preferredAt = now;
      else delete edge.preferredAt;
    }
  }

  function addCurrent(preferred = false) {
    const rep = active();
    if (!rep || !lastTransition || cursor < 1) return;
    const now = Date.now();
    let currentEdge = null;
    let currentPosNode = null;
    for (let index = 1; index <= cursor; index++) {
      const parent = history[index - 1];
      const child = history[index];
      const move = child.move;
      if (!move) continue;
      const parentKey = stateKey(parent.state);
      const childKey = stateKey(child.state);
      const pos = ensurePos(rep, parentKey);
      let edge = pos.moves[move.uci];
      if (!edge) {
        edge = pos.moves[move.uci] = {
          uci: move.uci,
          san: move.san,
          childKey,
          preferred: false,
          nag: null,
          comment: "",
          createdAt: now,
          updatedAt: now
        };
      } else {
        edge.childKey = childKey;
        edge.san = edge.san || move.san;
        edge.updatedAt = now;
      }
      const childWasStored = !!rep.positions[childKey];
      ensurePos(rep, childKey);
      if (!childWasStored) createAutomaticChapterForPosition(rep, childKey);
      if (index === cursor) {
        currentEdge = edge;
        currentPosNode = pos;
      }
    }
    if (preferred && currentEdge && currentPosNode) setPreferredAtPosition(currentPosNode, currentEdge);
    rep.updatedAt = now;
    save();
    render();
  }

  function edgeAtCurrent() {
    const rep = active();
    if (!rep || !lastTransition || cursor < 1) return null;
    return rep.positions[stateKey(history[cursor - 1].state)]?.moves?.[lastTransition.move.uci] || null;
  }

  function updateEdge(fn) {
    const edge = edgeAtCurrent();
    const rep = active();
    if (!edge || !rep) return;
    fn(edge);
    edge.updatedAt = Date.now();
    rep.updatedAt = Date.now();
    save();
    render();
  }

  function deleteCurrentMove() {
    const rep = active();
    const edge = edgeAtCurrent();
    if (!rep || !edge) return;
    const parentKey = stateKey(history[cursor - 1].state);
    if (!confirm(`Remove ${edge.san} from “${rep.name}”? Its continuation remains if another line reaches it.`)) return;
    delete rep.positions[parentKey].moves[edge.uci];
    garbageCollect(rep);
    rep.updatedAt = Date.now();
    save();
    render();
  }

  function garbageCollect(rep) {
    const seen = new Set();
    const walk = key => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const edge of Object.values(rep.positions[key]?.moves || {})) walk(edge.childKey);
    };
    walk(rep.rootKey);
    for (const key of Object.keys(rep.positions)) if (!seen.has(key)) delete rep.positions[key];
    rep.chapters = (rep.chapters || []).filter(chapter => seen.has(chapter.rootKey));
  }

  function stableHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function chapterNameParts(name) {
    return String(name || "Chapter")
      .split(/\s*:\s*|\s*,\s*/)
      .map(part => part.trim())
      .filter(Boolean);
  }

  function chapterTaxonomyName(chapter) {
    return String(chapter?.originalName || chapter?.name || "Chapter").trim();
  }

  function chapterNameIsParent(parent, child) {
    const parentName = chapterTaxonomyName(parent).toLocaleLowerCase();
    const childName = chapterTaxonomyName(child).toLocaleLowerCase();
    if (!parentName || childName.length <= parentName.length || !childName.startsWith(parentName)) return false;
    return /^[\s:,-]/.test(childName.slice(parentName.length));
  }

  function chapterRouteContainsAncestor(child, possibleParent) {
    if (!child?.route || !possibleParent?.route || possibleParent.route.depth >= child.route.depth) return false;
    return child.route.path.some(step => step.parentKey === possibleParent.rootKey);
  }

  function relativeChapterLabel(parent, child) {
    const parentName = String(parent?.name || "").trim();
    const childName = String(child?.name || "Chapter").trim();
    if (!parentName || childName.length <= parentName.length || childName.slice(0, parentName.length).toLocaleLowerCase() !== parentName.toLocaleLowerCase()) return childName;
    const remainder = childName.slice(parentName.length).replace(/^[\s:,-]+/, "").trim();
    return remainder || childName;
  }

  function organizeChapterHierarchy(chapters) {
    for (const child of chapters) {
      const ancestors = chapters.filter(candidate => candidate.id !== child.id && chapterRouteContainsAncestor(child, candidate));
      const semanticAncestors = ancestors.filter(candidate => chapterNameIsParent(candidate, child));
      const pool = semanticAncestors.length ? semanticAncestors : ancestors;
      const parent = pool.sort((a, b) =>
        b.route.depth - a.route.depth ||
        (a.type === "auto" ? -1 : 1) - (b.type === "auto" ? -1 : 1) ||
        a.name.localeCompare(b.name)
      )[0] || null;
      child.parentId = parent?.id || null;
    }

    const byParent = new Map();
    for (const chapter of chapters) {
      const parentId = chapters.some(item => item.id === chapter.parentId) ? chapter.parentId : null;
      chapter.parentId = parentId;
      const bucket = byParent.get(parentId) || [];
      bucket.push(chapter);
      byParent.set(parentId, bucket);
    }
    const sortSiblings = values => values.sort((a, b) =>
      relativeChapterLabel(chapters.find(item => item.id === a.parentId), a).localeCompare(relativeChapterLabel(chapters.find(item => item.id === b.parentId), b)) ||
      a.route.depth - b.route.depth ||
      a.type.localeCompare(b.type) ||
      a.id.localeCompare(b.id)
    );
    for (const values of byParent.values()) sortSiblings(values);

    const flattened = [];
    const visit = (chapter, depth) => {
      const parent = chapter.parentId ? chapters.find(item => item.id === chapter.parentId) : null;
      chapter.treeDepth = depth;
      chapter.displayLabel = parent ? relativeChapterLabel(parent, chapter) : chapter.name;
      flattened.push(chapter);
      for (const child of byParent.get(chapter.id) || []) visit(child, depth + 1);
    };
    for (const root of byParent.get(null) || []) visit(root, 0);
    return flattened;
  }

  function repertoirePositionMap(rep) {
    const positionCount = Object.keys(rep.positions || {}).length;
    let edgeCount = 0;
    for (const position of Object.values(rep.positions || {})) edgeCount += Object.keys(position.moves || {}).length;
    const cacheKey = `${rep.id}|${rep.updatedAt || 0}|${positionCount}|${edgeCount}`;
    const cached = chapterDiscoveryCache.get(cacheKey);
    if (cached) return cached;
    const found = new Map([[rep.rootKey, { key: rep.rootKey, state: INITIAL, path: [], depth: 0 }]]);
    const queue = [rep.rootKey];
    while (queue.length) {
      const key = queue.shift();
      const entry = found.get(key);
      const edges = Object.values(rep.positions[key]?.moves || {}).slice().sort((a, b) => {
        const preferred = (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
        return preferred || (a.createdAt || 0) - (b.createdAt || 0) || String(a.san).localeCompare(String(b.san));
      });
      for (const edge of edges) {
        const next = applyUci(entry.state, edge.uci);
        if (!next) continue;
        const childKey = stateKey(next);
        if (childKey !== edge.childKey || found.has(childKey)) continue;
        found.set(childKey, {
          key: childKey,
          state: next,
          path: [...entry.path, { parentKey: key, childKey, uci: edge.uci, san: edge.san }],
          depth: entry.depth + 1
        });
        queue.push(childKey);
      }
    }
    chapterDiscoveryCache.clear();
    chapterDiscoveryCache.set(cacheKey, found);
    return found;
  }

  function availableChapters(rep) {
    if (!rep) return [];
    const reachable = repertoirePositionMap(rep);
    const chapters = [];
    for (const chapter of rep.chapters || []) {
      const route = reachable.get(chapter.rootKey);
      if (!route) continue;
      chapters.push({
        ...chapter,
        id: chapter.id || `manual-${stableHash(`${chapter.rootKey}|${chapter.name}`)}`,
        type: chapter.type === "auto" ? "auto" : "manual",
        originalName: chapter.originalName || chapter.name,
        parts: chapterNameParts(chapter.name),
        route
      });
    }
    const nameCounts = new Map();
    for (const chapter of chapters) nameCounts.set(chapter.name, (nameCounts.get(chapter.name) || 0) + 1);
    chapters.forEach(chapter => chapter.duplicateName = (nameCounts.get(chapter.name) || 0) > 1);
    return organizeChapterHierarchy(chapters);
  }

  function selectedChapterId(rep) {
    return uiState.selectedChapterByRep?.[rep.id] || "";
  }

  function selectedChapter(rep, chapters = availableChapters(rep)) {
    const id = selectedChapterId(rep);
    return id ? chapters.find(chapter => chapter.id === id) || null : null;
  }

  function setSelectedChapter(rep, id) {
    uiState.selectedChapterByRep ||= {};
    if (id) uiState.selectedChapterByRep[rep.id] = id;
    else delete uiState.selectedChapterByRep[rep.id];
    saveUi();
  }

  function currentPositionIsStored(rep) {
    const key = stateKey(currentState());
    return !!rep && (key === rep.rootKey || !!rep.positions[key]);
  }

  function createChapterFromCurrent() {
    const rep = active();
    if (!rep || !currentPositionIsStored(rep)) {
      alert("The current board position must be included in the selected repertoire first.");
      return;
    }
    const key = stateKey(currentState());
    const automatic = openingChapterIndex.positions?.[key]?.name || "";
    const name = prompt("Chapter name:", automatic || "New chapter");
    if (!name?.trim()) return;
    const chapter = addStoredChapter(rep, name, key, "manual");
    if (!chapter) return;
    rep.updatedAt = Date.now();
    setSelectedChapter(rep, chapter.id);
    save();
    render();
  }

  function renameSelectedChapter() {
    const rep = active();
    if (!rep) return;
    const chapters = availableChapters(rep);
    const chapter = selectedChapter(rep, chapters);
    if (!chapter) {
      alert("Select a chapter first. “All chapters” is not a deletable or renameable chapter.");
      return;
    }
    const name = prompt("Chapter name:", chapter.name);
    if (!name?.trim()) return;
    const stored = rep.chapters.find(item => item.id === chapter.id);
    if (stored) {
      stored.name = name.trim();
      stored.updatedAt = Date.now();
    }
    rep.updatedAt = Date.now();
    save();
    render();
  }

  function deleteSelectedChapter() {
    const rep = active();
    if (!rep) return;
    const chapters = availableChapters(rep);
    const chapter = selectedChapter(rep, chapters);
    if (!chapter) {
      alert("Select a chapter first. “All chapters” cannot be deleted.");
      return;
    }
    const detail = chapter.type === "auto"
      ? "This permanently removes the automatic opening label but does not delete any repertoire moves. It will not regenerate when you revisit this position."
      : "This removes only the chapter label and does not delete any repertoire moves.";
    if (!confirm(`Delete chapter “${chapter.name}”?\n\n${detail}`)) return;
    rep.chapters = (rep.chapters || []).filter(item => item.id !== chapter.id);
    rep.updatedAt = Date.now();
    setSelectedChapter(rep, "");
    save();
    render();
  }

  function chapterOptionHtml(chapter) {
    const depth = Math.max(0, chapter.treeDepth || 0);
    const segment = chapter.displayLabel || chapter.name;
    const indent = depth ? `${"\u2003".repeat(depth)}↳ ` : "";
    const source = chapter.type === "manual" ? " ✎" : "";
    const duplicate = chapter.duplicateName && chapter.line ? ` — ${chapter.line}` : "";
    const selected = selectedChapterId(active()) === chapter.id ? "selected" : "";
    return `<option value="${esc(chapter.id)}" ${selected} title="${esc(chapter.name + (chapter.line ? ` · ${chapter.line}` : ""))}">${esc(indent + segment + source + duplicate)}</option>`;
  }


  function exactChapterAtPosition(chapters, key, preferredId = "") {
    const exact = chapters.filter(chapter => chapter.rootKey === key);
    if (!exact.length) return null;
    return exact.find(chapter => chapter.id === preferredId) || exact.sort((a, b) => {
      const manual = (a.type === "manual" ? -1 : 1) - (b.type === "manual" ? -1 : 1);
      return manual || b.name.length - a.name.length || a.name.localeCompare(b.name);
    })[0];
  }

  function syncChapterSelectionToBoard(rep, chapters) {
    if (!rep || chapterNavigation) return;
    const key = stateKey(currentState());
    const token = `${rep.id}|${key}`;
    if (lastChapterAutoSyncToken === token) return;
    lastChapterAutoSyncToken = token;
    const chapter = exactChapterAtPosition(chapters, key, selectedChapterId(rep));
    if (!chapter || selectedChapterId(rep) === chapter.id) return;
    setSelectedChapter(rep, chapter.id);
  }

  function clearChapterNavigation() {
    if (chapterNavigation?.timer) clearTimeout(chapterNavigation.timer);
    chapterNavigation = null;
  }

  function finishChapterNavigation(success, message = "") {
    const navigation = chapterNavigation;
    if (!navigation) return;
    if (navigation.timer) clearTimeout(navigation.timer);
    chapterNavigation = null;
    const rep = active();
    if (success && rep?.id === navigation.repId) {
      setSelectedChapter(rep, navigation.chapterId);
      lastChapterAutoSyncToken = `${rep.id}|${navigation.rootKey}`;
      syncNotice = message || `Moved to chapter: ${navigation.chapterName}`;
    } else if (!success) {
      syncNotice = message || `Could not move the ${SITE_LABEL} board to “${navigation.chapterName}”.`;
    }
    render();
  }

  function navigateChapterHistory(targetIndex, targetKey) {
    let attempts = 0;
    const tick = () => {
      if (!chapterNavigation) return;
      if (cursor === targetIndex && stateKey(currentState()) === targetKey) {
        finishChapterNavigation(true);
        return;
      }
      if (attempts++ >= 90) {
        finishChapterNavigation(false);
        return;
      }
      const arrowKey = cursor > targetIndex ? "ArrowLeft" : "ArrowRight";
      const preferBeginning = arrowKey === "ArrowLeft" && targetIndex === 0;
      lastNavigationIntentAt = performance.now();
      const clicked = clickNavigationControl(arrowKey, preferBeginning && attempts === 1);
      if (!clicked) dispatchArrow(arrowKey);
      chapterNavigation.timer = setTimeout(tick, 90);
    };
    tick();
  }

  function navigateChapterToInitial(callback) {
    let attempts = 0;
    const tick = () => {
      if (!chapterNavigation) return;
      const placement = readPlacement();
      if (placement === INITIAL_PLACEMENT) {
        acceptPlacement(placement);
        callback(true);
        return;
      }
      if (attempts++ >= 90) {
        callback(false);
        return;
      }
      lastNavigationIntentAt = performance.now();
      const clicked = clickNavigationControl("ArrowLeft", attempts === 1);
      if (!clicked) dispatchArrow("ArrowLeft");
      chapterNavigation.timer = setTimeout(tick, 90);
    };
    tick();
  }

  function playChapterSetupPath(path, index = 0) {
    if (!chapterNavigation) return;
    if (index >= path.length) {
      finishChapterNavigation(stateKey(currentState()) === chapterNavigation.rootKey);
      return;
    }
    const step = path[index];
    if (stateKey(currentState()) !== step.parentKey || !playMove(step.uci)) {
      finishChapterNavigation(false, "The stored chapter route could not be replayed on the board.");
      return;
    }
    let attempts = 0;
    const waitForMove = () => {
      if (!chapterNavigation) return;
      if (stateKey(currentState()) === step.childKey) {
        chapterNavigation.timer = setTimeout(() => playChapterSetupPath(path, index + 1), 65);
        return;
      }
      if (attempts++ >= 30) {
        finishChapterNavigation(false, `${SITE_LABEL} did not accept a chapter setup move.`);
        return;
      }
      chapterNavigation.timer = setTimeout(waitForMove, 60);
    };
    chapterNavigation.timer = setTimeout(waitForMove, 60);
  }

  function navigateToSelectedChapter(chapter) {
    const rep = active();
    if (!rep || !chapter) return;
    if (!fullBoardControlAvailable()) {
      alert(realCorrespondenceGameContext()
        ? "Board control is disabled on real correspondence game pages. Open the position in Analysis to navigate to this chapter."
        : "Moving to a chapter requires an Analysis, Study, or other non-game analysis board.");
      return;
    }
    clearChapterNavigation();
    chapterNavigation = {
      repId: rep.id,
      chapterId: chapter.id,
      chapterName: chapter.name,
      rootKey: chapter.rootKey,
      route: chapter.route,
      timer: null
    };
    syncNotice = `Moving to chapter: ${chapter.name}…`;
    render();
    if (stateKey(currentState()) === chapter.rootKey) {
      finishChapterNavigation(true);
      return;
    }
    const knownIndex = matchingHistoryIndex(chapter.rootKey);
    if (knownIndex >= 0) {
      navigateChapterHistory(knownIndex, chapter.rootKey);
      return;
    }
    const path = chapter.route?.path || [];
    if (!path.length) {
      finishChapterNavigation(false);
      return;
    }
    navigateChapterToInitial(success => {
      if (!chapterNavigation) return;
      if (!success) {
        finishChapterNavigation(false);
        return;
      }
      playChapterSetupPath(path);
    });
  }

  function deleteRep() {
    const rep = active();
    if (!rep) return;
    if (!confirm(`Permanently delete the entire repertoire “${rep.name}”?`)) return;
    if (study.active) exitStudy();
    data.repertoires = data.repertoires.filter(item => item.id !== rep.id);
    data.activeId = data.repertoires[0]?.id || null;
    save();
    render();
  }

  function renameRep() {
    const rep = active();
    if (!rep) return;
    const name = prompt("Repertoire name:", rep.name);
    if (name?.trim()) {
      rep.name = name.trim();
      rep.updatedAt = Date.now();
      save();
      render();
    }
  }

  function setNag(nag) {
    updateEdge(edge => edge.nag = edge.nag === nag ? null : nag);
  }

  function saveComment() {
    const text = $(".crb-comment")?.value || "";
    updateEdge(edge => edge.comment = text.trim());
  }

  function nagSymbol(nag) {
    return ({ 1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!" })[nag] || "";
  }

  function preferredUiLabel(rep, state, selected = false) {
    const ownMove = moveOwner(rep, state.turn) === "repertoire";
    if (ownMove) return selected ? "Preferred ✓" : "Mark preferred";
    return selected ? "Mainline ✓" : "Mark mainline";
  }

  function preferredBadge(rep, state) {
    return moveOwner(rep, state.turn) === "repertoire" ? "Preferred" : "Mainline";
  }

  function renderCurrentAction(rep, edge, last) {
    const parentState = history[Math.max(0, cursor - 1)]?.state || currentState();
    const label = preferredUiLabel(rep, parentState, !!edge?.preferred);
    if (!edge) {
      const addLabel = moveOwner(rep, parentState.turn) === "repertoire" ? "Include line + prefer move" : "Include line + mark mainline";
      return `<section><div class="crb-title">Add line ending in ${esc(last.san)}</div><div class="crb-actions"><button data-add="included" title="Include every missing move from the starting position through the current move.">Include line</button><button data-add="preferred" title="Include the full line, but mark only the current move.">${addLabel}</button></div></section>`;
    }
    const status = edge.preferred ? ` · ${preferredBadge(rep, parentState)}` : "";
    return `<section><div class="crb-title">Included move${status}</div><div class="crb-role-actions"><button class="crb-preferred ${edge.preferred ? "selected" : ""}" title="This mark applies only to the current move at its immediate parent position.">${label}</button><button class="danger crb-delete-move">Remove move</button></div><div class="crb-title crb-annotation-title">Annotation</div><div class="crb-nags">${[1, 2, 3, 4, 5, 6].map(nag => `<button data-nag="${nag}" class="${edge.nag === nag ? "selected" : ""}">${nagSymbol(nag)}</button>`).join("")}</div><div class="crb-title">Comment</div><textarea class="crb-comment" placeholder="Comment attached to this move">${esc(edge.comment || "")}</textarea><button class="crb-save-comment">Save comment</button></section>`;
  }

  function longestContinuation(rep, key, visiting = new Set()) {
    if (!key || visiting.has(key)) return 0;
    const cacheKey = `depth|${rep.id}|${key}`;
    if (orderingCache.has(cacheKey)) return orderingCache.get(cacheKey);
    const moves = Object.values(rep.positions[key]?.moves || {});
    if (!moves.length) {
      orderingCache.set(cacheKey, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    let best = 0;
    for (const edge of moves) best = Math.max(best, 1 + longestContinuation(rep, edge.childKey, nextVisiting));
    orderingCache.set(cacheKey, best);
    return best;
  }

  function edgePlyCount(rep, edge) {
    return 1 + longestContinuation(rep, edge.childKey, new Set());
  }

  function sortedEdges(rep, key) {
    const edges = Object.values(rep.positions[key]?.moves || {}).slice();
    return edges.sort((a, b) => {
      const marked = (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
      if (marked) return marked;
      const depth = edgePlyCount(rep, b) - edgePlyCount(rep, a);
      if (depth) return depth;
      return (a.createdAt || 0) - (b.createdAt || 0) || a.san.localeCompare(b.san);
    });
  }

  function preferredOrLongestEdge(rep, key) {
    const edges = sortedEdges(rep, key);
    return edges.find(edge => edge.preferred) || edges[0] || null;
  }

  function previewToken(state, edge, first) {
    const san = `${edge.san}${nagSymbol(edge.nag)}`;
    if (state.turn === "w") return `${state.full}. ${san}`;
    return first ? `${state.full}... ${san}` : san;
  }

  function principalPreview(rep, edge, state, maxPlies = 80) {
    const parts = [previewToken(state, edge, true)];
    const path = new Set([stateKey(state)]);
    let next = applyUci(state, edge.uci);
    let key = edge.childKey;
    let plies = 1;
    while (next && plies < maxPlies) {
      if (path.has(key)) {
        parts.push("↻");
        break;
      }
      path.add(key);
      const child = sortedEdges(rep, key)[0];
      if (!child) break;
      parts.push(previewToken(next, child, false));
      next = applyUci(next, child.uci);
      key = child.childKey;
      plies++;
    }
    return parts.join(" ");
  }

  function stableLineId(rep, parentKey, edge) {
    const text = `${rep.id}|${parentKey}|${edge.uci}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `l${(hash >>> 0).toString(36)}`;
  }

  function lineIsOpen(id) {
    return !!uiState.expandedLines?.[id];
  }

  function lineDetailsAttrs(id) {
    return `data-line-id="${id}" ${lineIsOpen(id) ? "open" : ""}`;
  }

  function renderNestedVariation(rep, parentKey, edge, state, path, depth) {
    const id = stableLineId(rep, parentKey, edge);
    const open = lineIsOpen(id);
    const preview = principalPreview(rep, edge, state);
    const next = applyUci(state, edge.uci);
    const nextPath = new Set(path);
    nextPath.add(parentKey);
    return `<details class="crb-nested-line" ${lineDetailsAttrs(id)}><summary><span class="crb-chevron">›</span><span class="crb-nested-preview" title="${esc(preview)}">${esc(preview)}</span></summary>${open ? `<div class="crb-nested-body">${edge.comment ? `<div class="crb-line-comment">${esc(edge.comment)}</div>` : ""}${next ? renderContinuationTree(rep, edge.childKey, next, nextPath, depth + 1) : ""}</div>` : ""}</details>`;
  }

  function renderContinuationTree(rep, key, state, path = new Set(), depth = 0) {
    if (depth > 80 || path.has(key)) return `<div class="crb-tree-end">↻ Repeated position</div>`;
    const edges = sortedEdges(rep, key);
    if (!edges.length) return `<div class="crb-tree-end">End of stored line</div>`;
    const nextPath = new Set(path);
    nextPath.add(key);
    const main = edges[0];
    const alternatives = edges.slice(1);
    const next = applyUci(state, main.uci);
    return `<div class="crb-tree-level"><div class="crb-tree-main"><span class="crb-tree-token">${esc(previewToken(state, main, true))}</span>${main.preferred ? `<span class="crb-tree-badge">${preferredBadge(rep, state)}</span>` : ""}${main.comment ? `<div class="crb-line-comment">${esc(main.comment)}</div>` : ""}</div>${alternatives.length ? `<div class="crb-tree-sidelines"><div class="crb-sideline-label">Other continuations</div>${alternatives.map(edge => renderNestedVariation(rep, key, edge, state, nextPath, depth + 1)).join("")}</div>` : ""}${next ? `<div class="crb-tree-next">${renderContinuationTree(rep, main.childKey, next, nextPath, depth + 1)}</div>` : ""}</div>`;
  }

  function renderLineCard(rep, parentKey, edge, state) {
    const id = stableLineId(rep, parentKey, edge);
    const open = lineIsOpen(id);
    const preview = principalPreview(rep, edge, state);
    const next = applyUci(state, edge.uci);
    const badge = edge.preferred ? preferredBadge(rep, state) : "";
    const playButton = fullBoardControlAvailable()
      ? `<button class="crb-play" data-play="${edge.uci}">Play</button>`
      : `<button class="crb-play" disabled title="Board control is disabled on real correspondence game pages.">Play</button>`;
    return `<div class="crb-line-card ${edge.preferred ? "preferred" : ""}"><div class="crb-line-row"><details class="crb-line-details" ${lineDetailsAttrs(id)}><summary><span class="crb-chevron">›</span><span class="crb-line-summary"><span class="crb-line-head"><b>${edge.preferred ? "★ " : ""}${esc(edge.san)}${nagSymbol(edge.nag)}</b>${badge ? `<small>${badge}</small>` : ""}</span><span class="crb-line-preview" title="${esc(preview)}">${esc(preview)}</span></span></summary>${open ? `<div class="crb-expanded-line">${edge.comment ? `<div class="crb-line-comment">${esc(edge.comment)}</div>` : ""}${next ? renderContinuationTree(rep, edge.childKey, next, new Set([parentKey]), 1) : `<div class="crb-tree-end">End of stored line</div>`}</div>` : ""}</details>${playButton}</div></div>`;
  }

  function studyRepStore(rep) {
    studyData.repertoires ||= {};
    return studyData.repertoires[rep.id] || (studyData.repertoires[rep.id] = { positions: {}, opponentEdges: {} });
  }

  function normalizeStudyPositionStat(stat) {
    if (!Number.isFinite(stat.attempts)) stat.attempts = 0;
    if (!Number.isFinite(stat.mistakes)) stat.mistakes = 0;
    if (!Number.isFinite(stat.reveals)) stat.reveals = 0;
    if (!Number.isFinite(stat.correctStreak)) stat.correctStreak = 0;
    if (typeof stat.needsReview !== "boolean") stat.needsReview = false;
    if (!Number.isFinite(stat.lastReviewedAt)) stat.lastReviewedAt = 0;
    if (!Number.isFinite(stat.lastWrongAt)) stat.lastWrongAt = 0;
    if (!Number.isFinite(stat.dueAt)) stat.dueAt = 0;
    if (!Number.isFinite(stat.reviewPresentations)) stat.reviewPresentations = 0;
    if (!Number.isFinite(stat.linePresentations)) stat.linePresentations = 0;
    return stat;
  }

  function studyPositionStat(rep, key) {
    const store = studyRepStore(rep);
    const stat = store.positions[key] || (store.positions[key] = {
      attempts: 0,
      mistakes: 0,
      reveals: 0,
      correctStreak: 0,
      needsReview: false,
      lastReviewedAt: 0,
      lastWrongAt: 0,
      dueAt: 0,
      reviewPresentations: 0,
      linePresentations: 0
    });
    return normalizeStudyPositionStat(stat);
  }

  function existingStudyPositionStat(rep, key) {
    const stat = studyData.repertoires?.[rep.id]?.positions?.[key] || null;
    return stat ? normalizeStudyPositionStat(stat) : null;
  }

  function studyPositionDue(stat, now = Date.now()) {
    if (!stat) return false;
    normalizeStudyPositionStat(stat);
    return stat.needsReview || (stat.dueAt > 0 && stat.dueAt <= now);
  }

  function studyPositionMastered(stat, now = Date.now()) {
    if (!stat) return false;
    normalizeStudyPositionStat(stat);
    return stat.attempts >= 2 && stat.correctStreak >= 2 && !studyPositionDue(stat, now);
  }

  function reviewIntervalForStreak(streak) {
    const index = Math.max(0, Math.min(STUDY_REVIEW_INTERVALS_MS.length - 1, Math.max(1, streak) - 1));
    return STUDY_REVIEW_INTERVALS_MS[index];
  }

  function studyMasteryInfo(stat) {
    const streak = Math.max(0, Number(stat?.correctStreak) || 0);
    const steps = [0, 18, 36, 53, 68, 81, 92, 100];
    const percent = steps[Math.min(streak, steps.length - 1)];
    const label = streak === 0 ? "New" : streak === 1 ? "Learning" : streak < 4 ? "Familiar" : streak < 6 ? "Strong" : "Mastered";
    const next = streak < STUDY_REVIEW_INTERVALS_MS.length
      ? reviewIntervalForStreak(streak + 1)
      : STUDY_REVIEW_INTERVALS_MS[STUDY_REVIEW_INTERVALS_MS.length - 1];
    return { streak, percent, label, next };
  }

  function formatStudyInterval(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const days = Math.round(minutes / 1440);
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  function studyScopeMastery(rep) {
    const items = [...new Map((study.catalog || []).map(item => [item.key, item])).values()];
    if (!items.length) return { percent: 0, established: 0, total: 0, label: "New" };
    const levels = items.map(item => studyMasteryInfo(existingStudyPositionStat(rep, item.key)));
    const percent = Math.round(levels.reduce((sum, level) => sum + level.percent, 0) / levels.length);
    const established = levels.filter(level => level.streak >= 2).length;
    const label = percent < 18 ? "New" : percent < 45 ? "Learning" : percent < 70 ? "Developing" : percent < 90 ? "Strong" : "Mastered";
    return { percent, established, total: levels.length, label };
  }

  function opponentEdgeStat(rep, parentKey, uci) {
    const store = studyRepStore(rep);
    const id = `${parentKey}|${uci}`;
    return store.opponentEdges[id] || (store.opponentEdges[id] = { seen: 0, lastSeenAt: 0 });
  }

  function enqueueReview(key, dueAt) {
    const existing = study.reviewQueue.find(item => item.key === key);
    if (existing) existing.dueAt = Math.min(existing.dueAt, dueAt);
    else study.reviewQueue.push({ key, dueAt });
  }

  function recordStudyWrong(rep, key) {
    const stat = studyPositionStat(rep, key);
    stat.attempts++;
    stat.mistakes++;
    stat.correctStreak = 0;
    stat.needsReview = true;
    stat.lastWrongAt = Date.now();
    stat.dueAt = Date.now();
    enqueueReview(key, study.decisionCount + 3);
    study.mistakeCount++;
    saveStudy();
  }

  function recordAnswerReveal(rep, key) {
    const stat = studyPositionStat(rep, key);
    stat.reveals++;
    stat.correctStreak = 0;
    stat.needsReview = true;
    stat.dueAt = Date.now();
    enqueueReview(key, study.decisionCount + 1);
    saveStudy();
  }

  function recordStudyCorrect(rep, key) {
    const stat = studyPositionStat(rep, key);
    stat.attempts++;
    stat.correctStreak++;
    stat.lastReviewedAt = Date.now();
    stat.dueAt = stat.lastReviewedAt + reviewIntervalForStreak(stat.correctStreak);
    if (stat.correctStreak >= 2) {
      stat.needsReview = false;
      study.reviewQueue = study.reviewQueue.filter(item => item.key !== key);
    } else if (stat.needsReview) {
      enqueueReview(key, study.decisionCount + 3);
    }
    study.correctCount++;
    saveStudy();
  }

  function markOpponentEdgeSeen(rep, parentKey, edge) {
    const stat = opponentEdgeStat(rep, parentKey, edge.uci);
    stat.seen++;
    stat.lastSeenAt = Date.now();
    saveStudy();
  }

  function buildStudyCatalog(rep, rootKey = rep.rootKey, rootState = INITIAL) {
    const catalog = [];
    const visited = new Set();
    const walk = (key, state, path) => {
      if (visited.has(key)) return;
      visited.add(key);
      const edges = sortedEdges(rep, key);
      if (moveOwner(rep, state.turn) === "repertoire" && edges.length) {
        catalog.push({
          key,
          state,
          path: path.slice(),
          depth: path.length,
          remainingPlies: longestContinuation(rep, key)
        });
      }
      for (const edge of edges) {
        const next = applyUci(state, edge.uci);
        if (!next) continue;
        walk(edge.childKey, next, [...path, { parentKey: key, uci: edge.uci, childKey: edge.childKey, san: edge.san }]);
      }
    };
    walk(rootKey, rootState, []);
    return catalog;
  }

  function studyTargetDepth(item) {
    return Number.isFinite(item?.depth) ? item.depth : item?.path?.length || 0;
  }

  function rootFirstTargetSort(a, b) {
    const depth = studyTargetDepth(a) - studyTargetDepth(b);
    if (depth) return depth;
    const continuation = (b.remainingPlies || 0) - (a.remainingPlies || 0);
    if (continuation) return continuation;
    return String(a.key).localeCompare(String(b.key));
  }

  function chooseIntendedLineEdge(rep, key, state) {
    const edges = sortedEdges(rep, key);
    if (!edges.length) return null;
    if (moveOwner(rep, state.turn) === "repertoire") return edges.find(edge => edge.preferred) || edges[0];
    return edges.slice().sort((a, b) => {
      const aStat = opponentEdgeStat(rep, key, a.uci);
      const bStat = opponentEdgeStat(rep, key, b.uci);
      if (aStat.seen !== bStat.seen) return aStat.seen - bStat.seen;
      const marked = (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
      if (marked) return marked;
      const depth = edgePlyCount(rep, b) - edgePlyCount(rep, a);
      if (depth) return depth;
      return (a.createdAt || 0) - (b.createdAt || 0);
    })[0];
  }

  function completeStudyPath(rep, target) {
    const path = target.path.slice();
    let key = target.key;
    let state = target.state;
    const visited = new Set([study.scopeRootKey, ...path.map(step => step.childKey)]);
    for (let guard = 0; guard < 200; guard++) {
      const edge = chooseIntendedLineEdge(rep, key, state);
      if (!edge) break;
      const next = applyUci(state, edge.uci);
      if (!next || visited.has(edge.childKey)) break;
      path.push({ parentKey: key, uci: edge.uci, childKey: edge.childKey, san: edge.san });
      visited.add(edge.childKey);
      key = edge.childKey;
      state = next;
    }
    return path;
  }

  function studyLineVariantCount(rep, catalog) {
    const variants = new Set();
    for (const target of catalog) variants.add(completeStudyPath(rep, target).map(step => step.uci).join(" "));
    return variants.size;
  }

  function traceStudyPath(rootKey, rootState, path) {
    const keys = [rootKey];
    const states = [rootState];
    let key = rootKey;
    let state = rootState;
    for (const step of path) {
      if (step.parentKey !== key) return null;
      const next = applyUci(state, step.uci);
      if (!next || stateKey(next) !== step.childKey) return null;
      key = step.childKey;
      state = next;
      keys.push(key);
      states.push(state);
    }
    return { keys, states };
  }

  function masteredThroughPathIndex(rep, trace, endIndex) {
    for (let index = 0; index < endIndex; index++) {
      const key = trace.keys[index];
      const state = trace.states[index];
      if (moveOwner(rep, state.turn) !== "repertoire" || !sortedEdges(rep, key).length) continue;
      if (!studyPositionMastered(existingStudyPositionStat(rep, key))) return false;
    }
    return true;
  }

  function chooseLessonStart(rep, fullPath, targetIndex, forceScopeRoot = false) {
    const trace = traceStudyPath(study.scopeRootKey, study.scopeRootState, fullPath);
    const base = {
      index: 0,
      key: study.scopeRootKey,
      state: study.scopeRootState,
      chapter: null,
      label: study.scopeLabel,
      setupPath: study.scopeRootSetupPath.slice()
    };
    if (!trace || forceScopeRoot) return base;

    const indexByKey = new Map(trace.keys.map((key, index) => [key, index]));
    const chapters = availableChapters(rep);
    const candidatesByRoot = new Map();
    for (const chapter of chapters) {
      const index = indexByKey.get(chapter.rootKey);
      if (!Number.isInteger(index) || index <= 0 || index > targetIndex) continue;
      const existing = candidatesByRoot.get(chapter.rootKey);
      if (!existing || chapter.type === "manual" || chapter.name.length > existing.name.length) candidatesByRoot.set(chapter.rootKey, chapter);
    }
    const candidates = [...candidatesByRoot.values()].sort((a, b) => indexByKey.get(b.rootKey) - indexByKey.get(a.rootKey));
    for (const chapter of candidates) {
      const index = indexByKey.get(chapter.rootKey);
      if (!masteredThroughPathIndex(rep, trace, index)) continue;
      return {
        index,
        key: chapter.rootKey,
        state: trace.states[index],
        chapter,
        label: chapter.name,
        setupPath: [...study.scopeRootSetupPath, ...fullPath.slice(0, index)]
      };
    }
    return base;
  }

  function chooseStudyTarget(rep, excludedKeys = new Set()) {
    const catalog = study.catalog;
    const byKey = study.catalogByKey;
    const available = item => !excludedKeys.has(item.key);

    // New material advances breadth-first. A deep review from an earlier
    // session must not jump ahead of shallower, never-presented branches.
    const unseen = catalog
      .filter(item => available(item) && !study.shownTargets.has(item.key) && !(existingStudyPositionStat(rep, item.key)?.attempts > 0))
      .sort(rootFirstTargetSort);
    const frontierDepth = unseen.length ? studyTargetDepth(unseen[0]) : Infinity;

    const due = study.reviewQueue
      .filter(item => item.dueAt <= study.decisionCount && byKey.has(item.key) && available(byKey.get(item.key)))
      .map(item => ({ queue: item, target: byKey.get(item.key) }))
      .filter(entry => studyTargetDepth(entry.target) <= frontierDepth)
      .sort((a, b) => a.queue.dueAt - b.queue.dueAt || rootFirstTargetSort(a.target, b.target))[0];
    if (due) return { item: due.target, kind: "review" };
    if (unseen.length) return { item: unseen[0], kind: "new" };

    const review = catalog
      .filter(item => available(item) && studyPositionDue(existingStudyPositionStat(rep, item.key)))
      .sort((a, b) => rootFirstTargetSort(a, b) || (existingStudyPositionStat(rep, a.key)?.lastReviewedAt || 0) - (existingStudyPositionStat(rep, b.key)?.lastReviewedAt || 0));
    if (review.length) return { item: review[0], kind: "review" };

    const remaining = catalog
      .filter(item => available(item) && !study.shownTargets.has(item.key))
      .sort(rootFirstTargetSort);
    if (remaining.length) return { item: remaining[0], kind: "practice" };

    const leastRecent = catalog.filter(available).sort((a, b) => {
      const aTime = existingStudyPositionStat(rep, a.key)?.lastReviewedAt || 0;
      const bTime = existingStudyPositionStat(rep, b.key)?.lastReviewedAt || 0;
      if (aTime !== bTime) return aTime - bTime;
      return rootFirstTargetSort(a, b);
    });
    return leastRecent.length ? { item: leastRecent[0], kind: "practice" } : null;
  }

  function clearStudyTimers() {
    if (study.timer) clearTimeout(study.timer);
    if (study.navigationTimer) clearTimeout(study.navigationTimer);
    if (study.autoFailTimer) clearTimeout(study.autoFailTimer);
    if (study.autoCommentTimer) clearTimeout(study.autoCommentTimer);
    study.timer = null;
    study.navigationTimer = null;
    study.autoFailTimer = null;
    study.autoCommentTimer = null;
    study.setupAdvance = null;
  }

  function clearAutoCommentTimer() {
    if (study.autoCommentTimer) clearTimeout(study.autoCommentTimer);
    study.autoCommentTimer = null;
  }

  function autoCommentDelay(comment) {
    const readingDelay = 650 + String(comment || "").length * COMMENT_AUTO_MS_PER_CHAR;
    return Math.max(COMMENT_AUTO_MIN_DELAY, Math.min(COMMENT_AUTO_MAX_DELAY, readingDelay));
  }

  function scheduleAutoCommentAdvance() {
    clearAutoCommentTimer();
    if (!study.active || !uiState.studyAutoContinueComments || !study.comment) return;
    if (study.phase !== "comment" && study.phase !== "feedback") return;
    if (study.alternativeOffer) return;
    const phase = study.phase;
    const comment = study.comment;
    study.autoCommentTimer = setTimeout(() => {
      study.autoCommentTimer = null;
      if (!study.active || !uiState.studyAutoContinueComments) return;
      if (study.phase !== phase || study.comment !== comment) return;
      continueStudy();
    }, autoCommentDelay(comment));
  }

  function startStudy(fromCurrent = false, chapter = null) {
    clearChapterNavigation();
    const rep = active();
    if (!rep) return;
    if (!fullBoardControlAvailable()) {
      alert(realCorrespondenceGameContext()
        ? "Study is disabled on real correspondence game pages. The builder may still observe and record moves; open the position in Analysis to study it safely."
        : "Study mode requires an Analysis, Study, or other non-game analysis board.");
      return;
    }

    const reachable = repertoirePositionMap(rep);
    let scopeRootState = INITIAL;
    let scopeRootKey = rep.rootKey;
    let scopeRootHistoryIndex = 0;
    let scopeRootSetupPath = [];
    let scopeType = "all";
    let scopeLabel = "All chapters";

    if (fromCurrent) {
      scopeRootState = C.parseFen(C.fen(currentState()));
      scopeRootKey = stateKey(scopeRootState);
      if (!rep.positions[scopeRootKey] && scopeRootKey !== rep.rootKey) {
        alert("The current board position is not part of the selected repertoire.");
        return;
      }
      scopeRootHistoryIndex = cursor;
      scopeRootSetupPath = reachable.get(scopeRootKey)?.path || [];
      scopeType = "current";
      scopeLabel = "Current position";
    } else if (chapter) {
      const route = chapter.route || reachable.get(chapter.rootKey);
      if (!route) {
        alert("That chapter position is no longer reachable in the selected repertoire.");
        return;
      }
      scopeRootState = C.parseFen(C.fen(route.state));
      scopeRootKey = chapter.rootKey;
      scopeRootSetupPath = route.path || [];
      const knownIndex = history.findIndex(entry => stateKey(entry.state) === scopeRootKey);
      scopeRootHistoryIndex = knownIndex >= 0 ? knownIndex : scopeRootSetupPath.length;
      scopeType = "chapter";
      scopeLabel = chapter.name;
    }

    const catalog = buildStudyCatalog(rep, scopeRootKey, scopeRootState);
    if (!catalog.length) {
      alert(scopeType === "chapter"
        ? `The chapter “${scopeLabel}” does not contain any decision positions for your side.`
        : fromCurrent
          ? "No study positions for your side follow the current position."
          : "This repertoire does not yet contain any decision positions for your side.");
      return;
    }
    clearStudyTimers();
    study = freshStudyState();
    study.active = true;
    study.scopeRootKey = scopeRootKey;
    study.scopeRootState = scopeRootState;
    study.scopeRootPlacement = C.placement(scopeRootState);
    study.scopeRootHistoryIndex = scopeRootHistoryIndex;
    study.scopeRootSetupPath = scopeRootSetupPath;
    study.rootKey = scopeRootKey;
    study.rootState = scopeRootState;
    study.rootPlacement = C.placement(scopeRootState);
    study.rootHistoryIndex = scopeRootHistoryIndex;
    study.rootSetupPath = scopeRootSetupPath;
    study.scopedFromCurrent = fromCurrent;
    study.scopeType = scopeType;
    study.scopeLabel = scopeLabel;
    study.chapterId = chapter?.id || null;
    study.catalog = catalog;
    study.catalogByKey = new Map(catalog.map(item => [item.key, item]));
    study.lineVariantCount = studyLineVariantCount(rep, catalog);
    uiState.panelTab = "study";
    saveUi();
    const persistent = studyData.repertoires?.[rep.id]?.positions || {};
    for (const [key, stat] of Object.entries(persistent)) {
      if (studyPositionDue(stat) && study.catalogByKey.has(key)) study.reviewQueue.push({ key, dueAt: 0 });
    }
    beginNextStudyLine();
  }

  function startStudyFromCurrent() {
    startStudy(true);
  }

  function startSelectedChapterStudy() {
    const rep = active();
    if (!rep) return;
    const chapters = availableChapters(rep);
    const chapter = selectedChapter(rep, chapters);
    startStudy(false, chapter);
  }

  function exitStudy() {
    clearStudyTimers();
    study = freshStudyState();
    render();
  }

  function matchingHistoryIndex(key) {
    let best = -1;
    let distance = Infinity;
    for (let index = 0; index < history.length; index++) {
      if (stateKey(history[index].state) !== key) continue;
      const nextDistance = Math.abs(cursor - index);
      if (nextDistance < distance) {
        best = index;
        distance = nextDistance;
      }
    }
    return best;
  }

  function navigateToHistoryIndex(targetIndex, targetKey, callback) {
    let attempts = 0;
    const tick = () => {
      if (!study.active) return;
      if (cursor === targetIndex && stateKey(currentState()) === targetKey) {
        callback(true);
        return;
      }
      if (attempts++ >= 90) {
        callback(false);
        return;
      }
      const arrowKey = cursor > targetIndex ? "ArrowLeft" : "ArrowRight";
      const preferBeginning = arrowKey === "ArrowLeft" && targetIndex === 0;
      const clicked = clickNavigationControl(arrowKey, preferBeginning && attempts === 1);
      if (!clicked) dispatchArrow(arrowKey);
      study.navigationTimer = setTimeout(tick, 90);
    };
    tick();
  }

  function playStudySetupPath(path, callback) {
    let index = 0;
    const fail = () => {
      study.setupAdvance = null;
      study.expectedAuto = null;
      if (study.autoFailTimer) clearTimeout(study.autoFailTimer);
      study.autoFailTimer = null;
      callback(false);
    };
    const advance = () => {
      if (!study.active) return;
      if (index >= path.length) {
        study.setupAdvance = null;
        study.rootHistoryIndex = cursor;
        callback(stateKey(currentState()) === study.rootKey);
        return;
      }
      const step = path[index++];
      if (stateKey(currentState()) !== step.parentKey) {
        fail();
        return;
      }
      study.setupAdvance = advance;
      study.expectedAuto = { fromKey: step.parentKey, uci: step.uci, setup: true };
      if (!playMove(step.uci)) {
        fail();
        return;
      }
      study.autoFailTimer = setTimeout(() => {
        if (!study.active || !study.expectedAuto?.setup) return;
        fail();
      }, 1800);
    };
    advance();
  }

  function navigateToStudyRoot(callback) {
    clearTimeout(study.navigationTimer);
    study.navigationLock = true;
    const knownIndex = matchingHistoryIndex(study.rootKey);
    if (knownIndex >= 0) {
      study.rootHistoryIndex = knownIndex;
      navigateToHistoryIndex(knownIndex, study.rootKey, callback);
      return;
    }
    if (!study.rootSetupPath?.length) {
      callback(false);
      return;
    }
    navigateToPlacement(INITIAL_PLACEMENT, "ArrowLeft", 90, success => {
      if (!study.active || !success) {
        callback(false);
        return;
      }
      playStudySetupPath(study.rootSetupPath, callback);
    });
  }

  function beginNextStudyLine(reuseTarget = false, forceScopeRoot = false) {
    const rep = active();
    if (!rep || !study.active) return;
    clearStudyTimers();
    let chosen = null;
    if (reuseTarget && study.targetKey && study.catalogByKey.has(study.targetKey)) {
      chosen = { item: study.catalogByKey.get(study.targetKey), kind: study.targetKind };
    } else {
      const previousLineKeys = new Set(study.lineVisited);
      if (study.targetKey) previousLineKeys.add(study.targetKey);
      for (const key of study.targetPositionIndex.keys()) previousLineKeys.add(key);
      chosen = chooseStudyTarget(rep, previousLineKeys);
      if (!chosen && previousLineKeys.size) chosen = chooseStudyTarget(rep);
    }
    if (!chosen) {
      study.phase = "complete";
      study.message = "No study positions are available.";
      render();
      return;
    }

    const fullPath = reuseTarget && study.scopeLinePath.length
      ? study.scopeLinePath.slice()
      : completeStudyPath(rep, chosen.item);
    const targetIndex = chosen.item.path.length;
    let lessonStart;
    if (reuseTarget && !forceScopeRoot && Number.isInteger(study.rootIndexInScope)) {
      const trace = traceStudyPath(study.scopeRootKey, study.scopeRootState, fullPath);
      const index = Math.max(0, Math.min(study.rootIndexInScope, targetIndex));
      lessonStart = {
        index,
        key: trace?.keys[index] || study.scopeRootKey,
        state: trace?.states[index] || study.scopeRootState,
        chapter: study.lineStartChapterId ? availableChapters(rep).find(item => item.id === study.lineStartChapterId) || null : null,
        label: study.lineStartLabel || study.scopeLabel,
        setupPath: [...study.scopeRootSetupPath, ...fullPath.slice(0, index)]
      };
    } else {
      lessonStart = chooseLessonStart(rep, fullPath, targetIndex, forceScopeRoot);
    }

    const linePath = fullPath.slice(lessonStart.index);
    study.targetKey = chosen.item.key;
    study.targetKind = chosen.kind;
    study.scopeLinePath = fullPath;
    study.linePath = linePath;
    study.rootIndexInScope = lessonStart.index;
    study.rootKey = lessonStart.key;
    study.rootState = lessonStart.state;
    study.rootPlacement = C.placement(lessonStart.state);
    study.rootSetupPath = lessonStart.setupPath;
    study.rootHistoryIndex = matchingHistoryIndex(lessonStart.key);
    study.lineStartChapterId = lessonStart.chapter?.id || null;
    study.lineStartLabel = lessonStart.label || study.scopeLabel;
    study.targetPath = linePath.slice(0, Math.max(0, targetIndex - lessonStart.index));
    study.targetNext = new Map(linePath.map(step => [step.parentKey, step.uci]));
    study.targetPositionIndex = new Map([[study.rootKey, 0], ...linePath.map((step, index) => [step.childKey, index + 1])]);
    study.onTargetRoute = true;
    study.reachedTarget = false;
    study.lineVisited = new Set([study.rootKey]);
    study.commentsShown = new Set();
    study.wrong = null;
    study.correction = null;
    study.answerShown = false;
    study.showAnswerLine = false;
    study.alternativeOffer = null;
    study.optionalLine = null;
    study.preferredPractice = null;
    study.phase = "resetting";
    const startLabel = lessonStart.index > 0 ? lessonStart.label : study.scopeLabel;
    study.message = chosen.kind === "review"
      ? `Returning to ${startLabel} for full-line review…`
      : `Returning to ${startLabel}…`;
    study.comment = "";
    render();
    navigateToStudyRoot(success => {
      if (!study.active) return;
      study.navigationLock = false;
      if (!success) {
        study.phase = "navigated";
        study.message = `Could not return the ${SITE_LABEL} board to ${startLabel} automatically. Navigate there, then choose Resume from here.`;
        render();
        return;
      }
      study.lineStartHistoryIndex = cursor;
      advanceStudyFromCurrent();
    });
  }


  function navigationControlLabel(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-tooltip"),
      element.getAttribute?.("data-cy"),
      element.textContent
    ].filter(Boolean).join(" ").trim().toLowerCase();
  }

  function requestLichessNavigation(action) {
    if (!lichessAnalysisCapable()) return false;
    const root = document.documentElement;
    root.dataset.crbLichessNav = action;
    root.dispatchEvent(new Event("crb-lichess-navigate"));
    return true;
  }

  function clickNavigationControl(arrowKey, preferBeginning = false) {
    if (SITE === "lichess" && requestLichessNavigation(preferBeginning ? "first" : arrowKey === "ArrowLeft" ? "prev" : "next")) return true;
    const candidates = [...document.querySelectorAll("button,[role='button'],[aria-label],[title],[data-tooltip],[data-cy]")]
      .filter(element => !element.closest?.(`#${ROOT}`) && !element.disabled && element.getAttribute?.("aria-disabled") !== "true");
    const patterns = arrowKey === "ArrowLeft"
      ? (preferBeginning
          ? [/first move/, /go to (the )?(start|beginning)/, /start position/, /beginning/]
          : [/previous move/, /back one move/, /go back/, /^previous$/])
      : [/next move/, /forward one move/, /go forward/, /^next$/];
    for (const pattern of patterns) {
      const match = candidates.find(element => pattern.test(navigationControlLabel(element)));
      if (match) {
        match.click();
        return true;
      }
    }
    return false;
  }

  function dispatchArrow(key) {
    const target = findBoard() || document.body || document.documentElement;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
  }

  function navigateToPlacement(targetPlacement, arrowKey, maxAttempts, callback) {
    clearTimeout(study.navigationTimer);
    study.navigationLock = true;
    let attempts = 0;
    const tick = () => {
      if (!study.active) return;
      const placement = readPlacement();
      if (placement === targetPlacement) {
        acceptPlacement(placement);
        callback(true);
        return;
      }
      if (attempts++ >= maxAttempts) {
        callback(false);
        return;
      }
      const preferBeginning = arrowKey === "ArrowLeft" && targetPlacement === INITIAL_PLACEMENT;
      const clicked = clickNavigationControl(arrowKey, preferBeginning && attempts === 1);
      if (!clicked) dispatchArrow(arrowKey);
      study.navigationTimer = setTimeout(tick, 90);
    };
    tick();
  }

  function studyPositionPrompt(rep, key) {
    const moves = sortedEdges(rep, key);
    const count = moves.length;
    if (count <= 1) return "Play your repertoire move.";
    return `Play one of your ${count} included moves.`;
  }

  function chooseOpponentStudyEdge(rep, key) {
    const edges = sortedEdges(rep, key);
    if (!edges.length) return null;
    if (study.onTargetRoute) {
      const forcedUci = study.targetNext.get(key);
      const forced = forcedUci ? edges.find(edge => edge.uci === forcedUci) : null;
      if (forced) return forced;
    }
    return edges.slice().sort((a, b) => {
      const aStat = opponentEdgeStat(rep, key, a.uci);
      const bStat = opponentEdgeStat(rep, key, b.uci);
      if (aStat.seen !== bStat.seen) return aStat.seen - bStat.seen;
      const marked = (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
      if (marked) return marked;
      const depth = edgePlyCount(rep, b) - edgePlyCount(rep, a);
      if (depth) return depth;
      return (a.createdAt || 0) - (b.createdAt || 0);
    })[0];
  }

  function queueOpponentStudyMove(edge, key, correction = false, delay = OPPONENT_PLAY_DELAY) {
    if (!edge) {
      finishStudyLine("Line complete.");
      return;
    }
    study.timer = setTimeout(() => {
      if (!study.active || stateKey(currentState()) !== key) return;
      study.expectedAuto = { fromKey: key, uci: edge.uci, correction };
      if (!playMove(edge.uci)) {
        study.expectedAuto = null;
        study.phase = "navigated";
        study.message = `The opponent move could not be played on the ${SITE_LABEL} board. Resume from the current position or restart the line.`;
        render();
        return;
      }
      study.autoFailTimer = setTimeout(() => {
        if (!study.active || !study.expectedAuto) return;
        study.expectedAuto = null;
        study.phase = "navigated";
        study.message = `${SITE_LABEL} did not accept the automatic opponent move. Resume from the current position or restart the line.`;
        render();
      }, 1600);
    }, delay);
  }

  function maybePauseForPositionComment(rep, key) {
    const comment = rep.positions[key]?.comment?.trim();
    if (!comment || study.commentsShown.has(`p:${key}`)) return false;
    study.commentsShown.add(`p:${key}`);
    study.phase = "comment";
    study.message = "Position note";
    study.comment = comment;
    study.pendingAction = "advance";
    render();
    scheduleAutoCommentAdvance();
    return true;
  }

  function advanceStudyFromCurrent() {
    const rep = active();
    if (!rep || !study.active) return;
    clearTimeout(study.timer);
    study.timer = null;
    const state = currentState();
    const key = stateKey(state);
    study.expectedAuto = null;
    study.expectedAssisted = null;
    study.comment = "";
    study.pendingAction = null;
    study.lineVisited.add(key);
    if (key === study.targetKey) {
      study.reachedTarget = true;
      study.shownTargets.add(key);
    }
    const edges = sortedEdges(rep, key);
    if (!edges.length) {
      finishStudyLine("Line complete.");
      return;
    }

    const correction = study.correction?.active ? study.correction : null;
    if (correction && key === correction.failureKey) {
      study.phase = "awaiting-correction";
      study.message = "Retry the missed move.";
      render();
      return;
    }

    if (!correction && maybePauseForPositionComment(rep, key)) return;
    if (moveOwner(rep, state.turn) === "repertoire") {
      if (correction) {
        study.phase = "awaiting-context";
        study.message = "Replay the contextual move.";
      } else {
        study.phase = study.preferredPractice?.key === key ? "awaiting-preferred" : "awaiting-user";
        study.message = study.preferredPractice?.key === key
          ? `Play the preferred move: ${study.preferredPractice.san}`
          : studyPositionPrompt(rep, key);
      }
      render();
      return;
    }
    const forcedCorrectionUci = correction?.replayNext.get(key);
    const edge = forcedCorrectionUci
      ? edges.find(candidate => candidate.uci === forcedCorrectionUci) || null
      : chooseOpponentStudyEdge(rep, key);
    if (!edge) {
      finishStudyLine("Line complete.");
      return;
    }
    study.phase = "opponent";
    study.message = correction
      ? "Replaying the opponent move that restores the missed context…"
      : edge.preferred ? "Playing the opponent’s mainline response…" : "Playing an opponent sideline…";
    render();
    queueOpponentStudyMove(edge, key, !!correction);
  }

  function finishStudyLine(message) {
    clearStudyTimers();
    const rep = active();
    const masteredOptionalLine = rep && study.optionalLine && optionalLineMastered(rep, study.optionalLine);
    study.phase = masteredOptionalLine ? "optional-mastered" : "complete";
    study.message = masteredOptionalLine
      ? "You have mastered this optional line. Would you like to learn another line?"
      : message;
    study.comment = "";
    if (study.lineVariantCount > 1 || study.lineCount === 0) study.lineCount++;
    render();
  }

  function optionalLineMastered(rep, optional) {
    if (!optional?.parentState || !optional?.chosen?.childKey) return false;
    const keys = [optional.parentKey];
    let key = optional.chosen.childKey;
    let state = applyUci(optional.parentState, optional.chosen.uci);
    const visited = new Set([optional.parentKey]);
    for (let guard = 0; guard < 120 && state && !visited.has(key); guard++) {
      visited.add(key);
      if (moveOwner(rep, state.turn) === "repertoire" && sortedEdges(rep, key).length) keys.push(key);
      const edge = chooseIntendedLineEdge(rep, key, state);
      if (!edge) break;
      state = applyUci(state, edge.uci);
      key = edge.childKey;
    }
    return keys.length > 0 && keys.every(key => studyPositionMastered(existingStudyPositionStat(rep, key)));
  }

  function updateTargetAlignment(parentKey, uci) {
    if (!study.onTargetRoute) return;
    const expected = study.targetNext.get(parentKey);
    if (expected && expected !== uci) study.onTargetRoute = false;
  }

  function presentUserAcceptedFeedback(rep, parentState, parentKey, edge, comment) {
    const preferred = Object.values(rep.positions[parentKey]?.moves || {}).find(candidate => candidate.preferred) || null;
    study.comment = comment || "";
    if (preferred && preferred.uci !== edge.uci) {
      study.phase = "alternative-offer";
      study.message = `Correct — accepted alternative. The preferred move is ${preferred.san}.`;
      study.alternativeOffer = {
        parentKey,
        parentPlacement: C.placement(parentState),
        parentState,
        preferred,
        chosen: edge,
        preview: principalPreview(rep, preferred, parentState)
      };
      render();
      return;
    } else if (preferred) {
      study.phase = "feedback";
      study.message = "Correct — preferred move.";
    } else {
      study.phase = "feedback";
      study.message = "Correct.";
    }
    render();
    if (comment) scheduleAutoCommentAdvance();
    else study.timer = setTimeout(advanceStudyFromCurrent, STUDY_ADVANCE_DELAY);
  }

  function afterAcceptedStudyMove(rep, parentState, parentKey, edge, source) {
    const childKey = edge.childKey;
    if (!source.startsWith("correction")) updateTargetAlignment(parentKey, edge.uci);
    study.lineVisited.add(parentKey);
    if (study.lineVisited.has(childKey)) {
      finishStudyLine("The line reached a repeated position.");
      return;
    }
    study.lineVisited.add(childKey);
    study.lastIncomingEdge = edge;

    if (source === "auto") markOpponentEdgeSeen(rep, parentKey, edge);

    if (source === "correction-user" || source === "correction-auto") {
      study.timer = setTimeout(advanceStudyFromCurrent, 90);
      return;
    }

    if (source === "correction-final") {
      study.phase = "feedback";
      study.message = "Corrected. Continuing the line…";
      study.comment = "";
      render();
      study.timer = setTimeout(advanceStudyFromCurrent, STUDY_ADVANCE_DELAY);
      return;
    }

    const comment = edge.comment?.trim() || "";
    if (comment) study.commentsShown.add(`e:${parentKey}|${edge.uci}`);

    if (source === "user") {
      presentUserAcceptedFeedback(rep, parentState, parentKey, edge, comment);
      return;
    }

    if (comment) {
      study.phase = "comment";
      study.message = `Comment after ${edge.san}`;
      study.comment = comment;
      study.pendingAction = "advance";
      render();
      scheduleAutoCommentAdvance();
      return;
    }

    study.timer = setTimeout(advanceStudyFromCurrent, STUDY_ADVANCE_DELAY);
  }

  function correctionContextFromHistory(parentIndex, failureKey, answer) {
    const earliest = Math.max(0, Math.min(study.lineStartHistoryIndex || 0, parentIndex));
    const rewindPlies = CORRECTION_CONTEXT_PLIES + CORRECTION_TRIGGER_PLIES;
    const startIndex = Math.max(earliest, parentIndex - rewindPlies);
    const replaySteps = [];
    for (let index = startIndex + 1; index <= parentIndex; index++) {
      const parent = history[index - 1];
      const child = history[index];
      if (!parent || !child?.move) continue;
      replaySteps.push({
        parentKey: stateKey(parent.state),
        childKey: stateKey(child.state),
        uci: child.move.uci,
        san: child.move.san
      });
    }
    return {
      active: false,
      pending: true,
      startIndex,
      startKey: stateKey(history[startIndex].state),
      startPlacement: history[startIndex].placement,
      failureKey,
      answerUci: answer?.uci || "",
      replaySteps,
      replayNext: new Map(replaySteps.map(step => [step.parentKey, step.uci]))
    };
  }

  function handleStudyWrong(rep, parentState, parentKey, move, answerOverride = null, correctionMismatch = false) {
    if (!correctionMismatch) recordStudyWrong(rep, parentKey);
    const edges = sortedEdges(rep, parentKey);
    const answer = answerOverride || edges.find(edge => edge.preferred) || edges[0] || null;
    if (!study.correction) study.correction = correctionContextFromHistory(Math.max(0, cursor - 1), parentKey, answer);
    else {
      study.correction.active = false;
      study.correction.pending = true;
    }
    study.wrong = { key: parentKey, placement: C.placement(parentState), state: parentState, attemptedSan: move.san, answer };
    study.phase = "rewinding";
    study.message = correctionMismatch
      ? `${move.san} leaves the contextual replay. Returning to that decision…`
      : `${move.san} is not included in this repertoire. Returning to the decision position…`;
    study.comment = "";
    render();
    navigateToPlacement(study.wrong.placement, "ArrowLeft", 12, success => {
      if (!study.active) return;
      study.navigationLock = false;
      study.phase = "wrong";
      study.message = correctionMismatch
        ? "That move is valid elsewhere, but this correction replay needs the original continuation. Retry the context."
        : success
          ? "That move is not included. Retry with up to four contextual plies, followed by the opponent move that recreated this position."
          : "That move is not included. Return to the decision position, then retry with context.";
      render();
    });
  }

  function handleStudyForwardMove(parentState, move, childState, source) {
    clearTimeout(study.timer);
    study.timer = null;
    const rep = active();
    if (!rep || !study.active || study.phase === "complete") return;
    if (study.autoFailTimer) {
      clearTimeout(study.autoFailTimer);
      study.autoFailTimer = null;
    }
    const parentKey = stateKey(parentState);
    const edge = rep.positions[parentKey]?.moves?.[move.uci] || null;
    const ownMove = moveOwner(rep, parentState.turn) === "repertoire";

    if (ownMove && !sortedEdges(rep, parentKey).length) {
      finishStudyLine(`${move.san} was played beyond the stored repertoire. Line complete; the move was not graded.`);
      return;
    }

    if (source === "setup") {
      study.expectedAuto = null;
      if (study.autoFailTimer) clearTimeout(study.autoFailTimer);
      study.autoFailTimer = null;
      if (!edge) {
        study.setupAdvance = null;
        study.phase = "navigated";
        study.message = "A chapter setup move no longer exists in the selected repertoire.";
        render();
        return;
      }
      const advanceSetup = study.setupAdvance;
      if (advanceSetup) study.timer = setTimeout(advanceSetup, 70);
      return;
    }

    if (source === "auto" || source === "correction-auto") {
      study.expectedAuto = null;
      if (!edge) {
        study.phase = "navigated";
        study.message = "The automatic move no longer exists in the selected repertoire. Restart the line.";
        render();
        return;
      }
      afterAcceptedStudyMove(rep, parentState, parentKey, edge, source);
      return;
    }

    if (source === "assisted") {
      study.expectedAssisted = null;
      if (!edge) return;
      afterAcceptedStudyMove(rep, parentState, parentKey, edge, "assisted");
      return;
    }

    if (!ownMove) {
      clearStudyTimers();
      study.phase = "navigated";
      study.message = "You manually advanced an opponent move. This was treated as board navigation and did not affect your score.";
      study.comment = edge?.comment || "";
      render();
      return;
    }

    const correction = study.correction?.active ? study.correction : null;
    if (correction) {
      const expectedUci = correction.replayNext.get(parentKey);
      const atFailure = parentKey === correction.failureKey;
      const expectedEdge = expectedUci ? sortedEdges(rep, parentKey).find(candidate => candidate.uci === expectedUci) || null : null;
      if (!edge || (!atFailure && expectedUci && edge.uci !== expectedUci)) {
        handleStudyWrong(rep, parentState, parentKey, move, expectedEdge, !!edge);
        return;
      }
      if (!atFailure) {
        afterAcceptedStudyMove(rep, parentState, parentKey, edge, "correction-user");
        return;
      }
      study.decisionCount++;
      recordStudyCorrect(rep, parentKey);
      study.correction = null;
      study.wrong = null;
      afterAcceptedStudyMove(rep, parentState, parentKey, edge, "correction-final");
      return;
    }

    if (!edge) {
      handleStudyWrong(rep, parentState, parentKey, move);
      return;
    }

    study.decisionCount++;
    recordStudyCorrect(rep, parentKey);
    if (study.preferredPractice?.key === parentKey) study.preferredPractice = null;
    afterAcceptedStudyMove(rep, parentState, parentKey, edge, "user");
  }

  function sourceForStudyTransition(parentState, move) {
    const parentKey = stateKey(parentState);
    if (study.expectedAuto?.fromKey === parentKey && study.expectedAuto.uci === move.uci) {
      if (study.expectedAuto.setup) return "setup";
      return study.expectedAuto.correction ? "correction-auto" : "auto";
    }
    if (study.expectedAssisted?.fromKey === parentKey && study.expectedAssisted.uci === move.uci) return "assisted";
    return "user";
  }

  function processStudyForwardRange(startIndex, endIndex) {
    if (!study.active) return;
    for (let index = startIndex; index <= endIndex; index++) {
      const parent = history[index - 1];
      const child = history[index];
      if (!parent || !child?.move) continue;
      const source = sourceForStudyTransition(parent.state, child.move);
      handleStudyForwardMove(parent.state, child.move, child.state, source);
      if (["wrong", "rewinding", "navigated", "complete"].includes(study.phase)) break;
    }
  }

  function handleStudyNavigation(oldCursor, newCursor) {
    if (!study.active || oldCursor === newCursor) return;
    if (study.navigationLock) return;
    clearStudyTimers();
    study.expectedAuto = null;
    study.expectedAssisted = null;
    const rep = active();
    const key = stateKey(currentState());
    const known = !!rep?.positions[key] || key === rep?.rootKey;
    study.phase = "navigated";
    study.message = known
      ? "Board navigation detected. No answer was graded. Resume from this position, restart the line, or simply play a repertoire move if it is your turn."
      : "Board navigation detected outside the stored repertoire. Return to a known repertoire position or restart the line.";
    study.comment = rep?.positions[key]?.comment || "";
    render();
  }

  function retryStudyAnswer() {
    if (!study.active || !study.wrong) return;
    const correction = study.correction;
    if (!correction) {
      study.phase = "awaiting-user";
      study.message = "Try again.";
      render();
      return;
    }
    const beginReplay = success => {
      if (!study.active) return;
      study.navigationLock = false;
      if (!success) {
        study.phase = "navigated";
        study.message = "Return to the contextual starting position, then resume.";
        render();
        return;
      }
      correction.startIndex = cursor;
      correction.active = true;
      correction.pending = false;
      study.answerShown = false;
      study.showAnswerLine = false;
      study.lineVisited = new Set([stateKey(currentState())]);
      study.phase = "context-replay";
      study.message = correction.replaySteps.length
        ? "Replaying the preceding context before the missed decision…"
        : "Retry the missed move.";
      render();
      advanceStudyFromCurrent();
    };
    const exactIndex = correction.startIndex < history.length && stateKey(history[correction.startIndex].state) === correction.startKey
      ? correction.startIndex
      : matchingHistoryIndex(correction.startKey);
    if (exactIndex >= 0) {
      study.navigationLock = true;
      navigateToHistoryIndex(exactIndex, correction.startKey, beginReplay);
    }
    else navigateToPlacement(correction.startPlacement, "ArrowLeft", 20, beginReplay);
  }


  function revealStudyAnswer() {
    const rep = active();
    if (!rep || !study.wrong) return;
    recordAnswerReveal(rep, study.wrong.key);
    study.answerShown = true;
    study.phase = "answer";
    study.message = "Answer revealed. This position will return sooner.";
    render();
  }

  function playRevealedAnswer() {
    const rep = active();
    const answer = study.wrong?.answer;
    if (!rep || !answer) return;
    const key = stateKey(currentState());
    if (key !== study.wrong.key) {
      retryStudyAnswer();
      return;
    }
    study.correction = null;
    study.expectedAssisted = { fromKey: key, uci: answer.uci };
    if (!playMove(answer.uci)) {
      study.expectedAssisted = null;
      study.phase = "navigated";
      study.message = "Could not play the revealed move automatically. Enter it on the board or retry.";
      render();
    }
  }

  function studyPreferredLine() {
    const offer = study.alternativeOffer;
    if (!offer) return;
    study.phase = "resetting";
    study.message = "Returning to the decision position for the preferred continuation…";
    render();
    navigateToPlacement(offer.parentPlacement, "ArrowLeft", 12, success => {
      if (!study.active) return;
      study.navigationLock = false;
      if (!success) {
        study.phase = "navigated";
        study.message = "Use the left arrow to return to the decision position, then resume.";
        render();
        return;
      }
      study.lineVisited = new Set();
      for (let index = 0; index <= cursor; index++) study.lineVisited.add(stateKey(history[index].state));
      study.preferredPractice = { key: offer.parentKey, uci: offer.preferred.uci, san: offer.preferred.san };
      study.targetNext.set(offer.parentKey, offer.preferred.uci);
      study.onTargetRoute = true;
      study.alternativeOffer = null;
      study.optionalLine = null;
      advanceStudyFromCurrent();
    });
  }

  function continueStudy() {
    if (!study.active) return;
    clearStudyTimers();
    study.comment = "";
    study.pendingAction = null;
    if (study.alternativeOffer) {
      study.optionalLine = {
        parentKey: study.alternativeOffer.parentKey,
        parentState: study.alternativeOffer.parentState,
        chosen: study.alternativeOffer.chosen
      };
    }
    study.alternativeOffer = null;
    advanceStudyFromCurrent();
  }

  function skipCurrentStudyLine() {
    if (!study.active) return;
    if (study.phase !== "complete" && study.lineVariantCount > 1) study.lineCount++;
    beginNextStudyLine();
  }

  function resumeStudyFromHere() {
    const rep = active();
    if (!rep || !study.active) return;
    const key = stateKey(currentState());
    if (!rep.positions[key] && key !== rep.rootKey) {
      study.message = "This position is not part of the selected repertoire. Restart the line or navigate to a stored position.";
      render();
      return;
    }
    study.navigationLock = false;
    study.onTargetRoute = false;
    study.correction = null;
    study.lineStartHistoryIndex = cursor;
    study.lineVisited = new Set();
    for (let index = 0; index <= cursor; index++) study.lineVisited.add(stateKey(history[index].state));
    advanceStudyFromCurrent();
  }

  function renderStudyPanel(rep) {
    const key = stateKey(currentState());
    const stat = existingStudyPositionStat(rep, key);
    const mastery = studyScopeMastery(rep);
    const modeLabel = "Full-line";
    const kindLabel = study.targetKind === "review"
      ? "review"
      : study.targetKind === "new" ? "new line" : "practice line";
    const scopeSuffix = study.scopeType === "chapter" ? ` · ${study.scopeLabel}` : study.scopeType === "current" ? " · current-position scope" : " · all chapters";
    const startSuffix = study.lineStartLabel && study.lineStartLabel !== study.scopeLabel ? ` · starts at ${study.lineStartLabel}` : "";
    const targetLabel = `${modeLabel} ${kindLabel}${scopeSuffix}${startSuffix}`;
    const positionComment = rep.positions[key]?.comment?.trim();
    let controls = "";
    let extra = "";

    if (study.phase === "wrong") {
      controls = `<button data-study-action="retry">Retry with context</button><button data-study-action="show-answer">Show answer</button>`;
    } else if (study.phase === "answer") {
      const moves = sortedEdges(rep, study.wrong?.key || key);
      const answer = study.wrong?.answer;
      const others = moves.filter(edge => edge.uci !== answer?.uci);
      extra = `<div class="crb-study-answer"><b>${answer?.preferred ? "Preferred move" : "Expected move"}: ${esc(answer?.san || "—")}</b>${others.length ? `<div>Other accepted moves: ${others.map(edge => esc(edge.san)).join(", ")}</div>` : ""}${study.showAnswerLine && answer ? `<div class="crb-study-line-preview">${esc(principalPreview(rep, answer, study.wrong?.state || currentState()))}</div>` : ""}</div>`;
      controls = `<button data-study-action="play-answer">Play answer</button><button data-study-action="toggle-answer-line">${study.showAnswerLine ? "Hide continuation" : "Show continuation"}</button><button data-study-action="retry">Retry with context</button>`;
    } else if (study.phase === "alternative-offer") {
      const offer = study.alternativeOffer;
      extra = `<div class="crb-study-answer"><div class="crb-study-label">Preferred continuation</div><div class="crb-study-line-preview">${esc(offer?.preview || "")}</div></div>`;
      controls = `<button data-study-action="study-preferred">Study preferred line</button><button data-study-action="continue">Continue current line</button>`;
    } else if (study.phase === "comment") {
      controls = `<button data-study-action="continue">Continue</button>`;
    } else if (study.phase === "feedback") {
      controls = `<button data-study-action="continue">Continue</button>`;
    } else if (study.phase === "optional-mastered") {
      controls = `<button data-study-action="another-line">Yes, learn another line</button><button data-study-action="dismiss-optional">No</button>`;
    } else if (study.phase === "complete") {
      const fullLabel = study.scopeType === "all" ? "From beginning" : "From study start";
      controls = `<button data-study-action="next-line">Next line</button><button data-study-action="restart">Repeat line</button><button data-study-action="restart-full">${fullLabel}</button><button data-study-action="exit">Exit study</button>`;
    } else if (study.phase === "navigated") {
      const fullLabel = study.scopeType === "all" ? "From beginning" : "From study start";
      controls = `<button data-study-action="resume">Resume from here</button><button data-study-action="restart">Restart line</button><button data-study-action="restart-full">${fullLabel}</button>`;
    }

    if (study.phase !== "complete" && study.phase !== "optional-mastered") {
      controls += `<button class="crb-study-skip" data-study-action="skip-line">${study.lineVariantCount <= 1 ? "Repeat line" : "Skip to next line"}</button>`;
    }

    const comment = study.comment || ((study.phase === "awaiting-user" || study.phase === "awaiting-preferred") ? positionComment : "");
    const autoContinueChecked = uiState.studyAutoContinueComments ? "checked" : "";
    const autoContinueHint = uiState.studyAutoContinueComments && comment && (study.phase === "comment" || study.phase === "feedback")
      ? `<span>Advancing automatically…</span>`
      : "";
    const masteryHtml = `<div class="crb-mastery"><div class="crb-mastery-head"><span>Position mastery · ${mastery.label}</span><span>${mastery.percent}%</span></div><div class="crb-mastery-track" role="progressbar" aria-label="Position mastery" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${mastery.percent}"><span style="width:${mastery.percent}%"></span></div><div class="crb-mastery-note">${mastery.established} of ${mastery.total} decision positions established</div></div>`;
    const lineFinished = study.phase === "complete" || study.phase === "optional-mastered";
    const lineMeta = study.lineVariantCount <= 1 ? "Single-line study" : `Line ${lineFinished ? Math.max(1, study.lineCount) : study.lineCount + 1} of ${study.lineVariantCount}`;
    return `<section class="crb-study"><div class="crb-study-top"><div><div class="crb-title">Study mode</div><b>${targetLabel}</b></div><div class="crb-study-score">${study.correctCount} correct · ${study.mistakeCount} missed</div></div>${masteryHtml}<label class="crb-study-option"><input class="crb-auto-continue-comments" type="checkbox" ${autoContinueChecked}><span>Auto-continue comments</span>${autoContinueHint}</label><div class="crb-study-message ${study.phase === "wrong" ? "wrong" : study.phase === "feedback" ? "correct" : ""}">${esc(study.message || "Preparing study line…")}</div>${studyPositionDue(stat) ? `<div class="crb-review-badge">Needs review</div>` : ""}${comment ? `<div class="crb-study-comment">${esc(comment)}</div>` : ""}${extra}${controls ? `<div class="crb-study-controls">${controls}</div>` : ""}<div class="crb-study-meta">${lineMeta} · ${study.decisionCount} decisions</div></section>`;
  }

  function renderPositionMoves(rep, pos, state) {
    const key = stateKey(state);
    const moves = sortedEdges(rep, key);
    const needsReview = studyPositionDue(existingStudyPositionStat(rep, key));
    if (!moves.length) return `<section><div class="crb-continuation-head"><div class="crb-title">Included continuations</div>${needsReview ? `<span class="crb-review-badge">Needs review</span>` : ""}</div><div class="crb-empty">No continuations included from this position.</div></section>`;
    return `<section><div class="crb-continuation-head"><div class="crb-title">Included continuations</div>${needsReview ? `<span class="crb-review-badge">Needs review</span>` : ""}</div>${moves.map(edge => renderLineCard(rep, key, edge, state)).join("")}</section>`;
  }

  function queryExplorer(state, rating) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "crb-explorer-query", fen: C.fen(state), rating }, response => {
          if (chrome.runtime.lastError) resolve({ available: false, moves: [], total: 0, error: chrome.runtime.lastError.message });
          else if (!response?.ok) resolve({ available: false, moves: [], total: 0, error: response?.error || "Opening Explorer request failed." });
          else resolve(response.result || { available: false, moves: [], total: 0 });
        });
      } catch (error) { resolve({ available: false, moves: [], total: 0, error: error?.message || "Opening Explorer request failed." }); }
    });
  }

  function authMessage(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, response => resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "Extension messaging failed." }));
    });
  }

  async function refreshLichessAuth(renderAfter = true) {
    const response = await authMessage({ type: "crb-lichess-auth-status" });
    lichessAuth = { checked: true, connected: Boolean(response?.ok && response.connected), error: response?.ok ? "" : response?.error || "" };
    if (renderAfter) render();
  }

  async function toggleLichessAuth() {
    const action = lichessAuth.connected ? "crb-lichess-disconnect" : "crb-lichess-connect";
    lichessAuth = { ...lichessAuth, error: "", busy: true };
    render();
    const response = await authMessage({ type: action });
    if (!response?.ok) { lichessAuth = { ...lichessAuth, busy: false, error: response?.error || "Lichess connection failed." }; render(); return; }
    await refreshLichessAuth();
  }

  function weightedChoice(items) {
    const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
    if (!total) return items[Math.floor(Math.random() * items.length)] || null;
    let roll = Math.random() * total;
    for (const item of items) { roll -= Math.max(0, Number(item.weight) || 0); if (roll <= 0) return item; }
    return items[items.length - 1] || null;
  }

  function renderLiveCandidateCard(rep, parentKey, edge, state, selected) {
    const id = `live-${stableLineId(rep, parentKey, edge)}`;
    const open = lineIsOpen(id);
    const preview = principalPreview(rep, edge, state);
    const next = applyUci(state, edge.uci);
    const badge = edge.preferred ? preferredBadge(rep, state) : "";
    return `<div class="crb-line-card ${edge.preferred ? "preferred" : ""} ${selected ? "played" : ""}"><div class="crb-line-row"><details class="crb-line-details" ${lineDetailsAttrs(id)}><summary><span class="crb-chevron">›</span><span class="crb-line-summary"><span class="crb-line-head"><b>${selected ? "✓ " : ""}${edge.preferred ? "★ " : ""}${esc(edge.san)}${nagSymbol(edge.nag)}</b>${badge ? `<small>${badge}</small>` : ""}</span><span class="crb-line-preview" title="${esc(preview)}">${esc(preview)}</span></span></summary>${open ? `<div class="crb-expanded-line">${edge.comment ? `<div class="crb-line-comment">${esc(edge.comment)}</div>` : ""}${next ? renderContinuationTree(rep, edge.childKey, next, new Set([parentKey]), 1) : `<div class="crb-tree-end">End of stored line</div>`}</div>` : ""}</details></div></div>`;
  }

  function renderLivePracticePanel(rep) {
    const feedback = livePractice.lastUserChoices;
    const choices = feedback ? sortedEdges(rep, feedback.parentKey) : [];
    const choiceHtml = choices.length ? `<section class="crb-live-candidates"><div class="crb-continuation-head"><div class="crb-title">Your repertoire candidates</div></div>${choices.map(edge => renderLiveCandidateCard(rep, feedback.parentKey, edge, feedback.parentState, edge.uci === feedback.chosenUci)).join("")}</section>` : "";
    const retry = livePractice.retryAuto && SITE === "chesscom" ? `<div class="crb-study-controls"><button class="crb-live-retry">Retry move</button></div>` : "";
    return `<section class="crb-study-panel"><div class="crb-study-phase">Live practice</div><div class="crb-study-message">${esc(livePractice.message)}</div>${retry}${choiceHtml}<div class="crb-study-stats">Opponent moves: ${livePractice.moves}${livePractice.source ? ` · ${esc(livePractice.source)}` : ""}</div></section>`;
  }

  function boardBusyForAutoMove() {
    const board = findBoard();
    return boardPointerDown || !!board?.querySelector("piece.dragging, piece.anim, piece.fading");
  }

  function attemptLiveAutoMove(fromKey, uci, waitAttempts = 0) {
    if (!livePractice.active || stateKey(currentState()) !== fromKey) return;
    // Chess.com rejects synthetic moves while the player is still holding a
    // piece (and briefly while it is animating). Wait rather than calling it a
    // failed reply; a long-held piece still receives the normal Retry escape.
    if (boardBusyForAutoMove()) {
      if (waitAttempts < 80) {
        livePractice.phase = "opponent";
        livePractice.message = "Waiting for the board to be ready…";
        render();
        livePractice.timer = setTimeout(() => attemptLiveAutoMove(fromKey, uci, waitAttempts + 1), 100);
        return;
      }
      livePractice.retryAuto = { fromKey, uci };
      livePractice.phase = "paused";
      livePractice.message = "The board stayed busy too long. Release the piece, then retry the opponent move.";
      render();
      return;
    }
    livePractice.expectedAuto = { fromKey, uci };
    livePractice.retryAuto = null;
    if (!playMove(uci)) {
      livePractice.expectedAuto = null;
      livePractice.retryAuto = { fromKey, uci };
      livePractice.phase = "paused";
      livePractice.message = `Could not play the move on the ${SITE_LABEL} board.`;
      render();
      return;
    }
    livePractice.autoFailTimer = setTimeout(() => {
      if (!livePractice.active || !livePractice.expectedAuto) return;
      livePractice.expectedAuto = null;
      livePractice.retryAuto = { fromKey, uci };
      livePractice.phase = "paused";
      livePractice.message = `${SITE_LABEL} did not accept the automatic move.`;
      render();
    }, 1600);
  }

  function retryLiveAutoMove() {
    const retry = livePractice.retryAuto;
    if (!retry) return;
    clearLivePracticeTimers();
    livePractice.phase = "opponent";
    livePractice.message = "Retrying the opponent move…";
    render();
    attemptLiveAutoMove(retry.fromKey, retry.uci);
  }

  async function advanceLivePractice() {
    const rep = active();
    if (!livePractice.active) return;
    clearLivePracticeTimers();
    const state = currentState();
    const key = stateKey(state);
    livePractice.expectedAuto = null;
    const legalMoves = C.legal(state);
    if (!legalMoves.length) {
      clearLivePracticeTimers();
      livePractice.retryAuto = null;
      livePractice.phase = "complete";
      livePractice.message = "Game complete.";
      livePractice.source = "";
      render();
      return;
    }
    if (state.turn === (livePractice.playerColor === "black" ? "b" : "w")) {
      livePractice.phase = "awaiting-user";
      livePractice.message = "Your move.";
      livePractice.source = "";
      render();
      return;
    }
    const legal = legalMoves.map(move => ({ ...move, uci: move.from + move.to + (move.promotion || "") }));
    const legalUcis = new Set(legal.map(move => move.uci));
    const official = rep ? sortedEdges(rep, key).filter(edge => legalUcis.has(edge.uci)) : [];
    const rating = Math.max(600, Math.min(2600, Number(uiState.liveMaiaRating) || 1500));
    livePractice.phase = "thinking";
    livePractice.message = "Checking opening explorer…";
    render();
    const explorer = await queryExplorer(state, rating);
    if (!livePractice.active || stateKey(currentState()) !== key) return;
    const explorerMoves = (explorer.moves || []).filter(move => legalUcis.has(move.uci));
    const weights = new Map(explorerMoves.map(move => [move.uci, Number(move.games) || 0]));
    let chosen = null;
    let explorerSelectionPercent = null;
    let explorerOverallPercent = null;
    let explorerRestricted = false;
    if (explorer.available && explorer.total >= 200 && explorerMoves.length) {
      const candidates = uiState.livePracticeRestrictRepertoire && official.length ? official : explorerMoves;
      explorerRestricted = candidates === official;
      const weightedCandidates = candidates.map(item => ({ uci: item.uci, weight: weights.get(item.uci) || item.games || 0 }));
      const candidateTotal = weightedCandidates.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
      chosen = weightedChoice(weightedCandidates);
      const chosenGames = Number(weights.get(chosen?.uci)) || 0;
      explorerSelectionPercent = candidateTotal ? (chosenGames / candidateTotal) * 100 : null;
      explorerOverallPercent = explorer.total ? (chosenGames / explorer.total) * 100 : null;
      livePractice.source = `Explorer ${explorer.brackets?.join("/") || ""} · ${explorer.total.toLocaleString()} games${explorerRestricted ? " · repertoire-only" : ""}`;
      livePractice.message = `Explorer selected ${chosen?.uci || "a move"}.`;
    } else if (uiState.livePracticeRestrictRepertoire && official.length) {
      chosen = weightedChoice(official.map(edge => ({ uci: edge.uci, weight: weights.get(edge.uci) || 0 })));
      livePractice.source = explorer.available ? `Repertoire fallback · ${explorer.total || 0} games` : "Repertoire fallback";
      livePractice.message = "Explorer data is insufficient; choosing a repertoire reply.";
    } else {
      livePractice.source = `Maia ${rating}`;
      livePractice.message = explorer.authRequired
        ? `Lichess login is required for explorer data; using Maia ${rating}.`
        : explorer.error
          ? `Explorer request failed (${explorer.error}); using Maia ${rating}.`
          : `Explorer data is insufficient (${explorer.total || 0} games); using Maia ${rating}.`;
      render();
      try { chosen = { uci: await MAIA.chooseMove(C.fen(state), rating, legal.map(move => move.uci)) }; }
      catch (error) {
        const detail = error?.message || MAIA?.lastError || "Unknown local model error";
        console.error("[Chess Repertoire Builder] Maia fallback failed:", error);
        livePractice.message = `Explorer data is insufficient; Maia could not start: ${detail}`;
        livePractice.phase = "paused";
        render();
        return;
      }
    }
    if (!chosen?.uci || !livePractice.active || stateKey(currentState()) !== key) return;
    const move = legal.find(item => item.uci === chosen.uci);
    const moveName = move ? C.san(state, move) : chosen.uci;
    livePractice.message = explorerSelectionPercent === null
      ? `${livePractice.source}: ${moveName}.`
      : explorerRestricted
        ? `Explorer selected ${moveName} — ${explorerSelectionPercent.toFixed(1)}% among repertoire moves (${explorerOverallPercent?.toFixed(1) || "0.0"}% of all sampled games).`
        : `Explorer selected ${moveName} — ${explorerSelectionPercent.toFixed(1)}% of sampled games.`;
    livePractice.phase = "opponent";
    render();
    livePractice.timer = setTimeout(() => attemptLiveAutoMove(key, chosen.uci), OPPONENT_PLAY_DELAY);
  }

  function startLivePractice() {
    if (!fullBoardControlAvailable()) { alert(realCorrespondenceGameContext() ? "Live practice is disabled on correspondence games. Open the position in Analysis first." : "Live practice requires an Analysis or Study board."); return; }
    if (study.active) exitStudy();
    clearLivePracticeTimers();
    livePractice = freshLivePracticeState();
    livePractice.active = true;
    livePractice.playerColor = uiState.livePracticeColor === "black" ? "black" : "white";
    livePractice.message = "Starting live practice…";
    setBoardOrientation(livePractice.playerColor);
    uiState.panelTab = "study";
    saveUi();
    advanceLivePractice();
  }

  function exitLivePractice() { clearLivePracticeTimers(); livePractice = freshLivePracticeState(); render(); }

  function processLivePracticeForwardRange(startIndex, endIndex) {
    if (!livePractice.active) return;
    let automaticMoveConfirmed = false;
    for (let index = startIndex; index <= endIndex; index++) {
      const parent = history[index - 1], child = history[index];
      if (!parent || !child?.move) continue;
      const parentKey = stateKey(parent.state);
      const rep = active();
      const userCandidates = rep && parent.state.turn === (livePractice.playerColor === "black" ? "b" : "w") ? sortedEdges(rep, parentKey) : [];
      if (userCandidates.length) livePractice.lastUserChoices = { parentKey, parentState: parent.state, chosenUci: child.move.uci };
      if (livePractice.expectedAuto?.fromKey === parentKey && livePractice.expectedAuto.uci === child.move.uci) {
        clearLivePracticeTimers(); livePractice.expectedAuto = null; livePractice.retryAuto = null; livePractice.moves++; automaticMoveConfirmed = true;
      }
    }
    livePractice.timer = setTimeout(advanceLivePractice, automaticMoveConfirmed ? LIVE_MOVE_EXPLANATION_MIN_MS : 100);
  }

  function handleLivePracticeNavigation(oldCursor, newCursor) {
    if (!livePractice.active || oldCursor === newCursor) return;
    clearLivePracticeTimers(); livePractice.expectedAuto = null;
    livePractice.phase = "paused"; livePractice.message = "Board navigation detected. Play a move to continue from this position."; render();
  }

  function render() {
    const root = $("#" + ROOT);
    if (!root) return;
    root.dataset.site = SITE;
    orderingCache.clear();
    const rep = active();
    const state = currentState();
    const pos = currentPos(rep);
    const edge = edgeAtCurrent();
    const last = lastTransition?.move;
    const studySupported = fullBoardControlAvailable();
    const currentPositionStored = currentPositionIsStored(rep);
    const chapters = rep ? availableChapters(rep) : [];
    if (rep) syncChapterSelectionToBoard(rep, chapters);
    const selected = rep ? selectedChapter(rep, chapters) : null;
    if (rep && selectedChapterId(rep) && !selected) setSelectedChapter(rep, "");
    const studyUnavailableTitle = realCorrespondenceGameContext()
      ? `disabled title="Study is disabled on real correspondence game pages. Open the position in Analysis first."`
      : `disabled title="Open an Analysis, Study, or other non-game analysis board to use Study mode."`;
    const fromCurrentUnavailableTitle = !studySupported
      ? studyUnavailableTitle
      : !currentPositionStored
        ? `disabled title="The current board position is not part of this repertoire."`
        : "";
    const chapterActionDisabled = !selected ? `disabled title="Select a specific chapter first."` : "";
    const chapterOptions = chapters.map(chapterOptionHtml).join("");
    const studyButtonText = selected ? "Study selected chapter" : "Study all chapters";
    const chapterSource = openingChapterLoadError
      ? `<div class="crb-inline-note warning">Automatic opening chapters unavailable: ${esc(openingChapterLoadError)}</div>`
      : "";
    const panelTab = study.active || uiState.panelTab === "study" ? "study" : "build";
    const buildTab = panelTab === "build";
    const maiaRating = Number(uiState.liveMaiaRating) || 1500;
    const maiaRatingOptions = Array.from({ length: 21 }, (_, index) => 600 + index * 100)
      .map(rating => `<option value="${rating}" ${rating === maiaRating ? "selected" : ""}>${rating}</option>`).join("");
    const chapterContext = rep ? `<section class="crb-control-section crb-chapter-section"><div class="crb-title">Chapters</div><select class="crb-chapter-select" ${study.active || livePractice.active ? "disabled" : ""}><option value="">All chapters</option>${chapterOptions}</select>${chapterSource}${chapterNavigation ? `<div class="crb-inline-note">Moving board to ${esc(chapterNavigation.chapterName)}…</div>` : ""}${buildTab ? `<div class="crb-toolbar crb-chapter-actions"><button class="crb-create-chapter" ${!currentPositionStored ? `disabled title="Include this position in the repertoire first."` : ""}>Create chapter</button><button class="crb-rename-chapter" ${chapterActionDisabled}>Rename</button><button class="danger crb-delete-chapter" ${chapterActionDisabled}>Delete chapter label</button></div>` : ""}</section>` : "";

    root.innerHTML = `<div class="crb-head" title="Drag to move"><div class="crb-head-title"><span class="crb-drag-handle" aria-hidden="true">⠿</span><b>${livePractice.active ? "Live Repertoire Practice" : study.active ? "Repertoire Study" : "Repertoire Builder"}</b></div><button class="crb-collapse">${root.classList.contains("collapsed") ? "＋" : "−"}</button></div><div class="crb-body">
      <div class="crb-tabs" role="tablist" aria-label="Repertoire mode"><button class="crb-tab ${buildTab ? "selected" : ""}" data-panel-tab="build" role="tab" aria-selected="${buildTab}">Build</button><button class="crb-tab ${!buildTab ? "selected" : ""}" data-panel-tab="study" role="tab" aria-selected="${!buildTab}">Practice</button></div>
      <div class="crb-row"><select class="crb-select" ${study.active || livePractice.active ? "disabled" : ""}><option value="">Select repertoire…</option>${data.repertoires.map(item => `<option value="${item.id}" ${item.id === data.activeId ? "selected" : ""}>${esc(item.name)} — ${item.color}</option>`).join("")}</select>${buildTab ? `<button class="crb-new" ${study.active || livePractice.active ? "disabled" : ""}>New</button>` : ""}</div>
      ${buildTab && !study.active && !livePractice.active ? `<div class="crb-toolbar crb-repertoire-actions">${rep ? `<button class="crb-rename">Rename</button>` : ""}<button class="crb-import">Import PGN</button>${rep ? `<button class="crb-export">Export PGN</button><button class="danger crb-delete-rep">Delete</button>` : ""}</div>` : ""}
      ${chapterContext}
      ${rep && !buildTab && !study.active && !livePractice.active ? `<section class="crb-control-section crb-study-section"><div class="crb-title">Study</div><div class="crb-toolbar"><button class="crb-study-toggle" ${!studySupported ? studyUnavailableTitle : ""}>${studyButtonText}</button><button class="crb-study-from-current" ${fromCurrentUnavailableTitle}>Study from current position</button></div><div class="crb-inline-note">Choose a chapter or all chapters, then start a lesson.</div></section>` : ""}
      ${!buildTab && !study.active && !livePractice.active ? `<section class="crb-control-section crb-live-section"><div class="crb-title">Live Practice</div><button class="crb-start-live-practice crb-live-primary" ${!studySupported ? studyUnavailableTitle : ""}>Start live practice</button><div class="crb-live-color"><span>Your side</span><button data-live-color="white" class="${uiState.livePracticeColor !== "black" ? "selected" : ""}">White</button><button data-live-color="black" class="${uiState.livePracticeColor === "black" ? "selected" : ""}">Black</button></div><div class="crb-lichess-auth"><span>${lichessAuth.connected ? "Lichess connected" : lichessAuth.busy ? "Connecting to Lichess…" : "Lichess not connected"}</span><button class="crb-lichess-auth-button" ${lichessAuth.busy ? "disabled" : ""}>${lichessAuth.connected ? "Disconnect" : "Connect Lichess"}</button></div>${lichessAuth.error ? `<div class="crb-inline-note warning">${esc(lichessAuth.error)}</div>` : ""}<label class="crb-study-option"><input class="crb-restrict-repertoire" type="checkbox" ${uiState.livePracticeRestrictRepertoire && rep ? "checked" : ""} ${rep ? "" : "disabled"}><span>Restrict bot to repertoire moves</span></label>${!rep ? `<div class="crb-inline-note">Select a repertoire to enable repertoire-restricted replies.</div>` : ""}<label class="crb-maia-rating"><span>Rating</span><select class="crb-select">${maiaRatingOptions}</select></label><div class="crb-inline-note">Explorer uses the three nearest rating brackets. Sign in to Lichess to use explorer data; Maia is used only when data is unavailable or under 200 games.</div></section>` : ""}
      ${rep && study.active ? `<div class="crb-toolbar crb-study-exit-row"><button class="crb-study-toggle">Exit study</button></div>` : ""}
      ${rep && livePractice.active ? `<div class="crb-toolbar crb-study-exit-row"><button class="crb-live-exit">Exit live practice</button></div>` : ""}
      <div class="crb-status">${lastTransition ? `Current move: <b>${esc(last.san)}</b> · ${state.turn === "w" ? "White" : "Black"} to move` : `${state.turn === "w" ? "White" : "Black"} to move`}${syncNotice ? `<div class="crb-sync-note">${esc(syncNotice)}</div>` : ""}</div>
      ${rep && study.active ? renderStudyPanel(rep) : rep && livePractice.active ? renderLivePracticePanel(rep) : ""}
      ${rep && buildTab && !study.active && lastTransition ? renderCurrentAction(rep, edge, last) : ""}
      ${rep && !study.active && !livePractice.active ? renderPositionMoves(rep, pos, state) : !rep && !liveSetup ? `<div class="crb-empty">${buildTab ? "Create a named White or Black repertoire." : "Select a repertoire to prepare a study session."}</div>` : ""}
      <input class="crb-file" type="file" accept=".pgn,text/plain" hidden>
      <div class="crb-foot">Stored locally in extension cache. Hidden during live human games.</div></div>`;
    bind();
    renderBoardAnnotations(rep, state, edge);
  }

  function bind() {
    const root = $("#" + ROOT);
    initPanelDrag(root);
    $(".crb-collapse", root)?.addEventListener("click", event => {
      event.stopPropagation();
      root.classList.toggle("collapsed");
      uiState.collapsed = root.classList.contains("collapsed");
      event.currentTarget.textContent = uiState.collapsed ? "＋" : "−";
      saveUi();
      applyPanelPosition();
    });
    $$('[data-panel-tab]', root).forEach(button => button.addEventListener("click", () => {
      const nextTab = button.dataset.panelTab === "study" ? "study" : "build";
      if (nextTab === uiState.panelTab && !(study.active && nextTab === "build")) return;
      uiState.panelTab = nextTab;
      saveUi();
      if ((study.active || livePractice.active) && nextTab === "build") { if (study.active) exitStudy(); else exitLivePractice(); }
      else render();
    }));
    $(".crb-select", root)?.addEventListener("change", event => {
      if (study.active) exitStudy();
      if (livePractice.active) exitLivePractice();
      clearChapterNavigation();
      lastChapterAutoSyncToken = "";
      data.activeId = event.target.value || null;
      save();
      render();
    });
    $(".crb-new", root)?.addEventListener("click", () => {
      const name = prompt("Repertoire name:", "My Repertoire");
      if (name === null) return;
      const color = (prompt("Repertoire color: white or black", "white") || "white").toLowerCase() === "black" ? "black" : "white";
      newRep(name, color);
    });
    $(".crb-study-toggle", root)?.addEventListener("click", () => study.active ? exitStudy() : startSelectedChapterStudy());
    $(".crb-chapter-select", root)?.addEventListener("change", event => {
      const rep = active();
      if (!rep) return;
      const id = event.currentTarget.value || "";
      setSelectedChapter(rep, id);
      // Preserve an explicit All chapters selection until the board actually
      // reaches another chapter position.
      lastChapterAutoSyncToken = `${rep.id}|${stateKey(currentState())}`;
      if (!id) {
        clearChapterNavigation();
        syncNotice = "";
        render();
        return;
      }
      const chapter = availableChapters(rep).find(item => item.id === id);
      if (chapter) navigateToSelectedChapter(chapter);
      else render();
    });
    $(".crb-study-from-current", root)?.addEventListener("click", startStudyFromCurrent);
    $(".crb-start-live-practice", root)?.addEventListener("click", startLivePractice);
    $$('[data-live-color]', root).forEach(button => button.addEventListener("click", () => {
      uiState.livePracticeColor = button.dataset.liveColor === "black" ? "black" : "white";
      saveUi();
      setBoardOrientation(uiState.livePracticeColor);
      render();
    }));
    $(".crb-lichess-auth-button", root)?.addEventListener("click", toggleLichessAuth);
    $(".crb-live-exit", root)?.addEventListener("click", exitLivePractice);
    $(".crb-live-retry", root)?.addEventListener("click", retryLiveAutoMove);
    $(".crb-restrict-repertoire", root)?.addEventListener("change", event => { uiState.livePracticeRestrictRepertoire = event.currentTarget.checked; saveUi(); render(); });
    $(".crb-maia-rating .crb-select", root)?.addEventListener("change", event => {
      uiState.liveMaiaRating = Math.max(600, Math.min(2600, Number(event.currentTarget.value) || 1500));
      saveUi();
      render();
    });
    $(".crb-create-chapter", root)?.addEventListener("click", createChapterFromCurrent);
    $(".crb-rename-chapter", root)?.addEventListener("click", renameSelectedChapter);
    $(".crb-delete-chapter", root)?.addEventListener("click", deleteSelectedChapter);
    $(".crb-auto-continue-comments", root)?.addEventListener("change", event => {
      uiState.studyAutoContinueComments = event.currentTarget.checked;
      saveUi();
      if (uiState.studyAutoContinueComments) scheduleAutoCommentAdvance();
      else clearAutoCommentTimer();
      render();
    });
    $(".crb-rename", root)?.addEventListener("click", renameRep);
    $(".crb-delete-rep", root)?.addEventListener("click", deleteRep);
    $$('[data-add]', root).forEach(button => button.onclick = () => addCurrent(button.dataset.add === "preferred"));
    $(".crb-preferred", root)?.addEventListener("click", () => updateEdge(edge => {
      const rep = active();
      const pos = rep.positions[stateKey(history[cursor - 1].state)];
      if (edge.preferred) {
        edge.preferred = false;
        delete edge.preferredAt;
      } else setPreferredAtPosition(pos, edge);
    }));
    $$('[data-nag]', root).forEach(button => button.onclick = () => setNag(+button.dataset.nag));
    $(".crb-save-comment", root)?.addEventListener("click", saveComment);
    $(".crb-delete-move", root)?.addEventListener("click", deleteCurrentMove);
    $(".crb-export", root)?.addEventListener("click", exportPgn);
    $(".crb-import", root)?.addEventListener("click", () => $(".crb-file", root).click());
    $(".crb-file", root)?.addEventListener("change", importFile);
    $$('[data-play]', root).forEach(button => button.onclick = event => {
      event.stopPropagation();
      playMove(button.dataset.play);
    });
    $$('details[data-line-id]', root).forEach(details => details.addEventListener("toggle", () => {
      uiState.expandedLines ||= {};
      const was = !!uiState.expandedLines[details.dataset.lineId];
      if (details.open === was) return;
      if (details.open) uiState.expandedLines[details.dataset.lineId] = true;
      else delete uiState.expandedLines[details.dataset.lineId];
      saveUi();
      scheduleRender();
    }));
    $$('[data-study-action]', root).forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.studyAction;
      if (action === "retry") retryStudyAnswer();
      else if (action === "show-answer") revealStudyAnswer();
      else if (action === "play-answer") playRevealedAnswer();
      else if (action === "toggle-answer-line") { study.showAnswerLine = !study.showAnswerLine; render(); }
      else if (action === "study-preferred") studyPreferredLine();
      else if (action === "continue") continueStudy();
      else if (action === "another-line") beginNextStudyLine();
      else if (action === "dismiss-optional") {
        study.phase = "complete";
        study.message = "Line complete.";
        render();
      }
      else if (action === "next-line") beginNextStudyLine();
      else if (action === "skip-line") skipCurrentStudyLine();
      else if (action === "restart") beginNextStudyLine(true);
      else if (action === "restart-full") beginNextStudyLine(true, true);
      else if (action === "resume") resumeStudyFromHere();
      else if (action === "exit") exitStudy();
    }));
  }

  function panelBounds(left, top) {
    const root = $("#" + ROOT);
    if (!root) return { left, top };
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - root.offsetWidth - margin);
    const visibleHeight = Math.min(root.offsetHeight, 54);
    const maxTop = Math.max(margin, window.innerHeight - visibleHeight);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function applyPanelPosition() {
    const root = $("#" + ROOT);
    if (!root) return;
    const defaultLeft = Math.max(8, window.innerWidth - root.offsetWidth - 16);
    const left = Number.isFinite(uiState.left) ? uiState.left : defaultLeft;
    const top = Number.isFinite(uiState.top) ? uiState.top : 72;
    const position = panelBounds(left, top);
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.style.right = "auto";
    uiState.left = position.left;
    uiState.top = position.top;
  }

  function initPanelDrag(root) {
    const head = $(".crb-head", root);
    if (!head) return;
    head.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      root.classList.add("dragging");
      head.setPointerCapture?.(event.pointerId);
      const move = pointerEvent => {
        const position = panelBounds(startLeft + pointerEvent.clientX - startX, startTop + pointerEvent.clientY - startY);
        root.style.left = `${position.left}px`;
        root.style.top = `${position.top}px`;
        root.style.right = "auto";
      };
      const end = pointerEvent => {
        root.classList.remove("dragging");
        head.releasePointerCapture?.(pointerEvent.pointerId);
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", end);
        head.removeEventListener("pointercancel", end);
        const finalRect = root.getBoundingClientRect();
        uiState.left = Math.round(finalRect.left);
        uiState.top = Math.round(finalRect.top);
        saveUi();
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", end);
      head.addEventListener("pointercancel", end);
    });
  }

  function playMove(uci) {
    if (!fullBoardControlAvailable()) return false;
    if (SITE === "lichess") {
      const root = document.documentElement;
      root.dataset.crbLichessPlay = uci;
      root.dispatchEvent(new Event("crb-lichess-play"));
      return true;
    }
    const board = findBoard();
    if (!board) return false;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const getPiece = square => board.querySelector(`.piece.square-${"abcdefgh".indexOf(square[0]) + 1}${square[1]}`);
    if (!getPiece(from)) return false;
    const rect = board.getBoundingClientRect();
    const size = rect.width / 8;
    const flipped = /flipped|black/.test(`${board.className} ${board.getAttribute("orientation")}`.toLowerCase());
    const center = square => {
      let file = "abcdefgh".indexOf(square[0]);
      let rank = +square[1] - 1;
      if (flipped) { file = 7 - file; rank = 7 - rank; }
      return { x: rect.left + (file + 0.5) * size, y: rect.top + (7 - rank + 0.5) * size };
    };
    const fromPoint = center(from);
    const toPoint = center(to);
    board.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: fromPoint.x, clientY: fromPoint.y, pointerId: 1, buttons: 1 }));
    board.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: toPoint.x, clientY: toPoint.y, pointerId: 1, buttons: 0 }));
    return true;
  }

  function nearestKnownIndex(placement) {
    let best = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < history.length; index++) {
      if (history[index].placement !== placement) continue;
      const distance = Math.abs(index - cursor);
      if (distance < bestDistance || (distance === bestDistance && index > best)) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  }

  function acceptPlacement(placement) {
    if (!placement) return false;
    if (history[cursor]?.placement === placement) {
      latestUnmatched = "";
      return true;
    }
    const oldCursor = cursor;
    const base = history[cursor].state;
    const now = performance.now();
    const boardMoveIntent = now - lastBoardPointerAt < 700 && (!lastNavigationIntentAt || now - lastNavigationIntentAt > 250);
    const automatedIntent = !!study.expectedAuto || !!study.expectedAssisted || !!livePractice.expectedAuto;

    // During study, prefer interpreting a fresh board gesture or an expected
    // autoplay transition as a move, even when the resulting position was
    // already visited earlier in the page session. Arrow/click navigation is
    // handled below as a known-position jump and is never graded.
    if ((study.active || livePractice.active) && (boardMoveIntent || automatedIntent)) {
      const replayHit = C.matchTransition(base, placement);
      if (replayHit) {
        history = history.slice(0, cursor + 1);
        history.push({ state: replayHit.state, placement, move: replayHit.move });
        cursor++;
        lastTransition = replayHit;
        latestUnmatched = "";
        syncNotice = "";
        if (study.active) processStudyForwardRange(cursor, cursor);
        if (livePractice.active) processLivePracticeForwardRange(cursor, cursor);
        scheduleRender();
        return true;
      }
    }

    const known = nearestKnownIndex(placement);
    if (known >= 0) {
      cursor = known;
      lastTransition = cursor ? { move: history[cursor].move, state: history[cursor].state } : null;
      latestUnmatched = "";
      syncNotice = "";
      handleStudyNavigation(oldCursor, cursor);
      handleLivePracticeNavigation(oldCursor, cursor);
      scheduleRender();
      return true;
    }
    const hit = C.matchTransition(base, placement);
    if (!hit) return false;
    history = history.slice(0, cursor + 1);
    history.push({ state: hit.state, placement, move: hit.move });
    cursor++;
    lastTransition = hit;
    latestUnmatched = "";
    syncNotice = "";
    if (study.active) processStudyForwardRange(cursor, cursor);
    if (livePractice.active) processLivePracticeForwardRange(cursor, cursor);
    scheduleRender();
    return true;
  }

  function findSkippedSequence(fromState, targetPlacement) {
    const deadline = performance.now() + 45;
    const nodeCap = 18000;
    let nodes = 0;
    let timedOut = false;
    function exact(state, remaining, path, results) {
      if (results.length > 1 || timedOut) return;
      for (const move of C.legal(state)) {
        if (++nodes > nodeCap || performance.now() > deadline) {
          timedOut = true;
          return;
        }
        const next = C.apply(state, move);
        const entry = { before: state, state: next, placement: C.placement(next), rawMove: move };
        if (remaining === 1) {
          if (entry.placement === targetPlacement) {
            results.push([...path, entry]);
            if (results.length > 1) return;
          }
        } else exact(next, remaining - 1, [...path, entry], results);
        if (results.length > 1 || timedOut) return;
      }
    }
    for (const depth of [2, 3]) {
      const results = [];
      exact(fromState, depth, [], results);
      if (results.length === 1) {
        return results[0].map(step => ({
          state: step.state,
          placement: step.placement,
          move: {
            ...step.rawMove,
            san: C.san(step.before, step.rawMove),
            uci: step.rawMove.from + step.rawMove.to + (step.rawMove.promotion || "")
          }
        }));
      }
      if (results.length > 1 || timedOut) return null;
    }
    return null;
  }

  function continueLivePracticeFromCurrentPosition(placement) {
    if (!livePractice.active || !placement) return false;
    // Chess.com exposes the piece placement but not a reliable full FEN. When
    // a burst of moves cannot be reconstructed, retain the visible position
    // and infer whose turn is next from whether the extension was awaiting
    // its own automatic reply. This is preferable to asking the player to
    // rewind an otherwise valid live-practice game.
    const playerTurn = livePractice.playerColor === "black" ? "b" : "w";
    const turn = livePractice.expectedAuto ? playerTurn : (playerTurn === "w" ? "b" : "w");
    const bridgedFen = SITE === "lichess" ? document.documentElement.dataset.crbLichessFen : "";
    const fen = bridgedFen?.split(/\s+/)[0] === placement
      ? bridgedFen
      : `${placement} ${turn} - - 0 1`;
    let state;
    try { state = C.parseFen(fen); }
    catch (_) { return false; }
    clearLivePracticeTimers();
    history = [{ state, placement, move: null }];
    cursor = 0;
    lastTransition = null;
    latestUnmatched = "";
    syncNotice = "";
    livePractice.expectedAuto = null;
    livePractice.retryAuto = null;
    livePractice.message = "Continuing from the current board position…";
    livePractice.source = "";
    render();
    livePractice.timer = setTimeout(advanceLivePractice, 160);
    return true;
  }

  function recoverLatestPlacement() {
    const placement = readPlacement();
    if (!placement) return;
    observedPlacement = placement;
    if (acceptPlacement(placement)) return;
    const startCursor = cursor;
    const sequence = findSkippedSequence(history[cursor].state, placement);
    if (sequence?.length) {
      history = history.slice(0, cursor + 1);
      for (const step of sequence) history.push(step);
      cursor = history.length - 1;
      const last = sequence[sequence.length - 1];
      lastTransition = { move: last.move, state: last.state };
      latestUnmatched = "";
      syncNotice = "";
      if (study.active) processStudyForwardRange(startCursor + 1, cursor);
      if (livePractice.active) processLivePracticeForwardRange(startCursor + 1, cursor);
      scheduleRender();
      return;
    }
    if (continueLivePracticeFromCurrentPosition(placement)) return;
    latestUnmatched = placement;
    syncNotice = "The board changed too quickly to reconstruct the line. Step back to the last recognized position, then replay the missing moves a little more slowly.";
    scheduleRender();
  }

  function capturePlacement() {
    const placement = readPlacement();
    if (!placement || placement === observedPlacement) return;
    observedPlacement = placement;
    if (!acceptPlacement(placement)) latestUnmatched = placement;
  }

  function boardMutated() {
    if (sampleTimer === null) sampleTimer = setTimeout(() => {
      sampleTimer = null;
      capturePlacement();
    }, 20);
    if (burstPoll === null) burstPoll = setInterval(capturePlacement, 40);
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (burstPoll !== null) {
        clearInterval(burstPoll);
        burstPoll = null;
      }
      capturePlacement();
      recoverLatestPlacement();
    }, 150);
  }

  function observe() {
    const board = findBoard();
    if (!board) {
      setTimeout(observe, 700);
      return;
    }
    boardObserver?.disconnect();
    boardAnnotationResizeObserver?.disconnect();
    boardObserver = new MutationObserver(boardMutated);
    boardObserver.observe(board, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "data-square"] });
    boardAnnotationResizeObserver = new ResizeObserver(() => renderBoardAnnotations(active(), currentState(), edgeAtCurrent()));
    boardAnnotationResizeObserver.observe(board);
    observedPlacement = "";
    capturePlacement();
  }

  function pgnHeaders(rep) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    return `[Event "${rep.name.replace(/["\\]/g, "")}"]\n[Site "Chess Repertoire Builder"]\n[Date "${date}"]\n[Round "-"]\n[White "${rep.color === "white" ? "Repertoire" : "Opponent"}"]\n[Black "${rep.color === "black" ? "Repertoire" : "Opponent"}"]\n[Result "*"]\n[RepertoireColor "${rep.color}"]\n`;
  }

  function serialize(rep) {
    function line(key, state, ply) {
      const sorted = sortedEdges(rep, key);
      if (!sorted.length) return "";
      const main = sorted[0];
      let out = moveText(rep, main, state, ply);
      for (const alternative of sorted.slice(1)) {
        const altState = applyUci(state, alternative.uci);
        let branch = moveText(rep, alternative, state, ply);
        const continuation = altState ? line(alternative.childKey, altState, ply + 1) : "";
        if (continuation) branch += " " + continuation;
        out += ` (${branch})`;
      }
      const childState = applyUci(state, main.uci);
      const continuation = childState ? line(main.childKey, childState, ply + 1) : "";
      if (continuation) out += " " + continuation;
      return out;
    }
    const rootComment = formatPgnComment(rep, rep.rootKey, rep.positions?.[rep.rootKey]?.comment || "");
    return pgnHeaders(rep) + "\n" + rootComment + line(rep.rootKey, INITIAL, 0) + " *\n";
  }

  function chapterDirectives(rep, key) {
    return (rep.chapters || [])
      .filter(chapter => chapter.rootKey === key)
      .map(chapter => `Chapter: ${String(chapter.name || "").replace(/[{}\r\n]+/g, " ").replace(/\s+/g, " ").trim()}`)
      .filter(line => line !== "Chapter: ")
      .join("\n");
  }

  function formatPgnComment(rep, key, humanText) {
    const directives = chapterDirectives(rep, key);
    const humanComment = String(humanText || "").replace(/[{}]/g, "").trim();
    const comment = [directives, humanComment].filter(Boolean).join("\n\n");
    return comment ? `{${comment}}\n` : "";
  }

  function moveText(rep, edge, state) {
    const prefix = state.turn === "w" ? `${state.full}.` : `${state.full}...`;
    const comment = formatPgnComment(rep, edge.childKey, edge.comment).trim();
    return `${prefix} ${edge.san}${edge.nag ? ` $${edge.nag}` : ""}${comment ? ` ${comment}` : ""}`;
  }

  function applyUci(state, uci) {
    const move = C.legal(state).find(candidate => candidate.from + candidate.to + (candidate.promotion || "") === uci);
    return move ? C.apply(state, move) : null;
  }

  function exportPgn() {
    const rep = active();
    if (!rep) return;
    const blob = new Blob([serialize(rep)], { type: "application/x-chess-pgn" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = rep.name.replace(/[^a-z0-9_-]+/gi, "_") + ".pgn";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const addAutomaticChapters = confirm("Automatically create opening chapters for recognized positions in this PGN?\n\nExplicit Chapter: Name comments will import either way.");
      const rep = importPgn(text, file.name, { addAutomaticChapters });
      alert(`PGN imported as new repertoire “${rep.name}”.`);
    } catch (error) {
      alert("PGN import failed: " + error.message);
    }
    event.target.value = "";
  }

  function pgnHeader(text, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`^\\s*\\[${escapedName}\\s+"((?:\\\\.|[^"\\\\])*)"\\s*\\]`, "im"));
    return match ? match[1].replace(/\\(["\\])/g, "$1").trim() : "";
  }

  function uniqueRepertoireName(requested) {
    const base = requested.trim() || "Imported Repertoire";
    const used = new Set(data.repertoires.map(rep => rep.name.trim().toLocaleLowerCase()));
    if (!used.has(base.toLocaleLowerCase())) return base;
    let number = 2;
    while (used.has(`${base} (${number})`.toLocaleLowerCase())) number += 1;
    return `${base} (${number})`;
  }

  function pgnMovetext(text) {
    const lines = String(text || "").split(/\r?\n/);
    let inHeader = true;
    const body = [];
    for (const line of lines) {
      if (inHeader && /^\s*\[[^\r\n]*\]\s*$/.test(line)) continue;
      if (inHeader && !line.trim()) continue;
      inHeader = false;
      body.push(line);
    }
    return body.join("\n");
  }

  function importPositionComment(rep, key, text, edge = null) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    const firstLine = lines[0]?.trim() || "";
    const match = firstLine.match(/^Chapter:\s*(.+)$/i);
    const name = (match?.[1] || "").trim();
    // Only the first line can declare a chapter. Parenthesized legacy syntax
    // is deliberately not accepted; all unconsumed text remains a comment.
    if (name && !/^\(.*\)$/.test(name)) {
      const existing = (rep.chapters || []).find(chapter => chapter.rootKey === key);
      if (existing?.type === "auto") {
        existing.type = "manual";
        existing.name = name;
        delete existing.originalName;
        delete existing.eco;
        delete existing.line;
        existing.updatedAt = Date.now();
      } else {
        addStoredChapter(rep, name, key, "manual");
      }
      index = 1;
    }
    while (index < lines.length && !lines[index].trim()) index += 1;
    const humanComment = lines.slice(index).join("\n").trim();
    if (edge) edge.comment = humanComment;
    else if (humanComment) ensurePos(rep, key).comment = humanComment;
  }

  function importPgn(text, fileName = "", options = {}) {
    const addAutomaticChapters = options.addAutomaticChapters !== false;
    const headerColor = pgnHeader(text, "RepertoireColor").toLowerCase();
    const color = headerColor === "black" ? "black" : "white";
    const fileBase = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    const requestedName = pgnHeader(text, "Event") || fileBase || `${color === "white" ? "White" : "Black"} Repertoire`;
    const rep = repertoireRecord(uniqueRepertoireName(requestedName), color);
    const body = pgnMovetext(text);
    const tokens = body.match(/\{[^}]*\}|\$\d+|\(|\)|1-0|0-1|1\/2-1\/2|\*|\d+\.(?:\.\.)?|[^\s(){}]+/g) || [];
    let index = 0;
    let state = INITIAL;
    let key = rep.rootKey;
    let lastEdge = null;
    const stack = [];
    while (index < tokens.length) {
      const token = tokens[index++];
      if (/^\d+\./.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue;
      if (token === "(") {
        stack.push({ state, key, lastEdge });
        state = lastEdge ? lastEdge.parentState : state;
        key = lastEdge ? lastEdge.parentKey : key;
        lastEdge = null;
        continue;
      }
      if (token === ")") {
        const entry = stack.pop();
        if (entry) {
          state = entry.state;
          key = entry.key;
          lastEdge = entry.lastEdge;
        }
        continue;
      }
      if (token.startsWith("{")) {
        importPositionComment(rep, key, token.slice(1, -1), lastEdge?.edge || null);
        continue;
      }
      if (/^\$[1-6]$/.test(token)) {
        if (lastEdge) lastEdge.edge.nag = +token.slice(1);
        continue;
      }
      const move = C.moveSan(state, token);
      if (!move) continue;
      const uci = move.from + move.to + (move.promotion || "");
      const next = C.apply(state, move);
      const childKey = stateKey(next);
      const pos = ensurePos(rep, key);
      let edge = pos.moves[uci];
      if (!edge) {
        const first = Object.keys(pos.moves).length === 0;
        edge = pos.moves[uci] = {
          uci,
          san: C.san(state, move),
          childKey,
          preferred: first,
          preferredAt: first ? Date.now() : undefined,
          nag: null,
          comment: "",
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      }
      const childWasStored = !!rep.positions[childKey];
      ensurePos(rep, childKey);
      if (addAutomaticChapters && !childWasStored) createAutomaticChapterForPosition(rep, childKey);
      lastEdge = { edge, parentState: state, parentKey: key };
      state = next;
      key = childKey;
    }
    rep.updatedAt = Date.now();
    data.repertoires.push(rep);
    data.activeId = rep.id;
    save();
    render();
    return rep;
  }

  async function installBundledOfficialRepertoires() {
    const installed = await new Promise(resolve => chrome.storage.local.get(OFFICIAL_REPERTOIRES_STORE, result => resolve(result[OFFICIAL_REPERTOIRES_STORE])));
    if (Number(installed?.version) >= OFFICIAL_REPERTOIRES_VERSION) return;
    const previousActiveId = data.activeId;
    const names = new Set(data.repertoires.map(rep => rep.name.trim().toLocaleLowerCase()));
    for (const official of OFFICIAL_REPERTOIRES) {
      if (names.has(official.name.toLocaleLowerCase())) continue;
      const response = await fetch(chrome.runtime.getURL(official.file));
      if (!response.ok) throw new Error(`could not load ${official.name}`);
      importPgn(await response.text(), official.file, { addAutomaticChapters: false });
      names.add(official.name.toLocaleLowerCase());
    }
    if (previousActiveId && data.repertoires.some(rep => rep.id === previousActiveId)) data.activeId = previousActiveId;
    await save();
    await chrome.storage.local.set({ [OFFICIAL_REPERTOIRES_STORE]: { version: OFFICIAL_REPERTOIRES_VERSION, installedAt: Date.now() } });
  }

  function teardownForUnsafeContext() {
    clearStudyTimers();
    clearLivePracticeTimers();
    clearChapterNavigation();
    boardObserver?.disconnect();
    boardAnnotationResizeObserver?.disconnect();
    clearBoardAnnotations();
    if (sampleTimer !== null) clearTimeout(sampleTimer);
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (burstPoll !== null) clearInterval(burstPoll);
    $("#" + ROOT)?.remove();
    if (safetyTimer !== null) clearInterval(safetyTimer);
    safetyTimer = null;
  }

  async function boot() {
    if (!(await waitForAllowedContext())) return;
    uiState = await load() || {};
    uiState.liveMaiaRating = Math.max(600, Math.min(2600, Number(uiState.liveMaiaRating || uiState.studyMaiaRating) || 1500));
    try {
      const response = await fetch(OPENING_CHAPTERS_URL);
      if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
      openingChapterIndex = await response.json();
    } catch (error) {
      openingChapterLoadError = error?.message || String(error);
      openingChapterIndex = { meta: {}, positions: {} };
    }
    if (uiState.panelPositionVersion !== PANEL_POSITION_VERSION) {
      delete uiState.left;
      delete uiState.top;
      uiState.panelPositionVersion = PANEL_POSITION_VERSION;
      await saveUi();
    }
    if (!data.repertoires.length) {
      newRep("White Repertoire", "white");
      newRep("Black Repertoire", "black");
      data.activeId = data.repertoires[0].id;
      await save();
    } else if (migrationDirty) {
      await save();
    }
    try {
      await installBundledOfficialRepertoires();
    } catch (error) {
      console.warn("[Chess Repertoire Builder] Could not install bundled repertoires:", error);
    }
    const root = document.createElement("div");
    root.id = ROOT;
    if (uiState.collapsed) root.classList.add("collapsed");
    document.body.appendChild(root);
    document.addEventListener("crb-maia-status", scheduleRender);
    refreshLichessAuth();
    render();
    applyPanelPosition();
    window.addEventListener("resize", () => requestAnimationFrame(() => {
      applyPanelPosition();
      renderBoardAnnotations(active(), currentState(), edgeAtCurrent());
      saveUi();
    }));
    window.addEventListener("scroll", () => renderBoardAnnotations(active(), currentState(), edgeAtCurrent()), true);
    document.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
        lastNavigationIntentAt = performance.now();
      }
    }, true);
    document.addEventListener("pointerdown", event => {
      const board = findBoard();
      const panel = $("#" + ROOT);
      if (board?.contains(event.target)) {
        boardPointerDown = true;
        lastBoardPointerAt = performance.now();
      } else if (!panel?.contains(event.target)) lastNavigationIntentAt = performance.now();
    }, true);
    document.addEventListener("pointerup", () => {
      if (!boardPointerDown) return;
      boardPointerDown = false;
      setTimeout(capturePlacement, 20);
    }, true);
    document.documentElement.addEventListener("crb-lichess-state", () => {
      if (SITE !== "lichess") return;
      capturePlacement();
      scheduleRender();
    });
    safetyTimer = setInterval(() => {
      if (definitelyUnsafeLiveContext()) teardownForUnsafeContext();
    }, 500);
    observe();
  }

  boot();
})();
