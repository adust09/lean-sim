/*
 * lifecycle.js — Capstone: a node's full P2P lifecycle under one scenario.
 *
 * Ties the whole chapter together by following one joining node (the gold
 * protagonist) through the complete sequence:
 *   1. Discover   (§5.2) — find peers; filter by eth2 fork digest.
 *   2. Connect    (§5.3) — open QUIC connections to same-fork peers.
 *   3. Handshake  (§5.3/§5.5) — TLS + Status (fork gate, head compare).
 *   4. Sync       (§5.5) — pull missing blocks via BeaconBlocksByRange.
 *   5. Subscribe  (§5.4) — GRAFT into the gossip mesh for the topic.
 *   6. Operate    (§5.4) — steady state: blocks propagate each slot.
 *
 * Scenarios change network conditions; the topic decides who subscribes.
 */
"use strict";

(function registerLifecycle() {
  const { util, draw, colors } = P2P;

  const PEER_SLOTS = 8; // max outbound connections the protagonist keeps
  const MESH_D = 4;
  const SLOT_DURATION = 2.2; // seconds per slot in steady state
  const HEARTBEAT = 0.7;
  const NETWORK_HEAD = 1006;
  const SYNC_GAP = 6; // how many slots the joining node starts behind

  const PHASES = [
    { key: "discover", label: "発見", section: "5.2" },
    { key: "connect", label: "接続", section: "5.3" },
    { key: "handshake", label: "ハンドシェイク", section: "5.3/5.5" },
    { key: "sync", label: "同期", section: "5.5" },
    { key: "subscribe", label: "購読/GRAFT", section: "5.4" },
    { key: "operate", label: "稼働", section: "5.4" },
  ];
  const PHASE_DURATION = {
    discover: 3.2,
    connect: 2.6,
    handshake: 2.6,
    sync: 3.6,
    subscribe: 2.6,
    operate: Infinity,
  };
  const PHASE_NARRATION = {
    discover: "起動直後は孤立。Discovery v5 でピアを探し、eth2 fork digest が一致する相手だけを残す。",
    connect: "同じフォークのピアから数本を選び、QUIC 接続(1-RTT)を確立する。",
    handshake: "TLS で鍵共有し、Status を交換。fork digest が一致し、head の進んだピアを同期元に選ぶ。",
    sync: "自分の head は遅れている。BeaconBlocksByRange で不足ブロックを取り寄せ、parent_root で連結。",
    subscribe: "トピックを購読し GRAFT して mesh に参加。これで eager push を受け取れる。",
    operate: "一人前の参加者に。スロット毎に誰かがブロックを発行し、mesh を伝って全体へ広がる。",
  };

  const scene = {
    id: "lifecycle",
    title: "ライフサイクル",
    sectionRef: "5.1–5.5",
    descriptionHTML: `
      <p><b>章全体を1本のシナリオで横断する総まとめ。</b>金色の「新規ノード」が、
      ネットワークに参加して稼働するまでの一生を順に辿る:</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>発見 (§5.2):</b> 孤立状態から Discovery でピアを探索。
        <code>eth2</code> fork digest が違う相手(灰色 ✗)は除外。</li>
        <li><b>接続 (§5.3):</b> 同じフォークのピアへ QUIC 接続を確立(ピアスロット ${PEER_SLOTS})。</li>
        <li><b>ハンドシェイク (§5.3/§5.5):</b> TLS で鍵共有 + Status 交換。
        head の進んだピアを同期元に選ぶ。</li>
        <li><b>同期 (§5.5):</b> 遅れている分のブロックを <code>BeaconBlocksByRange</code> で取得。</li>
        <li><b>購読/GRAFT (§5.4):</b> トピックを購読し mesh に参加。</li>
        <li><b>稼働 (§5.4):</b> スロット毎にブロックが発行され、mesh を伝播。heartbeat が mesh を維持。</li>
      </ol>
      <p><b>シナリオ:</b> 正常参加 / フォーク混在(別チェーンのピアが除外される) /
      高チャーン(稼働中にピアが頻繁に出入りし GRAFT/PRUNE と lazy pull が働く)。</p>
      <p><b>トピック:</b> <code>beacon_block</code>(全員購読) /
      <code>attestation subnet</code>(一部だけ購読 — subnet bitfield の世界)。</p>
      <p><b>操作:</b>「再生」で自動進行、「次のフェーズ ▶」で1段ずつ。稼働中は
      「自ノードを離脱」でノード退場 → 隣接ピアが GRAFT で穴を埋める。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    rng: null,
    seed: 3,
    nodes: [],
    particles: [],
    phaseIndex: 0,
    phaseTime: 0,
    auto: true,
    speed: 1,
    scenario: "normal", // normal | fork | churn
    topic: "block", // block | subnet
    peerCount: 34,

    // precomputed lifecycle targets
    connectTargets: [],
    meshTargets: [],
    syncSourceIndex: -1,

    // operate-phase state
    slotTimer: 0,
    heartbeatTimer: 0,
    churnTimer: 0,
    headCounter: NETWORK_HEAD,
    currentBlockId: 0,
    blocksProduced: 0,
    lastReach: 0,
    stats: { grafts: 0, prunes: 0, dups: 0, gossip: 0, beats: 0 },

    scenarioButtons: [],
    topicButtons: [],

    /* ------------------------- lifecycle ------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.build();
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    get protagonist() {
      return this.nodes[0];
    },
    get phaseKey() {
      return PHASES[this.phaseIndex].key;
    },

    /* ------------------------- build ------------------------- */
    build() {
      this.rng = util.makeRng(this.seed * 99991 + this.scenario.length * 7 + this.topic.length);
      this.particles = [];
      this.phaseIndex = 0;
      this.phaseTime = 0;
      this.headCounter = NETWORK_HEAD;
      this.blocksProduced = 0;
      this.currentBlockId = 0;
      this.lastReach = 0;
      this.stats = { grafts: 0, prunes: 0, dups: 0, gossip: 0, beats: 0 };

      const nodes = [];
      // Protagonist: joins from the left, on the correct fork, behind on head.
      nodes.push({
        index: 0,
        nx: 0.13,
        ny: 0.5,
        isProtagonist: true,
        forkOk: true,
        head: NETWORK_HEAD - SYNC_GAP,
        subscribed: false,
        online: true,
        mesh: new Set(),
        hasBlock: false,
      });

      // Peers clustered on the right.
      const wrongForkRatio = this.scenario === "fork" ? 0.3 : 0;
      const subnetSubscribeRatio = 0.45;
      let attempts = 0;
      while (nodes.length < this.peerCount + 1 && attempts < this.peerCount * 400) {
        attempts++;
        const angle = this.rng() * Math.PI * 2;
        const radius = Math.sqrt(this.rng()) * 0.32;
        const nx = 0.62 + Math.cos(angle) * radius;
        const ny = 0.5 + Math.sin(angle) * radius * 1.1;
        let tooClose = false;
        for (const other of nodes) {
          if (util.distance(nx, ny, other.nx, other.ny) < 0.6 / Math.sqrt(this.peerCount)) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        const forkOk = this.rng() >= wrongForkRatio;
        const subscribed =
          forkOk && (this.topic === "block" ? true : this.rng() < subnetSubscribeRatio);
        nodes.push({
          index: nodes.length,
          nx,
          ny,
          isProtagonist: false,
          forkOk,
          head: this.rng() < 0.2 ? NETWORK_HEAD - 1 : NETWORK_HEAD,
          subscribed,
          online: true,
          mesh: new Set(),
          hasBlock: false,
        });
      }
      this.nodes = nodes;
      this.precomputeTargets();
    },

    /** Deterministically decide who the protagonist connects to / meshes with. */
    precomputeTargets() {
      const protagonist = this.protagonist;
      const eligible = this.nodes
        .filter((node) => !node.isProtagonist && node.forkOk)
        .sort(
          (a, b) =>
            util.distance(protagonist.nx, protagonist.ny, a.nx, a.ny) -
            util.distance(protagonist.nx, protagonist.ny, b.nx, b.ny),
        );
      this.connectTargets = eligible.slice(0, PEER_SLOTS).map((node) => node.index);
      this.meshTargets = this.connectTargets
        .filter((index) => this.nodes[index].subscribed)
        .slice(0, MESH_D);
      // Sync source: connected peer with the greatest head.
      let bestHead = -1;
      this.syncSourceIndex = -1;
      for (const index of this.connectTargets) {
        if (this.nodes[index].head > bestHead) {
          bestHead = this.nodes[index].head;
          this.syncSourceIndex = index;
        }
      }
    },

    /* ------------------------- phase progression ------------------------- */
    phaseProgress() {
      const duration = PHASE_DURATION[this.phaseKey];
      return duration === Infinity ? 1 : util.clamp(this.phaseTime / duration, 0, 1);
    },

    advancePhase() {
      if (this.phaseIndex >= PHASES.length - 1) return;
      this.phaseIndex++;
      this.phaseTime = 0;
      if (this.phaseKey === "operate") this.enterOperate();
    },

    nextPhase() {
      this.auto = false;
      if (this.phaseKey === "operate") return;
      // Finalize current phase visuals, then advance.
      this.phaseTime = PHASE_DURATION[this.phaseKey];
      this.advancePhase();
    },

    /* Reveal counts derived purely from phase + progress (declarative). */
    discoveredCount() {
      const peers = this.nodes.length - 1;
      if (this.phaseIndex > 0) return peers;
      return Math.floor(this.phaseProgress() * peers);
    },
    connectionCount() {
      if (this.phaseIndex > 1) return this.connectTargets.length;
      if (this.phaseKey === "connect") return Math.floor(this.phaseProgress() * this.connectTargets.length + 0.0001);
      return 0;
    },
    handshakeCount() {
      if (this.phaseIndex > 2) return this.connectTargets.length;
      if (this.phaseKey === "handshake") return Math.floor(this.phaseProgress() * this.connectTargets.length + 0.0001);
      return 0;
    },
    syncProgress() {
      if (this.phaseIndex > 3) return 1;
      if (this.phaseKey === "sync") return this.phaseProgress();
      return 0;
    },
    meshCount() {
      if (this.phaseIndex > 4) return this.meshTargets.length;
      if (this.phaseKey === "subscribe") return Math.floor(this.phaseProgress() * this.meshTargets.length + 0.0001);
      return 0;
    },

    /* ------------------------- operate steady state ------------------------- */
    enterOperate() {
      this.protagonist.subscribed = true;
      this.protagonist.head = this.headCounter;
      this.buildSubscriberMesh();
      this.slotTimer = SLOT_DURATION * 0.5;
      this.heartbeatTimer = 0;
      this.churnTimer = 0;
    },

    subscribers() {
      return this.nodes.filter((node) => node.subscribed && node.online);
    },

    /** Build a connected mesh among all online subscribers (incl. protagonist). */
    buildSubscriberMesh() {
      const subs = this.subscribers();
      for (const node of subs) node.mesh.clear();
      for (const node of subs) {
        const nearest = subs
          .filter((other) => other !== node)
          .sort(
            (a, b) =>
              util.distance(node.nx, node.ny, a.nx, a.ny) -
              util.distance(node.nx, node.ny, b.nx, b.ny),
          );
        for (const other of nearest) {
          if (node.mesh.size >= MESH_D) break;
          if (other.mesh.size >= Math.round(MESH_D * 1.5)) continue;
          node.mesh.add(other.index);
          other.mesh.add(node.index);
        }
      }
    },

    publishSlot() {
      const subs = this.subscribers();
      if (!subs.length) return;
      const proposer = util.pickRandom(this.rng, subs);
      this.currentBlockId++;
      this.headCounter++;
      this.blocksProduced++;
      for (const node of this.nodes) node.hasBlock = false;
      proposer.hasBlock = true;
      proposer.head = this.headCounter;
      this.lastReach = 1;
      this.eagerForward(proposer.index, -1);
    },

    eagerForward(fromIndex, excludeIndex) {
      const from = this.nodes[fromIndex];
      for (const meshIndex of from.mesh) {
        if (meshIndex === excludeIndex) continue;
        const target = this.nodes[meshIndex];
        if (!target || !target.online || !target.subscribed) continue;
        this.spawnParticle(fromIndex, meshIndex, "data", () => this.receiveBlock(meshIndex, fromIndex, "eager"));
      }
    },

    receiveBlock(nodeIndex, viaIndex, channel) {
      const node = this.nodes[nodeIndex];
      if (!node || !node.online || !node.subscribed) return;
      if (node.hasBlock) {
        this.stats.dups++;
        return;
      }
      node.hasBlock = true;
      node.head = this.headCounter;
      this.lastReach++;
      if (channel === "gossip") this.stats.gossip++;
      this.eagerForward(nodeIndex, viaIndex);
    },

    operateHeartbeat() {
      this.stats.beats++;
      this.meshMaintenance();
      this.emitGossip();
    },

    meshMaintenance() {
      const dLow = Math.max(2, Math.round(MESH_D * 0.75));
      const dHigh = Math.round(MESH_D * 1.5);
      const subs = this.subscribers();
      for (const node of subs) {
        if (node.mesh.size < dLow) {
          const options = util.shuffleInPlace(
            this.rng,
            subs.filter((other) => other !== node && !node.mesh.has(other.index) && other.mesh.size < dHigh),
          );
          for (const other of options) {
            if (node.mesh.size >= MESH_D) break;
            node.mesh.add(other.index);
            other.mesh.add(node.index);
            this.stats.grafts++;
            this.spawnParticle(node.index, other.index, "graft", null);
          }
        }
        if (node.mesh.size > dHigh) {
          const excess = util.shuffleInPlace(this.rng, [...node.mesh]);
          while (node.mesh.size > MESH_D && excess.length) {
            const otherIndex = excess.pop();
            node.mesh.delete(otherIndex);
            this.nodes[otherIndex].mesh.delete(node.index);
            this.stats.prunes++;
            this.spawnParticle(node.index, otherIndex, "prune", null);
          }
        }
      }
    },

    /** Lazy pull: informed nodes advertise IHAVE; missing nodes pull via IWANT. */
    emitGossip() {
      if (this.currentBlockId === 0) return;
      for (const node of this.subscribers()) {
        if (!node.hasBlock) continue;
        const targets = this.subscribers().filter(
          (other) => other !== node && !node.mesh.has(other.index) && !other.hasBlock,
        );
        if (!targets.length) continue;
        const target = util.pickRandom(this.rng, targets);
        this.spawnParticle(node.index, target.index, "ihave", () => {
          if (!target.online || !target.subscribed || target.hasBlock) return;
          this.spawnParticle(target.index, node.index, "iwant", () => {
            if (!node.hasBlock) return;
            this.spawnParticle(node.index, target.index, "data", () =>
              this.receiveBlock(target.index, node.index, "gossip"),
            );
          });
        });
      }
    },

    churnTick() {
      const candidates = this.nodes.filter((node) => !node.isProtagonist && node.subscribed);
      if (!candidates.length) return;
      const victim = util.pickRandom(this.rng, candidates);
      if (victim.online) {
        victim.online = false;
        victim.hasBlock = false;
        for (const meshIndex of victim.mesh) this.nodes[meshIndex].mesh.delete(victim.index);
        victim.mesh.clear();
      } else {
        victim.online = true; // re-grafted at next heartbeat
      }
    },

    protagonistLeaves() {
      if (this.phaseKey !== "operate") return;
      const protagonist = this.protagonist;
      protagonist.online = false;
      protagonist.hasBlock = false;
      for (const meshIndex of protagonist.mesh) this.nodes[meshIndex].mesh.delete(protagonist.index);
      protagonist.mesh.clear();
    },

    spawnParticle(fromIndex, toIndex, type, onArrive) {
      const from = this.nodes[fromIndex];
      const to = this.nodes[toIndex];
      const pixelDistance = util.distance(this.px(from), this.py(from), this.px(to), this.py(to));
      const speed = type === "data" ? 260 : 440;
      this.particles.push({ fromIndex, toIndex, type, t: 0, duration: Math.max(0.18, pixelDistance / speed), onArrive });
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      const dt = realDt * this.speed;
      this.phaseTime += dt;

      if (this.phaseKey === "operate") {
        this.slotTimer += dt;
        if (this.slotTimer >= SLOT_DURATION) {
          this.slotTimer -= SLOT_DURATION;
          this.publishSlot();
        }
        this.heartbeatTimer += dt;
        while (this.heartbeatTimer >= HEARTBEAT) {
          this.heartbeatTimer -= HEARTBEAT;
          this.operateHeartbeat();
        }
        if (this.scenario === "churn") {
          this.churnTimer += dt;
          if (this.churnTimer >= 1.6) {
            this.churnTimer = 0;
            this.churnTick();
          }
        }
      } else {
        if (this.phaseKey === "sync") this.protagonist.head = Math.round(util.lerp(NETWORK_HEAD - SYNC_GAP, NETWORK_HEAD, this.syncProgress()));
        if (this.auto && this.phaseTime >= PHASE_DURATION[this.phaseKey]) this.advancePhase();
      }

      const survivors = [];
      for (const particle of this.particles) {
        particle.t += dt / particle.duration;
        if (particle.t >= 1) {
          if (particle.onArrive) particle.onArrive();
        } else survivors.push(particle);
      }
      this.particles = survivors;
    },

    /* ------------------------- geometry ------------------------- */
    px(node) {
      return 40 + node.nx * (this.width - 80);
    },
    py(node) {
      return 96 + node.ny * (this.height - 250);
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderTimeline(ctx);
      this.renderEdges(ctx);
      this.renderParticles(ctx);
      this.renderNodes(ctx);
      this.renderChainStrip(ctx);
      this.renderLegend(ctx);
    },

    renderTimeline(ctx) {
      const top = 30;
      const segmentWidth = Math.min(150, (this.width - 40) / PHASES.length);
      const totalWidth = segmentWidth * PHASES.length;
      const startX = (this.width - totalWidth) / 2;
      PHASES.forEach((phase, index) => {
        const x = startX + index * segmentWidth;
        const isCurrent = index === this.phaseIndex;
        const isDone = index < this.phaseIndex;
        const color = isCurrent ? colors.accent : isDone ? colors.nodeHasMessage : colors.textDim;
        ctx.save();
        draw.roundedRect(ctx, x + 4, top, segmentWidth - 8, 30, 7);
        ctx.fillStyle = isCurrent ? "#16263d" : "#121a27";
        ctx.fill();
        ctx.lineWidth = isCurrent ? 2 : 1;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
        const mark = isDone ? "✓ " : `${index + 1}. `;
        draw.label(ctx, mark + phase.label, x + segmentWidth / 2, top + 12, color, "12px ui-monospace, monospace");
        draw.label(ctx, "§" + phase.section, x + segmentWidth / 2, top + 24, colors.textDim, "9px ui-monospace, monospace");
        if (index < PHASES.length - 1) {
          draw.label(ctx, "→", x + segmentWidth - 2, top + 15, colors.textDim, "12px ui-monospace, monospace");
        }
      });
      draw.label(ctx, PHASE_NARRATION[this.phaseKey], this.width / 2, top + 48, colors.text, "12px ui-monospace, monospace");
    },

    renderEdges(ctx) {
      const protagonist = this.protagonist;
      // Connections from protagonist (blue).
      const connectionCount = this.connectionCount();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = colors.nodeActive + "aa";
      for (let i = 0; i < connectionCount; i++) {
        const peer = this.nodes[this.connectTargets[i]];
        draw.line(ctx, this.px(protagonist), this.py(protagonist), this.px(peer), this.py(peer), colors.nodeActive + "99", 1.6, false);
      }
      // Mesh edges (green) in subscribe/operate.
      if (this.phaseKey === "operate") {
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.strokeStyle = colors.meshEdge;
        for (const node of this.nodes) {
          if (!node.online || !node.subscribed) continue;
          for (const meshIndex of node.mesh) {
            if (meshIndex <= node.index) continue;
            const peer = this.nodes[meshIndex];
            if (!peer.online || !peer.subscribed) continue;
            ctx.moveTo(this.px(node), this.py(node));
            ctx.lineTo(this.px(peer), this.py(peer));
          }
        }
        ctx.stroke();
      } else {
        const meshCount = this.meshCount();
        for (let i = 0; i < meshCount; i++) {
          const peer = this.nodes[this.meshTargets[i]];
          draw.line(ctx, this.px(protagonist), this.py(protagonist), this.px(peer), this.py(peer), colors.meshEdge, 2.4, false);
        }
      }
    },

    renderParticles(ctx) {
      for (const particle of this.particles) {
        const from = this.nodes[particle.fromIndex];
        const to = this.nodes[particle.toIndex];
        const px = util.lerp(this.px(from), this.px(to), particle.t);
        const py = util.lerp(this.py(from), this.py(to), particle.t);
        const map = { data: colors.data, ihave: colors.ihave, iwant: colors.iwant, graft: colors.graft, prune: colors.prune, find: colors.nodeActive, nodes: colors.nodeHasMessage, connect: colors.nodeActive, status: colors.nodeSource, chunk: colors.nodeHasMessage };
        const color = map[particle.type] || colors.text;
        if (particle.type === "ihave" || particle.type === "iwant" || particle.type === "find") {
          draw.line(ctx, this.px(from), this.py(from), px, py, color + "66", 1.2, true);
        }
        draw.disc(ctx, px, py, particle.type === "data" || particle.type === "chunk" ? 4.5 : 3, color, null);
        if (particle.type === "data") draw.glow(ctx, px, py, 10, color);
      }
    },

    renderNodes(ctx) {
      const discoveredCount = this.discoveredCount();
      const peers = this.nodes.filter((node) => !node.isProtagonist);
      // Discovery order = distance from protagonist (matches reveal).
      const protagonist = this.protagonist;
      const discoveryOrder = peers
        .slice()
        .sort(
          (a, b) =>
            util.distance(protagonist.nx, protagonist.ny, a.nx, a.ny) -
            util.distance(protagonist.nx, protagonist.ny, b.nx, b.ny),
        );
      const discoveredSet = new Set(discoveryOrder.slice(0, discoveredCount).map((n) => n.index));
      const connectedSet = new Set(this.connectTargets.slice(0, this.connectionCount()));

      for (const node of peers) {
        const x = this.px(node);
        const y = this.py(node);
        const discovered = discoveredSet.has(node.index);
        let fill = colors.node;
        let stroke = colors.nodeStroke;
        let radius = 8;
        if (!node.online) {
          draw.disc(ctx, x, y, radius * 0.8, colors.nodeDead, "#4a3340", 1);
          continue;
        }
        if (!node.forkOk) {
          // Wrong fork: visible during/after discovery but excluded.
          if (discovered) {
            draw.disc(ctx, x, y, radius, "#2a2230", "#5a4458", 1.2);
            draw.label(ctx, "✗", x, y, colors.prune, "12px ui-monospace, monospace");
          }
          continue;
        }
        if (!discovered) {
          draw.disc(ctx, x, y, radius * 0.7, "#16202d", "#243348", 1);
        }
        if (this.phaseKey === "operate") {
          if (!node.subscribed) fill = "#23303f";
          else fill = node.hasBlock ? colors.nodeHasMessage : colors.node;
        } else if (discovered) {
          fill = "#2f4a6b";
        }
        if (discovered || this.phaseKey === "operate") {
          draw.disc(ctx, x, y, radius, fill, stroke, 1.3);
        }
        if (connectedSet.has(node.index) && this.phaseKey !== "operate") {
          draw.disc(ctx, x, y, radius + 3, null, colors.nodeActive, 1.6);
        }
        if (node.index === this.syncSourceIndex && (this.phaseKey === "handshake" || this.phaseKey === "sync")) {
          draw.label(ctx, "head↑ 同期元", x, y - 16, colors.nodeSource, "10px ui-monospace, monospace");
        }
      }

      // Protagonist on top.
      const px = this.px(protagonist);
      const py = this.py(protagonist);
      if (protagonist.online) {
        draw.glow(ctx, px, py, 26, colors.nodeSource);
        const fill = protagonist.hasBlock && this.phaseKey === "operate" ? colors.nodeHasMessage : colors.nodeSource;
        draw.disc(ctx, px, py, 13, fill, "#fff8e1", 2);
        draw.label(ctx, "自ノード", px, py - 22, colors.nodeSource, "11px ui-monospace, monospace");
      } else {
        draw.disc(ctx, px, py, 11, colors.nodeDead, colors.prune, 1.6);
        draw.label(ctx, "離脱", px, py - 20, colors.prune, "11px ui-monospace, monospace");
      }
    },

    renderChainStrip(ctx) {
      const y = this.height - 64;
      const head = this.phaseKey === "operate" ? this.headCounter : this.protagonist.head;
      draw.label(ctx, "自ノードのチェーン head", 24, y - 14, colors.textDim, "11px ui-monospace, monospace", "left");
      const count = 10;
      const boxWidth = 46;
      const gap = 6;
      const startSlot = head - count + 1;
      for (let i = 0; i < count; i++) {
        const slot = startSlot + i;
        const x = 24 + i * (boxWidth + gap);
        const filled = slot <= head;
        ctx.save();
        draw.roundedRect(ctx, x, y, boxWidth, 30, 5);
        ctx.fillStyle = filled ? "#15202f" : "#10161f";
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = slot === head ? colors.nodeSource : filled ? colors.nodeHasMessage : colors.grid;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, String(slot), x + boxWidth / 2, y + 15, filled ? colors.text : colors.textDim, "10px ui-monospace, monospace");
      }
      draw.label(ctx, `head = ${head}  /  network = ${this.headCounter}`, 24 + count * (boxWidth + gap) + 14, y + 15, colors.text, "12px ui-monospace, monospace", "left");
    },

    renderLegend(ctx) {
      const items = [
        ["接続 (QUIC)", colors.nodeActive],
        ["mesh / block", colors.data],
        ["IHAVE / IWANT", colors.ihave],
        ["GRAFT", colors.graft],
        ["別フォーク ✗", colors.prune],
      ];
      let y = this.height - items.length * 16 - 18;
      const x = this.width - 168;
      ctx.save();
      ctx.globalAlpha = 0.92;
      draw.roundedRect(ctx, x - 10, y - 12, 168, items.length * 16 + 12, 8);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();
      for (const [text, color] of items) {
        draw.disc(ctx, x, y, 4, color, null);
        draw.label(ctx, text, x + 12, y, colors.textDim, "10px ui-monospace, monospace", "left");
        y += 16;
      }
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    getStats() {
      const scenarioLabel = { normal: "正常参加", fork: "フォーク混在", churn: "高チャーン" }[this.scenario];
      const topicLabel = this.topic === "block" ? "beacon_block (全員)" : "attestation subnet (一部)";
      const subs = this.subscribers().length;
      const rows = [
        { label: "フェーズ", value: `${this.phaseIndex + 1}/6 ${PHASES[this.phaseIndex].label}` },
        { label: "シナリオ", value: scenarioLabel },
        { label: "トピック", value: topicLabel },
        { label: "接続数", value: `${this.connectionCount()} / ${PEER_SLOTS}` },
        { label: "自 head / network", value: `${this.phaseKey === "operate" ? this.headCounter : this.protagonist.head} / ${this.headCounter}` },
      ];
      if (this.phaseKey === "operate") {
        const total = subs;
        const reached = this.subscribers().filter((n) => n.hasBlock).length;
        rows.push({ label: "購読者", value: subs });
        rows.push({ label: "直近ブロック到達", value: `${reached} / ${total}` });
        rows.push({ label: "GRAFT / PRUNE", value: `${this.stats.grafts} / ${this.stats.prunes}` });
        rows.push({ label: "gossip 回収 / 重複", value: `${this.stats.gossip} / ${this.stats.dups}` });
      }
      return rows;
    },

    /* ------------------------- controls ------------------------- */
    updateActiveButtons() {
      this.scenarioButtons.forEach((button) => button.classList.toggle("primary", button.dataset.value === this.scenario));
      this.topicButtons.forEach((button) => button.classList.toggle("primary", button.dataset.value === this.topic));
    },

    buildControls(container) {
      const ui = P2P.ui;

      const playback = ui.group("再生");
      const playButton = ui.button(this.auto ? "⏸ 一時停止" : "▶ 再生", () => {
        this.auto = !this.auto;
        playButton.textContent = this.auto ? "⏸ 一時停止" : "▶ 再生";
      }, "primary");
      playback.appendChild(playButton);
      playback.appendChild(ui.button("次のフェーズ ▶", () => {
        this.nextPhase();
        playButton.textContent = "▶ 再生";
      }));
      playback.appendChild(ui.button("最初から ↻", () => {
        this.build();
        this.auto = true;
        playButton.textContent = "⏸ 一時停止";
      }));
      playback.appendChild(ui.button("自ノードを離脱", () => this.protagonistLeaves(), "danger"));
      playback.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (v) => (this.speed = v)));
      container.appendChild(playback);

      const scenarioGroup = ui.group("シナリオ");
      this.scenarioButtons = [];
      for (const [value, label] of [["normal", "正常参加"], ["fork", "フォーク混在"], ["churn", "高チャーン"]]) {
        const button = ui.button(label, () => {
          this.scenario = value;
          this.build();
          this.auto = true;
          playButton.textContent = "⏸ 一時停止";
          this.updateActiveButtons();
        });
        button.dataset.value = value;
        this.scenarioButtons.push(button);
        scenarioGroup.appendChild(button);
      }
      container.appendChild(scenarioGroup);

      const topicGroup = ui.group("トピック");
      this.topicButtons = [];
      for (const [value, label] of [["block", "beacon_block (全員)"], ["subnet", "attestation subnet (一部)"]]) {
        const button = ui.button(label, () => {
          this.topic = value;
          this.build();
          this.auto = true;
          playButton.textContent = "⏸ 一時停止";
          this.updateActiveButtons();
        });
        button.dataset.value = value;
        this.topicButtons.push(button);
        topicGroup.appendChild(button);
      }
      container.appendChild(topicGroup);

      const params = ui.group("ネットワーク");
      params.appendChild(ui.slider("ピア数", 18, 60, 2, this.peerCount, (value) => {
        this.peerCount = value;
        this.build();
      }));
      container.appendChild(params);

      this.updateActiveButtons();
    },
  };

  P2P.scenes.lifecycle = scene;
})();
