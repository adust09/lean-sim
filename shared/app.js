/*
 * app.js — application shell.
 *
 * Owns the tab bar, the shared canvas (with device-pixel-ratio scaling), the
 * requestAnimationFrame loop, mouse forwarding, and the live stats panel. Each
 * scene registered on P2P.scenes implements a small interface:
 *   init(env), resize(w, h), update(dt), render(ctx), onMouse(type, x, y),
 *   getStats(), buildControls(container), and the metadata fields title /
 *   sectionRef / descriptionHTML.
 */
"use strict";

(function bootstrap() {
  // The host page declares which scenes to show, in order, via the global
  // P2P_SCENE_ORDER; falling back to every registered scene. This lets the
  // shared shell drive any topic app, not just the P2P one.
  const SCENE_ORDER = window.P2P_SCENE_ORDER || Object.keys(P2P.scenes);

  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const tabBar = document.getElementById("tabs");
  const controlsHost = document.getElementById("controls");
  const statsHost = document.getElementById("stats");
  const descriptionHost = document.getElementById("description");
  const sectionBadge = document.getElementById("section-badge");

  let logicalWidth = 0;
  let logicalHeight = 0;
  let devicePixelRatioValue = window.devicePixelRatio || 1;
  let activeScene = null;
  const initializedScenes = new Set();
  let statValueElements = [];

  /* ------------------------- canvas sizing ------------------------- */
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    logicalWidth = Math.max(320, Math.floor(rect.width));
    logicalHeight = Math.max(320, Math.floor(rect.height));
    devicePixelRatioValue = window.devicePixelRatio || 1;
    canvas.width = Math.floor(logicalWidth * devicePixelRatioValue);
    canvas.height = Math.floor(logicalHeight * devicePixelRatioValue);
    canvas.style.width = logicalWidth + "px";
    canvas.style.height = logicalHeight + "px";
    ctx.setTransform(devicePixelRatioValue, 0, 0, devicePixelRatioValue, 0, 0);
    if (activeScene) activeScene.resize(logicalWidth, logicalHeight);
  }

  /* ------------------------- stats panel ------------------------- */
  function buildStatsPanel(scene) {
    statsHost.innerHTML = "";
    statValueElements = [];
    for (const row of scene.getStats()) {
      const rowElement = document.createElement("div");
      rowElement.className = "stat-row";
      const labelElement = document.createElement("span");
      labelElement.className = "stat-label";
      labelElement.textContent = row.label;
      const valueElement = document.createElement("span");
      valueElement.className = "stat-value";
      valueElement.textContent = row.value;
      rowElement.appendChild(labelElement);
      rowElement.appendChild(valueElement);
      statsHost.appendChild(rowElement);
      statValueElements.push(valueElement);
    }
  }

  function updateStatsPanel(scene) {
    const rows = scene.getStats();
    if (rows.length !== statValueElements.length) {
      buildStatsPanel(scene);
      return;
    }
    rows.forEach((row, index) => {
      const text = String(row.value);
      if (statValueElements[index].textContent !== text) {
        statValueElements[index].textContent = text;
      }
    });
  }

  /* ------------------------- scene activation ------------------------- */
  function activateScene(sceneId) {
    const scene = P2P.scenes[sceneId];
    if (!scene) return;
    activeScene = scene;

    for (const button of tabBar.children) {
      button.classList.toggle("active", button.dataset.sceneId === sceneId);
    }

    if (!initializedScenes.has(sceneId)) {
      scene.init({ width: logicalWidth, height: logicalHeight });
      initializedScenes.add(sceneId);
    } else {
      scene.resize(logicalWidth, logicalHeight);
    }

    controlsHost.innerHTML = "";
    scene.buildControls(controlsHost);
    descriptionHost.innerHTML = scene.descriptionHTML;
    sectionBadge.textContent = scene.sectionRef;
    buildStatsPanel(scene);
  }

  /* ------------------------- tab bar ------------------------- */
  function buildTabs() {
    for (const sceneId of SCENE_ORDER) {
      const scene = P2P.scenes[sceneId];
      if (!scene) continue;
      const button = document.createElement("button");
      button.className = "tab";
      button.dataset.sceneId = sceneId;
      button.innerHTML =
        `<span class="tab-section">${scene.sectionRef}</span>` +
        `<span class="tab-title">${scene.title}</span>`;
      button.addEventListener("click", () => {
        window.location.hash = sceneId;
        activateScene(sceneId);
      });
      tabBar.appendChild(button);
    }
  }

  /* ------------------------- mouse forwarding ------------------------- */
  function forwardMouse(type, event) {
    if (!activeScene || !activeScene.onMouse) return;
    const rect = canvas.getBoundingClientRect();
    activeScene.onMouse(type, event.clientX - rect.left, event.clientY - rect.top);
  }
  canvas.addEventListener("mousemove", (event) => forwardMouse("move", event));
  canvas.addEventListener("click", (event) => forwardMouse("click", event));

  /* ------------------------- main loop ------------------------- */
  let lastTimestamp = 0;
  function frame(timestamp) {
    const dt = lastTimestamp ? Math.min(0.05, (timestamp - lastTimestamp) / 1000) : 0;
    lastTimestamp = timestamp;
    if (activeScene) {
      activeScene.update(dt);
      activeScene.render(ctx);
      updateStatsPanel(activeScene);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------- start ------------------------- */
  function sceneFromHash() {
    const fromHash = (window.location.hash || "").replace("#", "");
    return SCENE_ORDER.includes(fromHash) ? fromHash : SCENE_ORDER[0];
  }
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("hashchange", () => activateScene(sceneFromHash()));
  buildTabs();
  resizeCanvas();
  activateScene(sceneFromHash());
  requestAnimationFrame(frame);
})();
