"use strict";
let sessionPromise = null;

function initializeRuntime(runtimeBase) {
  const base = new URL(".", runtimeBase || self.location.href);
  importScripts(new URL("ort/ort.wasm.min.js", base).href);
  ort.env.wasm.wasmPaths = new URL("ort/", base).href;
  ort.env.wasm.numThreads = 1;
}

async function loadModel(modelUrl) {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Could not load Maia model (${response.status})`);
  const bytes = await response.arrayBuffer();
  return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
}

self.onmessage = async event => {
  const message = event.data || {};
  try {
    if (message.type === "init") {
      initializeRuntime(message.runtimeBase);
      sessionPromise = loadModel(message.modelUrl);
      await sessionPromise;
      self.postMessage({ type: "ready" });
      return;
    }
    if (message.type !== "infer") return;
    if (!sessionPromise) throw new Error("Maia has not been initialized");
    const session = await sessionPromise;
    const result = await session.run({
      tokens: new ort.Tensor("float32", new Float32Array(message.tokens), [1, 64, 12]),
      elo_self: new ort.Tensor("float32", Float32Array.from([message.selfRating]), [1]),
      elo_oppo: new ort.Tensor("float32", Float32Array.from([message.opponentRating]), [1])
    });
    if (!result.logits_move?.data) throw new Error(`Maia model returned no move policy (outputs: ${Object.keys(result).join(", ") || "none"})`);
    const logits = new Float32Array(result.logits_move.data);
    self.postMessage({ type: "result", id: message.id, logits: logits.buffer }, [logits.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", id: message.id, message: error?.message || String(error) });
  }
};
