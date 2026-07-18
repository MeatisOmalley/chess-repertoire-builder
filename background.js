"use strict";

const explorerCache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const AUTH_KEY = "crbLichessOAuth";
const CLIENT_ID = "chess-repertoire-builder";

function b64url(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomString(length = 64) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return b64url(bytes); }
async function challengeFor(verifier) { return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))); }
async function authRecord() {
  const auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY];
  if (!auth?.accessToken) return null;
  if (auth.expiresAt && auth.expiresAt <= Date.now() + 30000) { await chrome.storage.local.remove(AUTH_KEY); return null; }
  return auth;
}
async function authStatus() { const auth = await authRecord(); return { ok: true, connected: Boolean(auth), expiresAt: auth?.expiresAt || null }; }
async function connectLichess() {
  const redirectUri = chrome.identity.getRedirectURL("lichess");
  const verifier = randomString(72), state = randomString(24);
  const url = new URL("https://lichess.org/oauth");
  url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge_method: "S256", code_challenge: await challengeFor(verifier), state });
  const callbackUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  if (!callbackUrl) throw new Error("Lichess authorization was cancelled.");
  const returned = new URL(callbackUrl);
  if (returned.searchParams.get("state") !== state) throw new Error("Lichess authorization state did not match.");
  if (returned.searchParams.get("error")) throw new Error(returned.searchParams.get("error_description") || returned.searchParams.get("error"));
  const code = returned.searchParams.get("code");
  if (!code) throw new Error("Lichess authorization did not return a code.");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID });
  const response = await fetch("https://lichess.org/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) throw new Error(token.error_description || token.error || `Lichess token request failed (${response.status}).`);
  const expiresAt = Date.now() + Number(token.expires_in || 31536000) * 1000;
  await chrome.storage.local.set({ [AUTH_KEY]: { accessToken: token.access_token, expiresAt } });
  return { ok: true, connected: true, expiresAt };
}
async function disconnectLichess() {
  const auth = await authRecord();
  await chrome.storage.local.remove(AUTH_KEY);
  if (auth?.accessToken) try { await fetch("https://lichess.org/api/token", { method: "DELETE", headers: { Authorization: `Bearer ${auth.accessToken}` } }); } catch (_) {}
  return { ok: true, connected: false };
}

function parseExplorer(text) {
  const records = String(text || "").trim().split(/\n+/).filter(Boolean).map(line => JSON.parse(line));
  return records[records.length - 1] || {};
}

async function getExplorer(fen, rating) {
  const auth = await authRecord();
  if (!auth) return { available: false, authRequired: true, total: 0, moves: [] };
  // These are Lichess' public database brackets. GroupLow is queried as 400.
  // Pooling the three closest brackets gives a useful sample without silently
  // snapping a player to one arbitrarily distant population.
  const brackets = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500, 2800, 3200];
  const target = Number(rating) || 1500;
  const selected = brackets.slice().sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b).slice(0, 3).sort((a, b) => a - b);
  const key = `${selected.join(",")}|${fen}`;
  const cached = explorerCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const url = new URL("https://explorer.lichess.ovh/lichess");
  url.search = new URLSearchParams({ variant: "standard", speeds: "bullet,blitz,rapid,classical", ratings: selected.join(","), fen, moves: "100", topGames: "0", recentGames: "0", source: "analysis" });
  const response = await fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" } });
  if (response.status === 401) { await chrome.storage.local.remove(AUTH_KEY); return { available: false, authRequired: true, total: 0, moves: [] }; }
  if (!response.ok) throw new Error(`Opening explorer request failed (${response.status})`);
  const data = parseExplorer(await response.text());
  const reportedTotal = Number(data.white || 0) + Number(data.draws || 0) + Number(data.black || 0);
  const moves = (data.moves || []).map(move => ({ uci: move.uci, games: Number(move.white || 0) + Number(move.draws || 0) + Number(move.black || 0) }));
  // The bot draws from these move weights, so use their sum as the sample
  // total displayed to the player. This also avoids relying on a root summary
  // whose shape can differ across Explorer response formats.
  const total = moves.reduce((sum, move) => sum + move.games, 0) || reportedTotal;
  const value = { available: true, total, brackets: selected, moves };
  explorerCache.set(key, { at: Date.now(), value });
  return value;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = promise => { promise.then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) })); return true; };
  if (message?.type === "crb-explorer-query") return respond(getExplorer(message.fen, message.rating).then(result => ({ ok: true, result })));
  if (message?.type === "crb-lichess-auth-status") return respond(authStatus());
  if (message?.type === "crb-lichess-connect") return respond(connectLichess());
  if (message?.type === "crb-lichess-disconnect") return respond(disconnectLichess());
  return false;
});
