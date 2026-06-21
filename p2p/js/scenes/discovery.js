/*
 * discovery.js — Section 5.2: Discovery v5, the node directory.
 *
 * Visualizes the Kademlia lookup as an "iterative funnel" (Figure 5.9):
 *   - Nodes are laid out radially by XOR distance to the chosen target,
 *     so the target sits at the center and the search visibly zooms inward.
 *   - Each round the initiator sends FINDNODE to the alpha closest known
 *     peers; they reply with the k nodes they know closest to the target.
 *   - The greedy XOR metric guarantees the best distance strictly shrinks
 *     until a round finds nothing closer (convergence).
 *
 * A side panel shows the bitwise XOR distance and the k-bucket layout
 * (bucket = idBits - sharedPrefixLength) that the routing table uses.
 */
"use strict";

(function registerDiscovery() {
  const { util, draw, colors } = P2P;

  const ID_BITS = 16;
  const ID_SPACE = 1 << ID_BITS;
  const TABLE_SIZE = 8; // peers each node keeps closest to itself
  const RETURN_K = 4; // nodes returned per FINDNODE
  const ALPHA = 3; // parallel queries per round
  const AUTO_STEP_INTERVAL = 0.95; // simulated seconds between rounds

  const scene = {
    id: "discovery",
    title: "Discovery v5",
    sectionRef: "5.2",
    descriptionHTML: `
      <p><b>問題:</b> 初めて起動したノードは孤立している。数百万のノードの中から、
      同じチェーンを追う相手を見つけたい。</p>
      <p><b>Kademlia DHT の答え:</b> Node ID は 256bit の数値(ここでは見やすく16bit)。
      2ノード間の「距離」を物理的な遅延ではなく <b>XOR</b> で定義する:</p>
      <p style="text-align:center"><code>distance(A,B) = ID_A ⊕ ID_B</code></p>
      <ul>
        <li><b>放射状レイアウト:</b> ターゲットを中心に置き、各ノードを XOR 距離の
        大きさ(対数)で同心円状に配置。探索が中心へ「漏斗状」に収束する様子が見える。</li>
        <li><b>反復探索 (Iterative Lookup):</b> 開始ノードが、知っている中で
        ターゲットに最も近い α=${ALPHA} ノードへ <code>FINDNODE</code> を送る。各ノードは自分が知る
        k=${RETURN_K} 個の近傍を返す(青→中心へ寄る)。</li>
        <li><b>収束保証:</b> XOR 距離は整数で、ホップごとに厳密に減少。
        新たに近いノードが返らなくなった時点で終了 (O(log n) ホップ)。</li>
        <li><b>k-bucket:</b> 共有プレフィックス長 N のノードを bucket ${ID_BITS}−N に分類。
        近い相手ほど高解像度、遠い相手は疎にしか持たない(右パネル)。</li>
      </ul>
      <p><b>操作:</b>「次のホップ」で1ラウンドずつ進める。「自動探索」で連続再生。
      ノードをクリックすると、そのノードを新しい探索の開始点にできる。</p>`,

    /* ------------------------- state ------------------------- */
    nodes: [],
    width: 0,
    height: 0,
    rng: null,
    seed: 7,
    simTime: 0,
    autoTimer: 0,
    autoPlay: false,
    hoverIndex: -1,
    particles: [],
    nodeCount: 44,
    lookup: null,

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

    center() {
      return { x: this.width * 0.54, y: this.height * 0.52 };
    },
    maxRadius() {
      return Math.min(this.width, this.height) * 0.42;
    },

    /* ------------------------- graph construction ------------------------- */
    buildGraph() {
      this.rng = util.makeRng(this.seed * 40503);
      this.simTime = 0;
      this.particles = [];

      // Unique random node ids.
      const usedIds = new Set();
      const nodes = [];
      while (nodes.length < this.nodeCount) {
        const id = util.randomInt(this.rng, 0, ID_SPACE);
        if (usedIds.has(id)) continue;
        usedIds.add(id);
        nodes.push({
          index: nodes.length,
          id,
          angle: this.rng() * Math.PI * 2,
          curRadius: this.maxRadius(),
          known: [],
        });
      }
      this.nodes = nodes;
      this.buildRoutingTables();
      this.startLookup();
    },

    /** Each node knows its XOR-closest peers plus a few random distant ones. */
    buildRoutingTables() {
      for (const node of this.nodes) {
        const ranked = this.nodes
          .filter((other) => other !== node)
          .map((other) => ({ index: other.index, d: node.id ^ other.id }))
          .sort((a, b) => a.d - b.d);
        const close = ranked.slice(0, TABLE_SIZE).map((entry) => entry.index);
        const distant = util
          .shuffleInPlace(this.rng, ranked.slice(TABLE_SIZE))
          .slice(0, 3)
          .map((entry) => entry.index);
        node.known = [...new Set([...close, ...distant])];
      }
    },

    /* ------------------------- lookup ------------------------- */
    startLookup(initiatorIndex, targetIndex) {
      const initiator =
        initiatorIndex !== undefined
          ? this.nodes[initiatorIndex]
          : util.pickRandom(this.rng, this.nodes);
      let target =
        targetIndex !== undefined ? this.nodes[targetIndex] : util.pickRandom(this.rng, this.nodes);
      if (target === initiator) {
        target = util.pickRandom(this.rng, this.nodes.filter((n) => n !== initiator));
      }

      const knownToInitiator = new Set(initiator.known);
      this.lookup = {
        initiatorIndex: initiator.index,
        targetId: target.id,
        targetIndex: target.index,
        visited: new Set([initiator.index]),
        discovered: knownToInitiator, // node indices currently known to the search
        bestIndex: this.closestAmong([...knownToInitiator], target.id),
        round: 0,
        queried: 0,
        finished: false,
        converged: false,
      };
      this.particles = [];
      this.refreshRadii(true);
    },

    distanceToTarget(nodeIndex) {
      return this.nodes[nodeIndex].id ^ this.lookup.targetId;
    },

    closestAmong(indices, targetId) {
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (const index of indices) {
        const distance = this.nodes[index].id ^ targetId;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      return bestIndex;
    },

    /** Run one round: query the alpha closest unvisited known peers. */
    stepLookup() {
      const lookup = this.lookup;
      if (!lookup || lookup.finished) return;

      const candidates = [...lookup.discovered]
        .filter((index) => !lookup.visited.has(index))
        .sort((a, b) => this.distanceToTarget(a) - this.distanceToTarget(b))
        .slice(0, ALPHA);

      if (!candidates.length) {
        lookup.finished = true;
        lookup.converged = true;
        return;
      }

      const previousBestDistance =
        lookup.bestIndex >= 0 ? this.distanceToTarget(lookup.bestIndex) : Infinity;
      lookup.round++;
      let improved = false;

      for (const peerIndex of candidates) {
        lookup.visited.add(peerIndex);
        lookup.queried++;
        // FINDNODE animation from initiator to the queried peer.
        this.spawnParticle(lookup.initiatorIndex, peerIndex, "find");

        const peer = this.nodes[peerIndex];
        const returned = peer.known
          .slice()
          .sort((a, b) => this.distanceToTarget(a) - this.distanceToTarget(b))
          .slice(0, RETURN_K);
        for (const discoveredIndex of returned) {
          if (!lookup.discovered.has(discoveredIndex)) {
            lookup.discovered.add(discoveredIndex);
            // NODES response animation from peer back toward the initiator.
            this.spawnParticle(peerIndex, lookup.initiatorIndex, "nodes");
          }
          const distance = this.distanceToTarget(discoveredIndex);
          if (lookup.bestIndex < 0 || distance < this.distanceToTarget(lookup.bestIndex)) {
            lookup.bestIndex = discoveredIndex;
          }
        }
      }

      const newBestDistance =
        lookup.bestIndex >= 0 ? this.distanceToTarget(lookup.bestIndex) : Infinity;
      improved = newBestDistance < previousBestDistance;
      if (!improved) {
        lookup.finished = true;
        lookup.converged = true;
      }
      this.refreshRadii(false);
    },

    spawnParticle(fromIndex, toIndex, type) {
      this.particles.push({ fromIndex, toIndex, type, t: 0, duration: 0.6 });
    },

    /* ------------------------- layout ------------------------- */
    refreshRadii(snap) {
      const inner = 30;
      const span = this.maxRadius() - inner;
      for (const node of this.nodes) {
        const distance = node.id ^ this.lookup.targetId;
        const normalized = distance === 0 ? 0 : Math.log2(distance) / ID_BITS;
        const target = inner + normalized * span;
        if (snap) node.curRadius = target;
        node.targetRadius = target;
      }
    },

    nodePos(node) {
      const c = this.center();
      return {
        x: c.x + Math.cos(node.angle) * node.curRadius,
        y: c.y + Math.sin(node.angle) * node.curRadius,
      };
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      this.simTime += realDt;
      for (const node of this.nodes) {
        if (node.targetRadius !== undefined) {
          node.curRadius += (node.targetRadius - node.curRadius) * Math.min(1, realDt * 4);
        }
      }
      const survivors = [];
      for (const particle of this.particles) {
        particle.t += realDt / particle.duration;
        if (particle.t < 1) survivors.push(particle);
      }
      this.particles = survivors;

      if (this.autoPlay && this.lookup && !this.lookup.finished) {
        this.autoTimer += realDt;
        if (this.autoTimer >= AUTO_STEP_INTERVAL) {
          this.autoTimer = 0;
          this.stepLookup();
        }
      }
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderRings(ctx);
      this.renderParticles(ctx);
      this.renderNodes(ctx);
      this.renderBitPanel(ctx);
      this.renderBucketPanel(ctx);
    },

    renderRings(ctx) {
      const c = this.center();
      ctx.save();
      ctx.strokeStyle = colors.grid;
      ctx.setLineDash([3, 7]);
      for (let ring = 1; ring <= ID_BITS; ring += 3) {
        const radius = 30 + (ring / ID_BITS) * (this.maxRadius() - 30);
        draw.disc(ctx, c.x, c.y, radius, null, colors.grid, 1);
      }
      ctx.restore();
      draw.label(ctx, "target", c.x, c.y - 16, colors.nodeTarget, "11px ui-monospace, monospace");
    },

    renderParticles(ctx) {
      for (const particle of this.particles) {
        const from = this.nodePos(this.nodes[particle.fromIndex]);
        const to = this.nodePos(this.nodes[particle.toIndex]);
        const x = util.lerp(from.x, to.x, particle.t);
        const y = util.lerp(from.y, to.y, particle.t);
        const color = particle.type === "find" ? colors.nodeActive : colors.nodeHasMessage;
        draw.line(ctx, from.x, from.y, x, y, color + "66", 1.2, false);
        draw.disc(ctx, x, y, 3.5, color, null);
      }
    },

    renderNodes(ctx) {
      const lookup = this.lookup;
      for (const node of this.nodes) {
        const pos = this.nodePos(node);
        let fill = colors.node;
        let stroke = colors.nodeStroke;
        let radius = 8;
        if (node.index === lookup.targetIndex) {
          fill = colors.nodeTarget;
          radius = 11;
        } else if (node.index === lookup.initiatorIndex) {
          fill = colors.nodeSource;
          radius = 10;
        } else if (lookup.visited.has(node.index)) {
          fill = colors.nodeActive;
        } else if (lookup.discovered.has(node.index)) {
          fill = "#2f4a6b";
        }
        if (node.index === this.hoverIndex) draw.glow(ctx, pos.x, pos.y, 22, colors.accent);
        draw.disc(ctx, pos.x, pos.y, radius, fill, stroke, 1.4);
        if (node.index === lookup.bestIndex && !lookup.finished) {
          draw.disc(ctx, pos.x, pos.y, radius + 4, null, colors.nodeHasMessage, 2);
        }
      }
      // Mark the target with a ring once the search converges near it.
      if (lookup.finished) {
        const pos = this.nodePos(this.nodes[lookup.targetIndex]);
        draw.disc(ctx, pos.x, pos.y, 16, null, colors.nodeTarget, 2);
      }
    },

    renderBitPanel(ctx) {
      const lookup = this.lookup;
      const x = 16;
      let y = 26;
      const targetBits = util.toBinary(lookup.targetId, ID_BITS);
      const bestId = lookup.bestIndex >= 0 ? this.nodes[lookup.bestIndex].id : 0;
      const bestBits = util.toBinary(bestId, ID_BITS);
      const xorValue = bestId ^ lookup.targetId;
      const xorBits = util.toBinary(xorValue, ID_BITS);

      ctx.save();
      ctx.globalAlpha = 0.95;
      draw.roundedRect(ctx, x - 8, y - 18, 360, 116, 8);
      ctx.fillStyle = "#0e1420dd";
      ctx.fill();
      ctx.restore();

      const mono = "13px ui-monospace, monospace";
      draw.label(ctx, "target", x, y, colors.textDim, mono, "left");
      this.drawBits(ctx, targetBits, x + 70, y, colors.nodeTarget, null);
      y += 22;
      draw.label(ctx, "closest", x, y, colors.textDim, mono, "left");
      this.drawBits(ctx, bestBits, x + 70, y, colors.nodeHasMessage, null);
      y += 22;
      draw.label(ctx, "XOR", x, y, colors.textDim, mono, "left");
      // Highlight the diverging bits (the 1s of the XOR) in red.
      this.drawBits(ctx, xorBits, x + 70, y, colors.textDim, colors.nodeTarget);
      y += 24;
      draw.label(
        ctx,
        `distance = ${xorValue}   (${util.toHexTag(xorValue, 4)})`,
        x,
        y,
        colors.text,
        mono,
        "left",
      );
    },

    drawBits(ctx, bits, x, y, baseColor, oneColor) {
      ctx.save();
      ctx.font = "13px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      let cursor = x;
      for (let i = 0; i < bits.length; i++) {
        const isOne = bits[i] === "1";
        ctx.fillStyle = oneColor && isOne ? oneColor : baseColor;
        ctx.fillText(bits[i], cursor, y);
        cursor += 9;
        if ((i + 1) % 4 === 0) cursor += 4;
      }
      ctx.restore();
    },

    renderBucketPanel(ctx) {
      const initiator = this.nodes[this.lookup.initiatorIndex];
      const buckets = new Array(ID_BITS + 1).fill(0);
      for (const peerIndex of initiator.known) {
        const xorValue = initiator.id ^ this.nodes[peerIndex].id;
        const sharedPrefix = util.leadingZeroBits(xorValue, ID_BITS);
        buckets[ID_BITS - sharedPrefix]++;
      }
      const panelWidth = 150;
      const x = this.width - panelWidth - 12;
      let y = 40;
      ctx.save();
      ctx.globalAlpha = 0.95;
      draw.roundedRect(ctx, x - 8, y - 26, panelWidth, ID_BITS * 9 + 40, 8);
      ctx.fillStyle = "#0e1420dd";
      ctx.fill();
      ctx.restore();
      draw.label(ctx, "開始ノードの k-bucket", x, y - 12, colors.textDim, "11px ui-monospace, monospace", "left");
      const maxCount = Math.max(1, ...buckets);
      for (let bucket = 1; bucket <= ID_BITS; bucket++) {
        const count = buckets[bucket];
        const barWidth = (count / maxCount) * 90;
        draw.label(ctx, `b${bucket}`, x, y, colors.textDim, "10px ui-monospace, monospace", "left");
        ctx.fillStyle = count ? colors.accent : colors.grid;
        ctx.fillRect(x + 26, y - 4, Math.max(2, barWidth), 8);
        y += 9;
      }
    },

    /* ------------------------- interaction ------------------------- */
    nodeAt(x, y) {
      for (const node of this.nodes) {
        const pos = this.nodePos(node);
        if (util.distance(x, y, pos.x, pos.y) <= 12) return node.index;
      }
      return -1;
    },

    onMouse(type, x, y) {
      if (type === "move") {
        this.hoverIndex = this.nodeAt(x, y);
      } else if (type === "click") {
        const index = this.nodeAt(x, y);
        if (index >= 0) this.startLookup(index, this.lookup.targetIndex);
      }
    },

    /* ------------------------- stats ------------------------- */
    getStats() {
      const lookup = this.lookup;
      const bestDistance = lookup.bestIndex >= 0 ? this.distanceToTarget(lookup.bestIndex) : 0;
      return [
        { label: "状態", value: lookup.finished ? "収束 (完了)" : "探索中" },
        { label: "ラウンド (ホップ)", value: lookup.round },
        { label: "クエリ済みノード", value: lookup.queried },
        { label: "発見済み / 全体", value: `${lookup.discovered.size} / ${this.nodeCount}` },
        { label: "最良距離", value: `${bestDistance} (${util.toHexTag(bestDistance, 4)})` },
        { label: "ターゲット到達", value: lookup.bestIndex === lookup.targetIndex ? "Yes" : "No" },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const actions = ui.group("探索");
      actions.appendChild(ui.button("次のホップ ▶", () => this.stepLookup(), "primary"));
      actions.appendChild(
        ui.button("新しい探索 (ランダム)", () => {
          this.autoPlay = false;
          autoToggle.querySelector("input").checked = false;
          this.startLookup();
        }),
      );
      const autoToggle = ui.toggle("自動探索", this.autoPlay, (v) => {
        this.autoPlay = v;
        this.autoTimer = 0;
      });
      actions.appendChild(autoToggle);
      container.appendChild(actions);

      const params = ui.group("ネットワーク");
      params.appendChild(
        ui.slider("ノード数", 16, 80, 4, this.nodeCount, (value) => {
          this.nodeCount = value;
          this.buildGraph();
        }),
      );
      params.appendChild(
        ui.button("ID を再生成", () => {
          this.seed++;
          this.buildGraph();
        }),
      );
      container.appendChild(params);
    },
  };

  P2P.scenes.discovery = scene;
})();
