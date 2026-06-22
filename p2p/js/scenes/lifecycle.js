/*
 * lifecycle.js — Capstone dashboard: §5.2–5.5 motions running side by side.
 *
 * Instead of one sequential storyline, this scene is a *compositor* that drives
 * the four chapter scenes simultaneously in a 2x2 grid, so the whole P2P layer
 * is visible at a glance:
 *   ┌─ §5.2 Discovery v5 ──┬─ §5.3 QUIC transport ─┐
 *   ├─ §5.4 Gossipsub ─────┴─ §5.5 Request-Resp ───┤
 *
 * Each cell reuses the original scene object unchanged. We give it a private
 * viewport (the cell minus a header strip), clip the canvas to that rectangle,
 * translate the origin, then call the scene's own update()/render(). A single
 * global clock (speed x dt) feeds every sub-scene, and a thin loop controller
 * restarts each motion when it finishes so the dashboard stays alive.
 */
"use strict";

(function registerLifecycle() {
  const { util, draw, colors } = P2P;

  const MARGIN = 8;
  const GAP = 8;
  const HEADER = 24; // title strip height reserved at the top of every cell

  // Loop cadence (simulated seconds) for the motions that do not self-repeat.
  const DISCOVERY_RESTART_DELAY = 1.6;
  const GOSSIP_PUBLISH_INTERVAL = 3.2;
  const REQRESP_RESTART_DELAY = 1.4;
  const QUIC_END = { hol: 5.6, rtt: 6.6 };

  const scene = {
    id: "lifecycle",
    title: "ダッシュボード",
    sectionRef: "5.2–5.5",
    descriptionHTML: `
      <p><b>P2P レイヤーの総まとめ。</b>5.2〜5.5 の4つのモーションを 2×2 グリッドで
      <b>同時に</b>動かし、章全体を一望できるダッシュボードにしたもの。各セルは個別タブと
      同じシミュレーションをそのまま流用している。</p>
      <ul style="padding-left:18px;margin:0 0 9px">
        <li><b>§5.2 Discovery v5(左上):</b> XOR 距離の漏斗状探索。収束すると自動で次の探索へ。</li>
        <li><b>§5.3 QUIC(右上):</b> HOL ブロッキングとハンドシェイク RTT を交互にループ再生。</li>
        <li><b>§5.4 Gossipsub(左下):</b> mesh への eager push と lazy pull。一定間隔で自動発行。</li>
        <li><b>§5.5 Request-Response(右下):</b> Status 交換 → BeaconBlocksByRange の同期シーケンス。</li>
      </ul>
      <p><b>操作:</b>「再生/一時停止」で全体を停止、速度スライダーは全モーション共通。
      各セルの中をクリックすると、そのモーションを直接操作できる
      (探索ノードの選択 / Gossip ブロック発行)。</p>
      <p>1つの仕組みをじっくり見たいときは、上部の個別タブ(Discovery / QUIC / …)へ。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    paused: false,
    speed: 1,
    entries: [],

    // loop controllers
    discoveryCooldown: 0,
    gossipTimer: 0,
    reqrespCooldown: 0,

    playButton: null,

    /* ------------------------- lifecycle ------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;

      this.entries = [
        { section: "5.2", name: "Discovery v5", scene: P2P.scenes.discovery },
        { section: "5.3", name: "QUIC", scene: P2P.scenes.quic },
        { section: "5.4", name: "Gossipsub", scene: P2P.scenes.gossipsub },
        { section: "5.5", name: "Request-Response", scene: P2P.scenes.reqresp },
      ];

      this.computeLayout();

      for (const entry of this.entries) {
        // Drive everything from the dashboard's single clock.
        if ("speed" in entry.scene) entry.scene.speed = 1;
        entry.scene.init({ width: entry.view.w, height: entry.view.h });
      }

      // Kick the motions that need an explicit start / autoplay.
      P2P.scenes.discovery.autoPlay = true;
      P2P.scenes.quic.view = "hol";
      P2P.scenes.reqresp.autoPlay = true;
      this.publishGossip();

      this.discoveryCooldown = 0;
      this.gossipTimer = 0;
      this.reqrespCooldown = 0;
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
      this.computeLayout();
      for (const entry of this.entries) {
        entry.scene.width = entry.view.w;
        entry.scene.height = entry.view.h;
        entry.scene.resize(entry.view.w, entry.view.h);
      }
    },

    /* ------------------------- layout ------------------------- */
    computeLayout() {
      const colWidth = (this.width - 2 * MARGIN - GAP) / 2;
      const rowHeight = (this.height - 2 * MARGIN - GAP) / 2;
      const cols = [MARGIN, MARGIN + colWidth + GAP];
      const rows = [MARGIN, MARGIN + rowHeight + GAP];
      // Grid order: TL, TR, BL, BR (matches the entries array).
      const positions = [
        [cols[0], rows[0]],
        [cols[1], rows[0]],
        [cols[0], rows[1]],
        [cols[1], rows[1]],
      ];
      this.entries.forEach((entry, index) => {
        const [x, y] = positions[index];
        entry.cell = { x, y, w: colWidth, h: rowHeight };
        entry.view = {
          x,
          y: y + HEADER,
          w: colWidth,
          h: rowHeight - HEADER,
        };
      });
    },

    /** Sub-scenes read this.width/height for layout — keep them cell-sized. */
    applyDims() {
      for (const entry of this.entries) {
        entry.scene.width = entry.view.w;
        entry.scene.height = entry.view.h;
      }
    },

    /* ------------------------- loop control ------------------------- */
    publishGossip() {
      const gossip = P2P.scenes.gossipsub;
      const alive = gossip.nodes.filter((node) => node.alive);
      if (alive.length) gossip.publishFrom(util.pickRandom(gossip.rng, alive).index);
    },

    driveLoops(dt) {
      const discovery = P2P.scenes.discovery;
      if (discovery.lookup && discovery.lookup.finished) {
        this.discoveryCooldown += dt;
        if (this.discoveryCooldown >= DISCOVERY_RESTART_DELAY) {
          discovery.startLookup();
          this.discoveryCooldown = 0;
        }
      } else {
        this.discoveryCooldown = 0;
      }

      const quic = P2P.scenes.quic;
      if (quic.clock >= QUIC_END[quic.view]) {
        quic.view = quic.view === "hol" ? "rtt" : "hol";
        quic.replay();
      }

      this.gossipTimer += dt;
      if (this.gossipTimer >= GOSSIP_PUBLISH_INTERVAL) {
        this.gossipTimer = 0;
        this.publishGossip();
      }

      const reqresp = P2P.scenes.reqresp;
      if (reqresp.clock >= reqresp.endTime) {
        this.reqrespCooldown += dt;
        if (this.reqrespCooldown >= REQRESP_RESTART_DELAY) {
          reqresp.build();
          this.reqrespCooldown = 0;
        }
      } else {
        this.reqrespCooldown = 0;
      }
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      this.applyDims();
      if (this.paused) return;
      const dt = realDt * this.speed;
      for (const entry of this.entries) entry.scene.update(dt);
      this.driveLoops(dt);
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.applyDims();
      for (const entry of this.entries) {
        const view = entry.view;
        ctx.save();
        ctx.beginPath();
        ctx.rect(view.x, view.y, view.w, view.h);
        ctx.clip();
        ctx.translate(view.x, view.y);
        entry.scene.render(ctx);
        ctx.restore();
        this.renderChrome(ctx, entry);
      }
    },

    renderChrome(ctx, entry) {
      const cell = entry.cell;
      // Cell border.
      ctx.save();
      draw.roundedRect(ctx, cell.x, cell.y, cell.w, cell.h, 10);
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // Header strip.
      ctx.save();
      draw.roundedRect(ctx, cell.x, cell.y, cell.w, HEADER, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.restore();
      draw.label(ctx, "§" + entry.section, cell.x + 12, cell.y + HEADER / 2, colors.accent, "bold 12px ui-monospace, monospace", "left");
      draw.label(ctx, entry.name, cell.x + 52, cell.y + HEADER / 2, colors.text, "12px ui-monospace, monospace", "left");
    },

    /* ------------------------- interaction ------------------------- */
    onMouse(type, x, y) {
      for (const entry of this.entries) {
        const view = entry.view;
        if (x < view.x || x > view.x + view.w || y < view.y || y > view.y + view.h) continue;
        if (entry.scene.onMouse) entry.scene.onMouse(type, x - view.x, y - view.y);
        return;
      }
    },

    /* ------------------------- stats ------------------------- */
    statOf(sceneObject, label) {
      const row = sceneObject.getStats().find((entry) => entry.label === label);
      return row ? row.value : "—";
    },

    getStats() {
      return [
        { label: "§5.2 探索ラウンド", value: this.statOf(P2P.scenes.discovery, "ラウンド (ホップ)") },
        { label: "§5.3 QUIC 配信", value: this.statOf(P2P.scenes.quic, "QUIC アプリ配信") },
        { label: "§5.4 到達ノード", value: this.statOf(P2P.scenes.gossipsub, "到達ノード") },
        { label: "§5.5 受信チャンク", value: this.statOf(P2P.scenes.reqresp, "受信チャンク") },
        { label: "再生", value: this.paused ? "一時停止" : "再生中" },
        { label: "速度", value: this.speed + "x" },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const playback = ui.group("再生");
      this.playButton = ui.button(this.paused ? "▶ 再生" : "⏸ 一時停止", () => {
        this.paused = !this.paused;
        this.playButton.textContent = this.paused ? "▶ 再生" : "⏸ 一時停止";
      }, "primary");
      playback.appendChild(this.playButton);
      playback.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (value) => (this.speed = value)));
      playback.appendChild(ui.button("全モーションをリスタート ↻", () => this.restartAll()));
      container.appendChild(playback);

      const actions = ui.group("個別操作");
      actions.appendChild(ui.button("§5.2 新しい探索", () => P2P.scenes.discovery.startLookup()));
      actions.appendChild(ui.button("§5.4 ブロックを発行", () => this.publishGossip()));
      actions.appendChild(ui.button("§5.5 シーケンス再生", () => P2P.scenes.reqresp.build()));
      container.appendChild(actions);
    },

    restartAll() {
      for (const entry of this.entries) {
        if ("speed" in entry.scene) entry.scene.speed = 1;
        entry.scene.init({ width: entry.view.w, height: entry.view.h });
      }
      P2P.scenes.discovery.autoPlay = true;
      P2P.scenes.quic.view = "hol";
      P2P.scenes.reqresp.autoPlay = true;
      this.publishGossip();
      this.discoveryCooldown = 0;
      this.gossipTimer = 0;
      this.reqrespCooldown = 0;
    },
  };

  P2P.scenes.lifecycle = scene;
})();
