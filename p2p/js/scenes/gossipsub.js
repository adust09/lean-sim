/*
 * gossipsub.js — Section 5.4: Gossipsub scalable data propagation.
 *
 * Visualizes the hybrid push/pull design:
 *   - Eager push along the mesh (fast distribution tree).
 *   - Lazy pull (IHAVE -> IWANT -> data) as a redundancy safety net.
 *   - The heartbeat performing mesh maintenance (GRAFT / PRUNE).
 *   - Message deduplication dropping redundant copies.
 *
 * Click any node to publish a block from it and watch it flood the mesh.
 */
"use strict";

(function registerGossipsub() {
  const { util, draw, colors, ease } = P2P;

  const MARGIN = 46;
  const HEARTBEAT_INTERVAL = 0.7; // simulated seconds, per the spec (~700ms).
  const DATA_PIXELS_PER_SECOND = 240;
  const CONTROL_PIXELS_PER_SECOND = 420; // IHAVE / IWANT metadata travels light.
  const GRAFT_STAGGER = 0.6; // seconds between GRAFT emissions while a node subscribes.

  const scene = {
    id: "gossipsub",
    title: "Gossipsub 伝播",
    sectionRef: "5.4",
    descriptionHTML: `
      <p><b>問題:</b> 1つのブロックを数千ノードへ数秒で届けたい。全員が全部を転送すると
      帯域が溢れ、DHT のように1ホップずつ正確に配ると遅延が積み重なる。</p>
      <p><b>Gossipsub のハイブリッド解:</b></p>
      <ul>
        <li><b>Eager Push (mesh)</b>: 各ノードはトピックごとに少数の安定したピア集合
        =<i>mesh</i> を持ち、受信した本体を即座に mesh へ転送（緑の太い線）。高速な配信ツリー。</li>
        <li><b>Lazy Pull (gossip)</b>: mesh 外のランダムなピアへ <code>IHAVE</code>(ID一覧)だけ送り、
        取りこぼした相手が <code>IWANT</code> で本体を要求（紫→橙）。壊れた経路の保険。</li>
        <li><b>Heartbeat (~0.7s)</b>: 定期的に mesh サイズを点検。少なすぎ(&lt;D_low)なら
        <code>GRAFT</code> で勧誘、多すぎ(&gt;D_high)なら <code>PRUNE</code> で切り離す。</li>
        <li><b>重複排除</b>: 既に持つメッセージの2通目以降は破棄（赤の点滅）。</li>
      </ul>
      <p><b>操作のヒント:</b></p>
      <ul>
        <li>ノードをクリック → そこからブロックを発行。緑が mesh を伝って一気に広がる。</li>
        <li>発行後に「落ちたノードを復帰」→ 新規ノードはブロックを持たず、
        紫の <code>IHAVE</code>→橙の <code>IWANT</code> で後から回収される(lazy pull)。
        統計の「gossip 回収」が増える。</li>
        <li>「ノードを数回落とす」→ 隣接 mesh が D_low を下回り、heartbeat で
        <code>GRAFT</code> が補充する(統計の GRAFT)。</li>
        <li>lazy pull を OFF にして発行すると、mesh が切れた孤立ノードに届かない様子が見える。</li>
      </ul>
      <p><b>色凡例:</b><br>
      <span style="color:#36d399">●</span> mesh / eager push &nbsp;
      <span style="color:#a78bfa">●</span> IHAVE (gossip 広告) &nbsp;
      <span style="color:#f59e0b">●</span> IWANT (本体要求) &nbsp;
      <span style="color:#22d3ee">●</span> GRAFT &nbsp;
      <span style="color:#fb7185">●</span> PRUNE</p>`,

    /* ------------------------- state ------------------------- */
    nodes: [],
    particles: [],
    width: 0,
    height: 0,
    rng: null,
    seed: 1,
    simTime: 0,
    heartbeatTimer: 0,
    heartbeatPulse: 0,
    hoverIndex: -1,
    messageId: 0,
    publishTime: 0,
    lastReachTime: 0,

    // Lifecycle ④ subscribe state: the node we follow GRAFTing into the mesh.
    selfIndex: -1,
    graftQueue: [],
    graftTimer: 0,

    // tunables (driven by controls)
    nodeCount: 60,
    meshDegree: 4,
    speed: 1,
    showPeerLinks: true,
    lazyPullEnabled: true,

    // counters
    stats: null,

    /* ------------------------- lifecycle ------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.buildGraph();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    resetCounters() {
      this.stats = {
        eager: 0,
        gossip: 0,
        duplicates: 0,
        heartbeats: 0,
        grafts: 0,
        prunes: 0,
      };
    },

    /* ------------------------- graph construction ------------------------- */
    buildGraph() {
      this.rng = util.makeRng(this.seed * 2654435761);
      this.particles = [];
      this.simTime = 0;
      this.heartbeatTimer = 0;
      this.messageId = 0;
      this.publishTime = 0;
      this.lastReachTime = 0;
      this.resetCounters();
      this.selfIndex = -1;
      this.graftQueue = [];
      this.graftTimer = 0;

      const nodes = [];
      // Rejection sampling for roughly even spacing in normalized space.
      const minSeparation = 0.62 / Math.sqrt(this.nodeCount);
      let attempts = 0;
      while (nodes.length < this.nodeCount && attempts < this.nodeCount * 400) {
        attempts++;
        const nx = 0.04 + this.rng() * 0.92;
        const ny = 0.04 + this.rng() * 0.92;
        let tooClose = false;
        for (const other of nodes) {
          if (util.distance(nx, ny, other.nx, other.ny) < minSeparation) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          nodes.push({
            index: nodes.length,
            nx,
            ny,
            alive: true,
            hasMessage: false,
            receivedTime: -1,
            peers: [],
            mesh: new Set(),
          });
        }
      }
      this.nodes = nodes;
      this.buildPeerLinks();
      this.buildMesh();
    },

    /** Connect each node to its nearest neighbors (a clean proximity graph). */
    buildPeerLinks() {
      const peerTarget = Math.max(6, this.meshDegree + 4);
      for (const node of this.nodes) {
        const ranked = this.nodes
          .filter((other) => other !== node)
          .map((other) => ({
            other,
            d: util.distance(node.nx, node.ny, other.nx, other.ny),
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, peerTarget);
        for (const { other } of ranked) {
          if (!node.peers.includes(other.index)) node.peers.push(other.index);
          if (!other.peers.includes(node.index)) other.peers.push(node.index);
        }
      }
    },

    /** Greedily form a symmetric mesh near the target degree D. */
    buildMesh() {
      for (const node of this.nodes) node.mesh.clear();
      const order = util.shuffleInPlace(this.rng, [...this.nodes]);
      for (const node of order) {
        if (!node.alive) continue;
        const candidates = util.shuffleInPlace(this.rng, [...node.peers]);
        for (const peerIndex of candidates) {
          if (node.mesh.size >= this.meshDegree) break;
          const peer = this.nodes[peerIndex];
          if (!peer.alive) continue;
          if (peer.mesh.size >= this.dHigh) continue;
          node.mesh.add(peerIndex);
          peer.mesh.add(node.index);
        }
      }
    },

    // Mesh degree bounds follow the mainnet ratio (D=8, D_low=6, D_high=12).
    get dLow() {
      return Math.max(2, Math.round(this.meshDegree * 0.75));
    },
    get dHigh() {
      return Math.round(this.meshDegree * 1.5);
    },

    /* ------------------------- geometry helpers ------------------------- */
    pixelX(node) {
      return MARGIN + node.nx * (this.width - 2 * MARGIN);
    },
    pixelY(node) {
      return MARGIN + node.ny * (this.height - 2 * MARGIN);
    },
    nodeRadius() {
      return util.clamp(220 / Math.sqrt(this.nodeCount), 7, 16);
    },

    /* ------------------------- propagation ------------------------- */
    publishFrom(sourceIndex) {
      const source = this.nodes[sourceIndex];
      if (!source || !source.alive) return;
      // Fresh message: clear prior propagation but keep the topology/mesh.
      for (const node of this.nodes) {
        node.hasMessage = false;
        node.receivedTime = -1;
      }
      this.particles = this.particles.filter((p) => p.type === "graft" || p.type === "prune");
      this.resetCounters();
      this.messageId++;
      this.publishTime = this.simTime;
      this.lastReachTime = this.simTime;
      source.hasMessage = true;
      source.receivedTime = this.simTime;
      source.isSource = true;
      for (const node of this.nodes) if (node !== source) node.isSource = false;
      this.eagerForward(sourceIndex, -1);
    },

    eagerForward(fromIndex, excludeIndex) {
      const from = this.nodes[fromIndex];
      for (const meshIndex of from.mesh) {
        if (meshIndex === excludeIndex) continue;
        const target = this.nodes[meshIndex];
        if (!target || !target.alive) continue;
        this.spawnParticle(fromIndex, meshIndex, "data", () =>
          this.receiveMessage(meshIndex, fromIndex, "eager"),
        );
      }
    },

    receiveMessage(nodeIndex, viaIndex, channel) {
      const node = this.nodes[nodeIndex];
      if (!node || !node.alive) return;
      if (node.hasMessage) {
        this.stats.duplicates++;
        node.dupFlash = this.simTime;
        return;
      }
      node.hasMessage = true;
      node.receivedTime = this.simTime;
      this.lastReachTime = this.simTime;
      if (channel === "eager") this.stats.eager++;
      else this.stats.gossip++;
      // A freshly informed node eagerly pushes onward (minus the sender).
      this.eagerForward(nodeIndex, viaIndex);
    },

    spawnParticle(fromIndex, toIndex, type, onArrive) {
      const from = this.nodes[fromIndex];
      const to = this.nodes[toIndex];
      const pixelDistance = util.distance(
        this.pixelX(from),
        this.pixelY(from),
        this.pixelX(to),
        this.pixelY(to),
      );
      const pixelsPerSecond =
        type === "data" ? DATA_PIXELS_PER_SECOND : CONTROL_PIXELS_PER_SECOND;
      this.particles.push({
        fromIndex,
        toIndex,
        type,
        t: 0,
        duration: Math.max(0.18, pixelDistance / pixelsPerSecond),
        onArrive,
      });
    },

    /* ------------------------- heartbeat ------------------------- */
    runHeartbeat() {
      this.stats.heartbeats++;
      this.heartbeatPulse = 1;
      this.meshMaintenance();
      if (this.lazyPullEnabled) this.emitGossip();
    },

    meshMaintenance() {
      for (const node of this.nodes) {
        if (!node.alive) continue;
        if (node.subscribing) continue; // joins via its own staggered GRAFT
        // Recruitment: mesh too small -> GRAFT new peers.
        if (node.mesh.size < this.dLow) {
          const options = util.shuffleInPlace(
            this.rng,
            node.peers.filter((peerIndex) => {
              const peer = this.nodes[peerIndex];
              return peer.alive && !node.mesh.has(peerIndex) && peer.mesh.size < this.dHigh;
            }),
          );
          for (const peerIndex of options) {
            if (node.mesh.size >= this.meshDegree) break;
            const peer = this.nodes[peerIndex];
            node.mesh.add(peerIndex);
            peer.mesh.add(node.index);
            this.stats.grafts++;
            this.spawnParticle(node.index, peerIndex, "graft", null);
          }
        }
        // Trimming: mesh too large -> PRUNE excess peers.
        if (node.mesh.size > this.dHigh) {
          const excess = [...node.mesh];
          util.shuffleInPlace(this.rng, excess);
          while (node.mesh.size > this.meshDegree && excess.length) {
            const peerIndex = excess.pop();
            const peer = this.nodes[peerIndex];
            node.mesh.delete(peerIndex);
            peer.mesh.delete(node.index);
            this.stats.prunes++;
            this.spawnParticle(node.index, peerIndex, "prune", null);
          }
        }
      }
    },

    /** Each informed node advertises IHAVE to a random non-mesh peer. */
    emitGossip() {
      if (this.messageId === 0) return;
      for (const node of this.nodes) {
        if (!node.alive || !node.hasMessage) continue;
        const gossipTargets = node.peers.filter((peerIndex) => {
          const peer = this.nodes[peerIndex];
          return peer.alive && !node.mesh.has(peerIndex);
        });
        if (!gossipTargets.length) continue;
        const targetIndex = util.pickRandom(this.rng, gossipTargets);
        this.spawnParticle(node.index, targetIndex, "ihave", () =>
          this.handleIHave(targetIndex, node.index),
        );
      }
    },

    handleIHave(receiverIndex, senderIndex) {
      const receiver = this.nodes[receiverIndex];
      if (!receiver || !receiver.alive || receiver.hasMessage) return;
      // Missing the message -> ask for it explicitly with IWANT.
      this.spawnParticle(receiverIndex, senderIndex, "iwant", () =>
        this.handleIWant(senderIndex, receiverIndex),
      );
    },

    handleIWant(senderIndex, requesterIndex) {
      const sender = this.nodes[senderIndex];
      if (!sender || !sender.alive || !sender.hasMessage) return;
      this.spawnParticle(senderIndex, requesterIndex, "data", () =>
        this.receiveMessage(requesterIndex, senderIndex, "gossip"),
      );
    },

    /* ------------------------- fault injection ------------------------- */
    killRandomNode() {
      const alive = this.nodes.filter((node) => node.alive && !node.isSource);
      if (!alive.length) return;
      const victim = util.pickRandom(this.rng, alive);
      victim.alive = false;
      victim.hasMessage = false;
      for (const meshIndex of victim.mesh) this.nodes[meshIndex].mesh.delete(victim.index);
      victim.mesh.clear();
    },

    reviveAndJoin() {
      const dead = this.nodes.filter((node) => !node.alive);
      if (dead.length) {
        const node = util.pickRandom(this.rng, dead);
        node.alive = true;
        node.hasMessage = false;
        node.receivedTime = -1;
        return;
      }
    },

    clearMessage() {
      for (const node of this.nodes) {
        node.hasMessage = false;
        node.receivedTime = -1;
        node.isSource = false;
        node.subscribing = false;
      }
      this.particles = [];
      this.messageId = 0;
      this.graftQueue = [];
      this.resetCounters();
    },

    /* ------------------------- subscribe (GRAFT into mesh) ------------------------- */
    /**
     * Lifecycle ④ (購読): a node subscribes to the topic and GRAFTs into the
     * mesh. We empty its mesh so the join is visible, then GRAFT toward eligible
     * peers one at a time (staggered in update) — the mesh forms edge by edge
     * instead of appearing fully wired, which is what makes the stage move.
     */
    subscribeJoin(nodeIndex) {
      const node = this.nodes[nodeIndex];
      if (!node || !node.alive) return;
      this.selfIndex = nodeIndex;
      for (const meshIndex of node.mesh) this.nodes[meshIndex].mesh.delete(nodeIndex);
      node.mesh.clear();
      node.subscribing = true;
      node.subscribeTime = this.simTime;
      this.graftQueue = util.shuffleInPlace(
        this.rng,
        node.peers.filter((peerIndex) => this.nodes[peerIndex].alive),
      );
      this.graftTimer = 0;
    },

    /** Emit the next staggered GRAFT from the subscribing node into the mesh. */
    emitSubscribeGraft() {
      const node = this.nodes[this.selfIndex];
      if (!node || !node.alive || node.mesh.size >= this.meshDegree) {
        this.graftQueue = [];
        return;
      }
      while (this.graftQueue.length) {
        const peerIndex = this.graftQueue.shift();
        const peer = this.nodes[peerIndex];
        if (!peer || !peer.alive || node.mesh.has(peerIndex) || peer.mesh.size >= this.dHigh) {
          continue;
        }
        node.mesh.add(peerIndex);
        peer.mesh.add(node.index);
        this.stats.grafts++;
        // GRAFT out, and the peer GRAFTs back — mesh membership is bidirectional.
        this.spawnParticle(node.index, peerIndex, "graft", null);
        this.spawnParticle(peerIndex, node.index, "graft", null);
        return;
      }
    },

    /** Drain the subscribe GRAFT queue, one emission per GRAFT_STAGGER. */
    advanceSubscribe(dt) {
      if (this.selfIndex < 0 || !this.graftQueue.length) return;
      this.graftTimer += dt;
      while (this.graftTimer >= GRAFT_STAGGER && this.graftQueue.length) {
        this.graftTimer -= GRAFT_STAGGER;
        this.emitSubscribeGraft();
      }
      if (!this.graftQueue.length) {
        const self = this.nodes[this.selfIndex];
        if (self) self.subscribing = false;
      }
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      const dt = realDt * this.speed;
      this.simTime += dt;
      this.heartbeatPulse = Math.max(0, this.heartbeatPulse - realDt * 2.4);

      this.heartbeatTimer += dt;
      while (this.heartbeatTimer >= HEARTBEAT_INTERVAL) {
        this.heartbeatTimer -= HEARTBEAT_INTERVAL;
        this.runHeartbeat();
      }
      this.advanceSubscribe(dt);

      const survivors = [];
      for (const particle of this.particles) {
        particle.t += dt / particle.duration;
        if (particle.t >= 1) {
          if (particle.onArrive) particle.onArrive();
        } else {
          survivors.push(particle);
        }
      }
      this.particles = survivors;
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);

      // Peer (gossip-eligible) links, drawn faint.
      if (this.showPeerLinks) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = colors.peerEdge;
        ctx.beginPath();
        for (const node of this.nodes) {
          for (const peerIndex of node.peers) {
            if (peerIndex <= node.index) continue;
            const peer = this.nodes[peerIndex];
            if (node.mesh.has(peerIndex)) continue;
            ctx.moveTo(this.pixelX(node), this.pixelY(node));
            ctx.lineTo(this.pixelX(peer), this.pixelY(peer));
          }
        }
        ctx.stroke();
      }

      // Mesh links, drawn bright (the eager-push overlay).
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = colors.meshEdge;
      ctx.beginPath();
      for (const node of this.nodes) {
        if (!node.alive) continue;
        for (const meshIndex of node.mesh) {
          if (meshIndex <= node.index) continue;
          const peer = this.nodes[meshIndex];
          if (!peer.alive) continue;
          ctx.moveTo(this.pixelX(node), this.pixelY(node));
          ctx.lineTo(this.pixelX(peer), this.pixelY(peer));
        }
      }
      ctx.stroke();

      this.renderHoverHighlight(ctx);
      this.renderParticles(ctx);
      this.renderNodes(ctx);
      this.renderLegend(ctx);
    },

    renderHoverHighlight(ctx) {
      if (this.hoverIndex < 0) return;
      const node = this.nodes[this.hoverIndex];
      if (!node || !node.alive) return;
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = colors.nodeActive;
      ctx.beginPath();
      for (const meshIndex of node.mesh) {
        const peer = this.nodes[meshIndex];
        ctx.moveTo(this.pixelX(node), this.pixelY(node));
        ctx.lineTo(this.pixelX(peer), this.pixelY(peer));
      }
      ctx.stroke();
    },

    renderParticles(ctx) {
      for (const particle of this.particles) {
        const from = this.nodes[particle.fromIndex];
        const to = this.nodes[particle.toIndex];
        const eased = ease.outCubic(util.clamp(particle.t, 0, 1));
        const x = util.lerp(this.pixelX(from), this.pixelX(to), eased);
        const y = util.lerp(this.pixelY(from), this.pixelY(to), eased);
        if (particle.type === "data") {
          draw.disc(ctx, x, y, 4.5, colors.data, null);
          draw.glow(ctx, x, y, 11, colors.data);
        } else if (particle.type === "ihave") {
          draw.line(ctx, this.pixelX(from), this.pixelY(from), x, y, colors.ihave, 1.4, true);
          draw.disc(ctx, x, y, 3, colors.ihave, null);
        } else if (particle.type === "iwant") {
          draw.line(ctx, this.pixelX(from), this.pixelY(from), x, y, colors.iwant, 1.4, true);
          draw.disc(ctx, x, y, 3, colors.iwant, null);
        } else if (particle.type === "graft") {
          draw.line(ctx, this.pixelX(from), this.pixelY(from), x, y, colors.graft, 1.6, true);
          draw.disc(ctx, x, y, 3.5, colors.graft, null);
        } else if (particle.type === "prune") {
          draw.line(ctx, this.pixelX(from), this.pixelY(from), x, y, colors.prune, 1.6, true);
          draw.disc(ctx, x, y, 3.5, colors.prune, null);
        }
      }
    },

    renderNodes(ctx) {
      const radius = this.nodeRadius();
      for (const node of this.nodes) {
        const x = this.pixelX(node);
        const y = this.pixelY(node);
        if (!node.alive) {
          draw.disc(ctx, x, y, radius * 0.8, colors.nodeDead, "#4a3340", 1);
          continue;
        }
        // Recently-received pulse (blue) fading to settled (green).
        const age = node.receivedTime >= 0 ? this.simTime - node.receivedTime : Infinity;
        if (age < 0.5) draw.glow(ctx, x, y, radius * 2.4, colors.nodeActive);
        // Duplicate-drop flash (red) ring.
        if (node.dupFlash !== undefined && this.simTime - node.dupFlash < 0.4) {
          draw.disc(ctx, x, y, radius + 4, null, colors.prune, 2);
        }
        // Lifecycle ④: the node we follow subscribing — pulsing GRAFT highlight.
        if (node.index === this.selfIndex && this.messageId === 0) {
          const pulse = 0.5 + 0.5 * Math.sin(this.simTime * 6);
          draw.glow(ctx, x, y, radius * (2.2 + pulse), colors.graft);
          draw.disc(ctx, x, y, radius + 5, null, colors.graft, 2);
          draw.label(ctx, "購読 GRAFT", x, y - radius - 11, colors.graft, "11px ui-monospace, monospace");
        }
        let fill = colors.node;
        if (node.isSource) fill = colors.nodeSource;
        else if (node.hasMessage) fill = age < 0.5 ? colors.nodeActive : colors.nodeHasMessage;
        draw.disc(ctx, x, y, radius, fill, colors.nodeStroke, 1.4);
        if (node.isSource) draw.disc(ctx, x, y, radius + 4, null, colors.nodeSource, 2);
      }
    },

    renderLegend(ctx) {
      const beat = this.heartbeatPulse > 0.01 ? "● heartbeat" : "○ heartbeat";
      draw.label(
        ctx,
        beat,
        this.width - 16,
        24,
        this.heartbeatPulse > 0.01 ? colors.accent : colors.textDim,
        "12px ui-monospace, monospace",
        "right",
      );
    },

    /* ------------------------- interaction ------------------------- */
    nodeAt(x, y) {
      const radius = this.nodeRadius() + 4;
      for (const node of this.nodes) {
        if (!node.alive) continue;
        if (util.distance(x, y, this.pixelX(node), this.pixelY(node)) <= radius) {
          return node.index;
        }
      }
      return -1;
    },

    onMouse(type, x, y) {
      if (type === "move") {
        this.hoverIndex = this.nodeAt(x, y);
      } else if (type === "click") {
        const index = this.nodeAt(x, y);
        if (index >= 0) this.publishFrom(index);
      }
    },

    /* ------------------------- stats ------------------------- */
    getStats() {
      const aliveCount = this.nodes.filter((n) => n.alive).length;
      const reached = this.nodes.filter((n) => n.alive && n.hasMessage).length;
      const propagationMs =
        this.messageId > 0 ? Math.round((this.lastReachTime - this.publishTime) * 1000) : 0;
      const reachPct = aliveCount ? Math.round((reached / aliveCount) * 100) : 0;
      return [
        { label: "到達ノード", value: `${reached} / ${aliveCount} (${reachPct}%)` },
        { label: "伝播時間", value: `${propagationMs} ms` },
        { label: "eager push 配信", value: this.stats.eager },
        { label: "gossip 回収 (IWANT)", value: this.stats.gossip },
        { label: "重複ドロップ", value: this.stats.duplicates },
        { label: "heartbeat", value: this.stats.heartbeats },
        { label: "GRAFT / PRUNE", value: `${this.stats.grafts} / ${this.stats.prunes}` },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const actions = ui.group("操作");
      actions.appendChild(
        ui.button("ブロックを発行 (ランダム)", () => {
          const alive = this.nodes.filter((n) => n.alive);
          if (alive.length) this.publishFrom(util.pickRandom(this.rng, alive).index);
        }, "primary"),
      );
      actions.appendChild(ui.button("メッセージをクリア", () => this.clearMessage()));
      actions.appendChild(ui.button("ノードを1つ落とす", () => this.killRandomNode(), "danger"));
      actions.appendChild(ui.button("落ちたノードを復帰", () => this.reviveAndJoin()));
      actions.appendChild(
        ui.button("再構築 (新しい網)", () => {
          this.seed++;
          this.buildGraph();
        }),
      );
      container.appendChild(actions);

      const params = ui.group("パラメータ");
      params.appendChild(
        ui.slider("ノード数", 20, 120, 5, this.nodeCount, (value) => {
          this.nodeCount = value;
          this.buildGraph();
        }),
      );
      params.appendChild(
        ui.slider("mesh 次数 D", 3, 8, 1, this.meshDegree, (value) => {
          this.meshDegree = value;
          this.buildMesh();
        }),
      );
      params.appendChild(
        ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (value) => {
          this.speed = value;
        }),
      );
      container.appendChild(params);

      const toggles = ui.group("表示 / 挙動");
      toggles.appendChild(
        ui.toggle("ピア接続(mesh外)を表示", this.showPeerLinks, (v) => (this.showPeerLinks = v)),
      );
      toggles.appendChild(
        ui.toggle("lazy pull (gossip) を有効化", this.lazyPullEnabled, (v) => (this.lazyPullEnabled = v)),
      );
      container.appendChild(toggles);
    },
  };

  P2P.scenes.gossipsub = scene;
})();
