/*
 * lifecycle.js — Capstone: one node's journey, network join → block production.
 *
 * A single end-to-end scenario you can take in at a glance. The top of the
 * screen is an always-visible stage pipeline (the bird's-eye overview):
 *
 *   ①発見 → ②接続 → ③同期 → ④購読 → ⑤ブロック生成
 *
 * The large panel below replays the *actual* §5.2–5.5 motion for whichever
 * stage is active, reusing the chapter scene objects unchanged: we clip the
 * canvas to the stage panel, translate the origin, and call that scene's own
 * update()/render(). The scenario advances automatically (each stage ends when
 * its motion completes) and loops, so the whole life of a node reads as one
 * continuous story rather than four separate demos.
 *
 * Stage → reused scene:
 *   ①発見  §5.2 Discovery v5      (discovery)
 *   ②接続  §5.3 QUIC 1-RTT        (quic, RTT view)
 *   ③同期  §5.5 Status + sync      (reqresp)
 *   ④購読  §5.4 GRAFT into mesh    (gossipsub, no block yet)
 *   ⑤生成  §5.4 publish + flood    (gossipsub, same network)
 */
"use strict";

(function registerLifecycle() {
  const { util, draw, colors } = P2P;

  const MARGIN = 10;
  const BAR_TOP = 14;
  const SEG_HEIGHT = 36;
  const NARRATION_HEIGHT = 24;
  const HEADER = 24; // stage-panel title strip
  const END_HOLD = 1.6; // pause on the final stage before looping

  const QUIC_RTT_END = 6.0;

  const STAGES = [
    {
      no: "①",
      label: "発見",
      section: "5.2",
      sceneKey: "discovery",
      narration: "起動直後の自ノードは孤立。Discovery v5 の XOR 探索で、同じチェーンを追うピアを見つける。",
      onEnter() {
        const scene = P2P.scenes.discovery;
        scene.autoPlay = true;
        scene.startLookup();
      },
      isDone(host) {
        return P2P.scenes.discovery.lookup.finished || host.stageTime > 9;
      },
    },
    {
      no: "②",
      label: "接続",
      section: "5.3",
      sceneKey: "quic",
      narration: "見つけたピアへ QUIC で接続。TLS を統合し 1-RTT(セッション再開なら 0-RTT)で即データを送れる。",
      onEnter() {
        const scene = P2P.scenes.quic;
        scene.view = "rtt";
        scene.replay();
      },
      isDone(host) {
        return P2P.scenes.quic.clock >= QUIC_RTT_END || host.stageTime > 8;
      },
    },
    {
      no: "③",
      label: "同期",
      section: "5.5",
      sceneKey: "reqresp",
      narration: "接続直後に Status を交換(fork digest ゲート)。相手が進んでいれば BeaconBlocksByRange で不足ブロックを取り寄せる。",
      onEnter() {
        const scene = P2P.scenes.reqresp;
        scene.autoPlay = true;
        scene.build();
      },
      isDone(host) {
        const scene = P2P.scenes.reqresp;
        return scene.clock >= scene.endTime || host.stageTime > 15;
      },
    },
    {
      no: "④",
      label: "購読",
      section: "5.4",
      sceneKey: "gossipsub",
      narration: "トピックを購読し GRAFT で mesh に参加。自ノードが各ピアへ順に GRAFT を送り mesh を組み上げる。",
      onEnter() {
        const gossip = P2P.scenes.gossipsub;
        gossip.clearMessage();
        const alive = gossip.nodes.filter((node) => node.alive);
        if (alive.length) gossip.subscribeJoin(util.pickRandom(gossip.rng, alive).index);
      },
      isDone(host) {
        return host.stageTime >= 5;
      },
    },
    {
      no: "⑤",
      label: "ブロック生成",
      section: "5.4",
      sceneKey: "gossipsub",
      narration: "一人前の参加者に。自ノードがブロックを発行し、eager push が mesh を伝って全体へ広がる。",
      onEnter() {
        const gossip = P2P.scenes.gossipsub;
        // Publish from the same node that subscribed in ④, so the story is one node.
        const self = gossip.nodes[gossip.selfIndex];
        if (self && self.alive) {
          gossip.publishFrom(gossip.selfIndex);
          return;
        }
        const alive = gossip.nodes.filter((node) => node.alive);
        if (alive.length) gossip.publishFrom(util.pickRandom(gossip.rng, alive).index);
      },
      isDone(host) {
        return host.stageTime >= 7;
      },
    },
  ];

  const scene = {
    id: "lifecycle",
    title: "ノードの一生",
    sectionRef: "5.2–5.5",
    descriptionHTML: `
      <p><b>1つのノードが Network に参加してからブロックを生成するまで</b>を、1本の
      シナリオとして俯瞰する総まとめ。上部のパイプラインが全行程、下の大パネルが
      現在の段階の実モーション(5.2〜5.5 の各タブと同じシミュレーション)。</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>発見 (§5.2):</b> Discovery v5 の XOR 探索でピアを見つける。</li>
        <li><b>接続 (§5.3):</b> QUIC で 1-RTT 接続。</li>
        <li><b>同期 (§5.5):</b> Status 交換 → BeaconBlocksByRange で不足ブロックを取得。</li>
        <li><b>購読 (§5.4):</b> GRAFT して gossip mesh に参加。</li>
        <li><b>ブロック生成 (§5.4):</b> ブロックを発行し mesh を伝播 → 全体へ。</li>
      </ol>
      <p>各段階はモーションが終わると自動で次へ進み、最後まで行くと最初へループする。
      「次のステージ ▶」で手動送り、「再生/一時停止」で全体を停止。
      下パネル内をクリックすると、その仕組みを直接操作できる。</p>
      <p>1つの仕組みをじっくり見たいときは、上部の個別タブ(Discovery / QUIC / …)へ。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    paused: false,
    speed: 1,
    index: 0,
    stageTime: 0,
    holding: false,
    holdTime: 0,
    activeKey: null,
    activeScene: null,
    cell: null,
    view: null,
    playButton: null,

    /* ------------------------- lifecycle ------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.computeLayout();
      this.enterStage(0);
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
      this.computeLayout();
      if (this.activeScene) {
        this.applyActiveDims();
        this.activeScene.resize(this.view.w, this.view.h);
      }
    },

    /* ------------------------- layout ------------------------- */
    computeLayout() {
      const barBottom = BAR_TOP + SEG_HEIGHT + NARRATION_HEIGHT;
      const x = MARGIN;
      const y = barBottom + 6;
      this.cell = { x, y, w: this.width - 2 * MARGIN, h: this.height - y - MARGIN };
      this.view = { x, y: y + HEADER, w: this.cell.w, h: this.cell.h - HEADER };
    },

    applyActiveDims() {
      if (!this.activeScene) return;
      this.activeScene.width = this.view.w;
      this.activeScene.height = this.view.h;
    },

    /* ------------------------- stage control ------------------------- */
    enterStage(index) {
      const previousKey = this.activeKey;
      this.index = index;
      this.stageTime = 0;
      this.holding = false;
      this.holdTime = 0;

      const stage = STAGES[index];
      const sceneObject = P2P.scenes[stage.sceneKey];
      this.activeScene = sceneObject;
      this.activeKey = stage.sceneKey;
      this.applyActiveDims();

      // Re-initialize only when the underlying scene changes, so consecutive
      // gossipsub stages (購読 → 生成) keep the same network and mesh.
      if (stage.sceneKey !== previousKey) {
        if ("speed" in sceneObject) sceneObject.speed = 1;
        sceneObject.init({ width: this.view.w, height: this.view.h });
      }
      stage.onEnter();
    },

    advance() {
      if (this.index >= STAGES.length - 1) {
        this.holding = true;
        this.holdTime = 0;
        return;
      }
      this.enterStage(this.index + 1);
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      this.applyActiveDims();
      if (this.paused) return;
      const dt = realDt * this.speed;

      if (this.holding) {
        this.activeScene.update(dt); // keep the final motion alive during the hold
        this.holdTime += dt;
        if (this.holdTime >= END_HOLD) this.enterStage(0);
        return;
      }

      this.activeScene.update(dt);
      this.stageTime += dt;
      if (STAGES[this.index].isDone(this)) this.advance();
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderPipeline(ctx);
      this.renderStagePanel(ctx);
    },

    renderPipeline(ctx) {
      const segmentWidth = (this.width - 2 * MARGIN) / STAGES.length;
      STAGES.forEach((stage, index) => {
        const x = MARGIN + index * segmentWidth;
        const done = this.holding || index < this.index;
        const active = !this.holding && index === this.index;
        const color = active ? colors.accent : done ? colors.nodeHasMessage : colors.textDim;

        ctx.save();
        draw.roundedRect(ctx, x + 4, BAR_TOP, segmentWidth - 8, SEG_HEIGHT, 8);
        ctx.fillStyle = active ? "#16263d" : "#121a27";
        ctx.fill();
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();

        const mark = done ? "✓ " : stage.no + " ";
        draw.label(ctx, mark + stage.label, x + segmentWidth / 2, BAR_TOP + 13, color, "13px ui-monospace, monospace");
        draw.label(ctx, "§" + stage.section, x + segmentWidth / 2, BAR_TOP + 27, colors.textDim, "10px ui-monospace, monospace");
        if (index < STAGES.length - 1) {
          draw.label(ctx, "→", x + segmentWidth - 2, BAR_TOP + 18, colors.textDim, "13px ui-monospace, monospace");
        }
      });

      const narration = this.holding
        ? "シナリオ完了 — 自ノードは稼働状態に。まもなく最初から再生。"
        : STAGES[this.index].narration;
      draw.label(ctx, narration, this.width / 2, BAR_TOP + SEG_HEIGHT + 14, colors.text, "12px ui-monospace, monospace");
    },

    renderStagePanel(ctx) {
      this.applyActiveDims();
      const view = this.view;
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.w, view.h);
      ctx.clip();
      ctx.translate(view.x, view.y);
      this.activeScene.render(ctx);
      ctx.restore();

      const cell = this.cell;
      const stage = STAGES[this.index];
      ctx.save();
      draw.roundedRect(ctx, cell.x, cell.y, cell.w, cell.h, 10);
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      draw.roundedRect(ctx, cell.x, cell.y, cell.w, HEADER, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.restore();
      draw.label(ctx, "§" + stage.section, cell.x + 12, cell.y + HEADER / 2, colors.accent, "bold 12px ui-monospace, monospace", "left");
      draw.label(ctx, `${stage.no} ${stage.label}`, cell.x + 56, cell.y + HEADER / 2, colors.text, "12px ui-monospace, monospace", "left");
    },

    /* ------------------------- interaction ------------------------- */
    onMouse(type, x, y) {
      const view = this.view;
      if (x < view.x || x > view.x + view.w || y < view.y || y > view.y + view.h) return;
      if (this.activeScene.onMouse) this.activeScene.onMouse(type, x - view.x, y - view.y);
    },

    /* ------------------------- stats ------------------------- */
    getStats() {
      const stage = STAGES[this.index];
      const status = this.paused ? "一時停止" : this.holding ? "完了 → ループ" : "再生中";
      const rows = [
        { label: "ステージ", value: `${this.index + 1}/${STAGES.length} ${stage.label}` },
        { label: "対象セクション", value: "§" + stage.section },
        { label: "状態", value: status },
      ];
      for (const row of this.activeScene.getStats().slice(0, 3)) rows.push(row);
      return rows;
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
      playback.appendChild(ui.button("次のステージ ▶", () => {
        if (this.holding) this.enterStage(0);
        else this.advance();
      }));
      playback.appendChild(ui.button("最初から ↻", () => this.enterStage(0)));
      playback.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (value) => (this.speed = value)));
      container.appendChild(playback);
    },
  };

  P2P.scenes.lifecycle = scene;
})();
