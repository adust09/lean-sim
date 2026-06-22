/*
 * forks.js — Capstone (complex): a forking beacon chain with GHOST fork choice.
 *
 * Extends the integrated view to the hard cases the protocol is built to
 * survive. The chain is a TREE; the canonical head is chosen by accumulated
 * attestation weight (LMD-GHOST: from the finalized root, repeatedly descend
 * into the heaviest subtree). Scenarios inject divergence:
 *   - 一時的フォーク : two valid blocks at one slot; votes split; fork choice
 *                       converges and the lighter branch is reorged out.
 *   - ネットワーク分断: validators split into two groups that each extend their
 *                       own branch (neither reaches 2/3, so finality stalls);
 *                       on heal, the heavier branch wins and the other reorgs.
 *   - 二重提案       : a proposer equivocates; honest majority follows GHOST,
 *                       the equivocating branch withers.
 *
 * Justification needs a 2/3 supermajority on one block; consecutive justified
 * blocks finalize the earlier one — which is exactly what a fork cannot do
 * while the vote is split.
 */
"use strict";

(function registerForks() {
  const { util, draw, colors } = P2P;

  const SLOT_DURATION = 12.0; // real cadence: 12s per slot (4 intervals of 3s)
  const INTERVAL_COUNT = 4;

  const SCENARIOS = {
    normal: { label: "正常 (フォークなし)" },
    tempfork: { label: "一時的フォーク" },
    partition: { label: "ネットワーク分断 (60/40)" },
    equivocation: { label: "二重提案 (equivocation)" },
  };

  // The four per-slot intervals (§3) that drive the fork-choice cycle.
  const INTERVAL_LABELS = ["I0 提案", "I1 投票", "I2 集約", "I3 フォーク選択"];
  const INTERVAL_NARRATION = [
    "Interval 0 — 提案者がブロックを生成し配信 (§3,§5)。フォーク時は枝が分岐する。",
    "Interval 1 — 各検証者が attestation を投票。票が枝ごとに分かれる (§6.2)。",
    "Interval 2 — 票を集約し、各枝・各ブロックの重みを更新 (§6.4)。",
    "Interval 3 — GHOST フォーク選択でヘッドを再計算し reorg / justify を判定 (§6.3)。",
  ];

  const scene = {
    id: "forks",
    title: "フォーク・シナリオ",
    sectionRef: "6.3",
    descriptionHTML: `
      <p><b>チェーンがフォークする複雑なケースを、統合した「生きたチェーン」で扱う。</b>
      ブロックは木構造になり、正規ヘッドは <b>GHOST フォーク選択</b>で決まる:
      finalized を起点に、毎ノードで<b>部分木の得票が最大の子</b>へ降りた先の葉。</p>
      <p><b>シナリオ:</b></p>
      <ul>
        <li><b>一時的フォーク:</b> 同一スロットに2つの正当なブロック。票が割れるが、
        次スロット以降は重い枝に収束し、軽い枝は <b>reorg</b> で外れる。</li>
        <li><b>ネットワーク分断:</b> 検証者が2群に分断され各自の枝を伸ばす。
        どちらも 2/3 に届かず <b>finality が停止</b>。回復時に重い枝(60%)が勝ち、
        少数枝(40%)は reorg。</li>
        <li><b>二重提案:</b> 提案者が矛盾する2ブロックを出す。正直な多数は GHOST に従い、
        equivocation 枝は伸びずに枯れる。</li>
      </ul>
      <p><b>finality との関係:</b> justification は1ブロックへの 2/3 集票が必要。票が割れる間は
      どの枝も justified にならず、finalized も進まない。フォークが解消し多数が一枝に集まって
      初めて finality が再開する。</p>
      <p><b>読み方:</b> 検証者ノードは投票した枝の色(青=枝A/群0・橙=枝B/群1、フォークが無ければ緑)に染まる。
      各ブロックの <code>Σ</code> は部分木の累積得票(GHOST の判断材料)、<code>v</code> はそのブロック単体への直接得票。
      最新スロットのブロックには直接得票を <b>2/3 ライン</b>(赤線)と比較するバーが付く — 票が割れると
      どの枝も赤線に届かず justify できないことが見える。</p>
      <p><b>操作:</b> シナリオを選んで再生。緑=finalized / 水色=justified / 橙=正規ヘッド /
      くすんだ赤=reorgで外れた枝。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    rng: null,
    seed: 11,
    validators: [],
    blocks: [],
    genesis: null,
    nextLane: 0,
    currentSlot: 0,
    slotTimer: 0,
    interval: 0,
    auto: true,
    speed: 1,
    validatorCount: 24,
    scenario: "tempfork",
    scenarioButtons: [],
    particles: [],
    proposedThisSlot: false,
    votedThisSlot: false,
    partitioned: false,
    groupTip: {},
    competing: null,
    latestJustified: null,
    latestFinalized: null,
    reorgCount: 0,
    headBlock: null,
    canonical: new Set(),

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

    build() {
      this.rng = util.makeRng(this.seed * 8675309 + this.validatorCount + this.scenario.length);
      this.particles = [];
      // Slot 0 is genesis (no proposer); proposals begin at slot 1.
      this.currentSlot = 1;
      this.slotTimer = 0;
      this.interval = 0;
      this.proposedThisSlot = false;
      this.votedThisSlot = false;
      this.partitioned = false;
      this.groupTip = {};
      this.competing = null;
      this.reorgCount = 0;
      this.nextLane = 0;
      this.buildValidators();
      const genesis = {
        id: 0,
        slot: 0,
        parent: null,
        children: [],
        lane: 0,
        weight: this.validatorCount,
        root: util.toHexTag(0xa11ce, 4),
        justified: true,
        finalized: true,
        proposerGroup: -1,
      };
      this.blocks = [genesis];
      this.genesis = genesis;
      this.latestJustified = genesis;
      this.latestFinalized = genesis;
      this.headBlock = genesis;
      this.recomputeHead();
    },

    buildValidators() {
      const nodes = [];
      const count = this.validatorCount;
      let attempts = 0;
      while (nodes.length < count && attempts < count * 400) {
        attempts++;
        const angle = this.rng() * Math.PI * 2;
        const radius = Math.sqrt(this.rng()) * 0.36;
        const nx = 0.28 + Math.cos(angle) * radius * 0.9;
        const ny = 0.5 + Math.sin(angle) * radius;
        let tooClose = false;
        for (const other of nodes) {
          if (util.distance(nx, ny, other.nx, other.ny) < 0.62 / Math.sqrt(count)) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        nodes.push({ index: nodes.length, nx, ny, group: 0 });
      }
      while (nodes.length < count) {
        nodes.push({ index: nodes.length, nx: 0.12 + this.rng() * 0.42, ny: 0.16 + this.rng() * 0.66, group: 0 });
      }
      // The larger group (≈60%) is group 0, the rest group 1 (used by partition).
      const majoritySize = Math.round(count * 0.6);
      nodes.forEach((node, index) => (node.group = index < majoritySize ? 0 : 1));
      this.validators = nodes;
    },

    groupSize(group) {
      return this.validators.filter((v) => v.group === group).length;
    },

    /* ------------------------- tree helpers ------------------------- */
    createBlock(parent, proposerGroup) {
      const lane = parent.children.length === 0 ? parent.lane : this.nextLane + 1;
      if (parent.children.length > 0) this.nextLane += 1;
      const rootValue = (this.currentSlot * 2654435761) ^ (parent.id * 40503) ^ (proposerGroup * 7);
      const block = {
        id: this.blocks.length,
        slot: this.currentSlot,
        parent,
        children: [],
        lane,
        weight: 0,
        root: util.toHexTag(rootValue & 0xffff, 4),
        justified: false,
        finalized: false,
        proposerGroup,
      };
      parent.children.push(block);
      this.blocks.push(block);
      return block;
    },

    subtreeWeight(block, memo) {
      if (memo.has(block)) return memo.get(block);
      let total = block.weight;
      for (const child of block.children) total += this.subtreeWeight(child, memo);
      memo.set(block, total);
      return total;
    },

    /** LMD-GHOST: from the finalized root, always descend into the heaviest child. */
    recomputeHead() {
      const memo = new Map();
      let node = this.latestFinalized;
      while (node.children.length > 0) {
        let best = null;
        let bestWeight = -1;
        for (const child of node.children) {
          const weight = this.subtreeWeight(child, memo);
          if (weight > bestWeight || (weight === bestWeight && best && child.slot < best.slot)) {
            bestWeight = weight;
            best = child;
          }
        }
        node = best;
      }
      this.headBlock = node;
      this.canonical = new Set();
      let walk = node;
      while (walk) {
        this.canonical.add(walk);
        walk = walk.parent;
      }
    },

    /** Color a vote by which branch it lands on: blue/orange when forked, else green. */
    branchColor(block) {
      if (this.partitioned || this.competing) {
        return block.proposerGroup === 1 ? "#f6a52f" : "#2f6df6";
      }
      return colors.nodeHasMessage;
    },

    ancestorOf(maybeAncestor, block) {
      let walk = block;
      while (walk) {
        if (walk === maybeAncestor) return true;
        walk = walk.parent;
      }
      return false;
    },

    /* ------------------------- per-slot logic ------------------------- */
    applyScenarioTransitions() {
      if (this.scenario === "partition") {
        if (this.currentSlot === 2 && !this.partitioned) {
          this.partitioned = true;
          this.groupTip = { 0: this.headBlock, 1: this.headBlock };
        }
        if (this.currentSlot === 7 && this.partitioned) {
          this.partitioned = false; // heal: GHOST resolves to the heavier branch
        }
      }
    },

    propose() {
      this.proposedThisSlot = true;
      this.competing = null;
      for (const validator of this.validators) {
        validator.voted = false;
        validator.voteColor = null;
      }

      if (this.scenario === "partition" && this.partitioned) {
        const blockA = this.createBlock(this.groupTip[0], 0);
        const blockB = this.createBlock(this.groupTip[1], 1);
        this.groupTip[0] = blockA;
        this.groupTip[1] = blockB;
        this.broadcastFrom(this.proposerFor(0), blockA);
        this.broadcastFrom(this.proposerFor(1), blockB);
        return;
      }

      const head = this.headBlock;
      if (this.scenario === "tempfork" && this.currentSlot === 3) {
        const blockA = this.createBlock(head, 0);
        const blockB = this.createBlock(head, 1);
        this.competing = [blockA, blockB];
        this.broadcastFrom(this.proposerFor(0), blockA);
        return;
      }
      if (this.scenario === "equivocation" && this.currentSlot === 3) {
        const honest = this.createBlock(head, 0);
        const equiv = this.createBlock(head, 1);
        this.competing = [honest, equiv];
        this.broadcastFrom(this.proposerFor(0), honest);
        return;
      }
      const block = this.createBlock(head, 0);
      this.broadcastFrom(this.proposerFor(0), block);
    },

    proposerFor(group) {
      const pool = this.validators.filter((v) => v.group === group);
      if (!pool.length) return this.validators[0];
      return pool[this.currentSlot % pool.length];
    },

    broadcastFrom(proposer, block) {
      block.proposerIndex = proposer.index;
      for (const validator of this.validators) {
        if (validator.index === proposer.index) continue;
        this.particles.push({
          fromX: this.vx(proposer),
          fromY: this.vy(proposer),
          toX: this.vx(validator),
          toY: this.vy(validator),
          t: 0,
          duration: 0.45 + this.rng() * 0.3,
          color: colors.data,
        });
      }
    },

    castVotes() {
      this.votedThisSlot = true;
      for (const voter of this.validators) {
        let target;
        if (this.scenario === "partition" && this.partitioned) {
          target = this.groupTip[voter.group];
        } else if (this.competing) {
          // Split the vote: tempfork ≈ 55/45 by group; equivocation ≈ honest-heavy.
          target = voter.group === 0 ? this.competing[0] : this.competing[1];
        } else {
          target = this.headBlock;
        }
        if (target) {
          target.weight += 1;
          voter.voted = true;
          voter.voteColor = this.branchColor(target);
          this.particles.push({
            fromX: this.vx(voter),
            fromY: this.vy(voter),
            toX: this.blockX(target),
            toY: this.blockY(target),
            t: 0,
            duration: 0.5 + this.rng() * 0.4,
            color: voter.voteColor,
          });
        }
      }
      this.recomputeHead();
    },

    finishSlot() {
      const threshold = Math.ceil((2 * this.validatorCount) / 3);
      // A block justifies if it alone gathered a 2/3 supermajority this slot.
      const candidates = this.blocks.filter((b) => b.slot === this.currentSlot && !b.justified);
      for (const block of candidates) {
        if (block.weight >= threshold) {
          block.justified = true;
          const previousJustified = this.latestJustified;
          this.latestJustified = block;
          if (previousJustified && previousJustified.justified && this.ancestorOf(previousJustified, block)) {
            previousJustified.finalized = true;
            this.latestFinalized = previousJustified;
            let walk = previousJustified;
            while (walk) {
              walk.finalized = true;
              walk = walk.parent;
            }
          }
        }
      }
    },

    detectReorg(previousHead) {
      if (previousHead === this.headBlock) return;
      // Reorg if the old head is no longer on the canonical chain.
      if (!this.canonical.has(previousHead) && !this.ancestorOf(previousHead, this.headBlock)) {
        this.reorgCount += 1;
      }
    },

    advanceSlot() {
      const previousHead = this.headBlock;
      this.finishSlot();
      this.recomputeHead();
      this.detectReorg(previousHead);
      // After a temporary fork's slot, future slots build on GHOST head → converge.
      this.competing = null;
      this.currentSlot += 1;
      this.slotTimer = 0;
      this.interval = 0;
      this.proposedThisSlot = false;
      this.votedThisSlot = false;
      this.applyScenarioTransitions();
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      const dt = realDt * this.speed;
      if (this.auto) {
        this.slotTimer += dt;
        const interval = Math.min(INTERVAL_COUNT - 1, Math.floor(this.slotTimer / (SLOT_DURATION / INTERVAL_COUNT)));
        this.interval = interval;
        if (interval >= 0 && !this.proposedThisSlot) {
          this.propose();
          this.recomputeHead(); // head must point at the freshly proposed block before voting
        }
        if (interval >= 1 && !this.votedThisSlot) this.castVotes();
        if (this.slotTimer >= SLOT_DURATION) this.advanceSlot();
      }
      const surviving = [];
      for (const particle of this.particles) {
        particle.t += dt / particle.duration;
        if (particle.t < 1) surviving.push(particle);
      }
      this.particles = surviving;
    },

    stepOneSlot() {
      this.auto = false;
      if (!this.proposedThisSlot) {
        this.propose();
        this.recomputeHead();
      }
      if (!this.votedThisSlot) this.castVotes();
      this.particles = [];
      this.advanceSlot();
    },

    /* ------------------------- geometry ------------------------- */
    netLeft() {
      return 28;
    },
    netRight() {
      return this.width * 0.46;
    },
    netTop() {
      return 150;
    },
    netBottom() {
      return this.height - 60;
    },
    vx(node) {
      return this.netLeft() + node.nx * (this.netRight() - this.netLeft());
    },
    vy(node) {
      return this.netTop() + (node.ny - 0.12) * (this.netBottom() - this.netTop());
    },

    treeLeft() {
      return this.netRight() + 40;
    },
    treeRight() {
      return this.width - 24;
    },
    visibleMinSlot() {
      return Math.max(this.latestFinalized.slot, this.headBlock.slot - 8);
    },
    blockX(block) {
      const minSlot = this.visibleMinSlot();
      const span = Math.max(1, this.headBlock.slot - minSlot + 1);
      const columnWidth = (this.treeRight() - this.treeLeft() - 90) / span;
      return this.treeLeft() + (block.slot - minSlot) * columnWidth + 30;
    },
    blockY(block) {
      const laneCount = Math.max(1, this.nextLane + 1);
      const top = this.netTop() + 20;
      const usable = Math.min(220, this.netBottom() - top - 80);
      return top + (laneCount === 1 ? usable / 2 : (block.lane / Math.max(1, laneCount - 1)) * usable);
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderClock(ctx);
      this.renderNetwork(ctx);
      this.renderParticles(ctx);
      this.renderTree(ctx);
      this.renderLegend(ctx);
    },

    renderClock(ctx) {
      const left = 28;
      const status = this.partitioned ? "ネットワーク分断中 — finality 停止" : this.competing ? "フォーク発生 — 票が分裂" : "単一チェーン";
      draw.label(ctx, `Slot ${this.currentSlot}  ·  ${SCENARIOS[this.scenario].label}`, left, 22, colors.nodeSource, "bold 14px ui-monospace, monospace", "left");
      draw.label(ctx, status, this.width - 28, 22, this.partitioned || this.competing ? colors.prune : colors.textDim, "12px ui-monospace, monospace", "right");
      this.renderIntervalBar(ctx, 34);
      draw.label(ctx, INTERVAL_NARRATION[this.interval], this.width / 2, 92, colors.text, "12px ui-monospace, monospace");
    },

    renderIntervalBar(ctx, top) {
      const left = 28;
      const right = this.width - 28;
      const segWidth = (right - left) / INTERVAL_COUNT;
      const intervalLength = SLOT_DURATION / INTERVAL_COUNT;
      for (let i = 0; i < INTERVAL_COUNT; i++) {
        const x = left + i * segWidth;
        const active = i === this.interval;
        ctx.save();
        draw.roundedRect(ctx, x + 3, top, segWidth - 6, 26, 6);
        ctx.fillStyle = active ? "#16263d" : "#121a27";
        ctx.fill();
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeStyle = active ? colors.accent : colors.grid;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, INTERVAL_LABELS[i], x + segWidth / 2, top + 13, active ? colors.text : colors.textDim, "12px ui-monospace, monospace");
        if (active && this.auto) {
          const progress = util.clamp((this.slotTimer % intervalLength) / intervalLength, 0, 1);
          ctx.fillStyle = colors.accent;
          ctx.fillRect(x + 4, top + 23, (segWidth - 8) * progress, 2);
        }
      }
    },

    renderNetwork(ctx) {
      draw.label(ctx, "検証者 (§5)" + (this.partitioned ? " — 2群に分断" : ""), this.netLeft(), this.netTop() - 14, colors.textDim, "11px ui-monospace, monospace", "left");
      const proposerIndex = this.proposedThisSlot ? this.proposerFor(0).index : -1;
      for (const node of this.validators) {
        const x = this.vx(node);
        const y = this.vy(node);
        let fill = colors.node;
        if (this.partitioned) fill = node.group === 0 ? "#2f6df6" : "#f6a52f";
        // Once a validator has voted, tint it by the branch it voted for.
        if (node.voted && node.voteColor) fill = node.voteColor;
        if (node.index === proposerIndex) {
          draw.glow(ctx, x, y, 16, colors.nodeSource);
          fill = colors.nodeSource;
        }
        draw.disc(ctx, x, y, 6.5, fill, node.voted ? colors.text : colors.nodeStroke, 1.1);
      }
      if (this.partitioned) {
        draw.label(ctx, "群0 (60%)", this.netLeft(), this.netBottom() - 8, "#6fa0ff", "11px ui-monospace, monospace", "left");
        draw.label(ctx, "群1 (40%)", this.netLeft() + 110, this.netBottom() - 8, "#ffce8a", "11px ui-monospace, monospace", "left");
      }
    },

    renderParticles(ctx) {
      for (const particle of this.particles) {
        const x = util.lerp(particle.fromX, particle.toX, particle.t);
        const y = util.lerp(particle.fromY, particle.toY, particle.t);
        draw.disc(ctx, x, y, particle.color === colors.data ? 3.5 : 2.5, particle.color, null);
      }
    },

    renderTree(ctx) {
      draw.label(ctx, "フォーク木 + GHOST フォーク選択", this.treeLeft(), this.netTop() - 14, colors.textDim, "12px ui-monospace, monospace", "left");
      const minSlot = this.visibleMinSlot();
      const memo = new Map();
      // Edges.
      for (const block of this.blocks) {
        if (block.slot < minSlot || !block.parent || block.parent.slot < minSlot) continue;
        const onCanonical = this.canonical.has(block) && this.canonical.has(block.parent);
        draw.line(ctx, this.blockX(block.parent) + 16, this.blockY(block.parent), this.blockX(block) - 16, this.blockY(block), onCanonical ? colors.nodeHasMessage + "cc" : colors.peerEdge, onCanonical ? 2 : 1.2, !onCanonical);
      }
      // Blocks.
      for (const block of this.blocks) {
        if (block.slot < minSlot) continue;
        const x = this.blockX(block);
        const y = this.blockY(block);
        const orphaned = !this.canonical.has(block) && block.slot <= this.headBlock.slot;
        let stroke = colors.nodeStroke;
        if (block.finalized) stroke = colors.nodeHasMessage;
        else if (block.justified) stroke = colors.graft;
        else if (block === this.headBlock) stroke = colors.nodeSource;
        else if (orphaned) stroke = colors.prune;
        ctx.save();
        ctx.globalAlpha = orphaned ? 0.5 : 1;
        draw.roundedRect(ctx, x - 30, y - 17, 60, 34, 6);
        ctx.fillStyle = "#15202f";
        ctx.fill();
        ctx.lineWidth = block === this.headBlock ? 2.4 : 1.6;
        ctx.strokeStyle = stroke;
        ctx.stroke();
        ctx.restore();
        const labelText = block.slot === 0 ? "gen" : `s${block.slot}`;
        draw.label(ctx, `${labelText} ${block.root}`, x, y - 5, orphaned ? colors.textDim : colors.text, "9px ui-monospace, monospace");
        // Σ = accumulated subtree weight (GHOST); v = this block's direct votes.
        draw.label(ctx, `Σ${this.subtreeWeight(block, memo)} · v${block.weight}`, x, y + 8, orphaned ? colors.textDim : colors.accent, "9px ui-monospace, monospace");
        if (block === this.headBlock) draw.label(ctx, "◀ head", x + 34, y, colors.nodeSource, "10px ui-monospace, monospace", "left");
        // Newest-slot blocks: direct-weight bar vs the 2/3 justification line.
        if (block.slot === this.currentSlot && block.slot !== 0) {
          this.renderDirectWeightBar(ctx, x, y + 20, block);
        }
      }
    },

    renderDirectWeightBar(ctx, cx, top, block) {
      const barWidth = 56;
      const x = cx - barWidth / 2;
      const threshold = Math.ceil((2 * this.validatorCount) / 3);
      const reached = block.weight >= threshold;
      ctx.save();
      draw.roundedRect(ctx, x, top, barWidth, 5, 2);
      ctx.fillStyle = "#10161f";
      ctx.fill();
      ctx.restore();
      const fraction = util.clamp(block.weight / Math.max(1, this.validatorCount), 0, 1);
      ctx.fillStyle = reached ? colors.nodeHasMessage : colors.accent;
      ctx.fillRect(x + 0.5, top + 0.5, (barWidth - 1) * fraction, 4);
      const tx = x + barWidth * (threshold / Math.max(1, this.validatorCount));
      draw.line(ctx, tx, top - 2, tx, top + 7, colors.nodeTarget, 1.5, false);
    },

    renderLegend(ctx) {
      const items = [
        ["finalized / 投票済", colors.nodeHasMessage],
        ["justified", colors.graft],
        ["正規ヘッド / 提案者", colors.nodeSource],
        ["reorgで除外", colors.prune],
        ["枝A (群0) への票", "#2f6df6"],
        ["枝B (群1) への票", "#f6a52f"],
        ["2/3 閾値", colors.nodeTarget],
      ];
      let y = this.netBottom() - items.length * 16 - 4;
      const x = this.treeLeft();
      ctx.save();
      ctx.globalAlpha = 0.92;
      draw.roundedRect(ctx, x - 8, y - 14, 196, items.length * 16 + 12, 8);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();
      for (const [text, color] of items) {
        draw.disc(ctx, x + 2, y, 4, color, null);
        draw.label(ctx, text, x + 14, y, colors.textDim, "10px ui-monospace, monospace", "left");
        y += 16;
      }
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    orphanedCount() {
      return this.blocks.filter(
        (b) => b !== this.genesis && !this.canonical.has(b) && b.slot <= this.headBlock.slot,
      ).length;
    },

    getStats() {
      const memo = new Map();
      const tips = this.blocks.filter((b) => b.children.length === 0);
      const branchWeights = tips
        .map((tip) => this.subtreeWeight(tip, memo))
        .sort((a, b) => b - a);
      return [
        { label: "スロット / I", value: `${this.currentSlot} / I${this.interval}` },
        { label: "シナリオ", value: SCENARIOS[this.scenario].label },
        { label: "状態", value: this.partitioned ? "分断中" : this.competing ? "フォーク中" : "単一" },
        { label: "正規ヘッド", value: this.headBlock.slot === 0 ? "genesis" : `slot ${this.headBlock.slot}` },
        { label: "枝の数 (leaf)", value: tips.length },
        { label: "枝の重み (上位)", value: branchWeights.slice(0, 2).join(" / ") || "0" },
        { label: "孤立ブロック (枝落ち)", value: this.orphanedCount() },
        { label: "reorg (ヘッド切替)", value: this.reorgCount },
        { label: "latest justified", value: `slot ${this.latestJustified.slot}` },
        { label: "latest finalized", value: `slot ${this.latestFinalized.slot}` },
      ];
    },

    /* ------------------------- controls ------------------------- */
    updateActiveButtons() {
      this.scenarioButtons.forEach((button) => button.classList.toggle("primary", button.dataset.value === this.scenario));
    },

    buildControls(container) {
      const ui = P2P.ui;
      const scenarioGroup = ui.group("シナリオ");
      this.scenarioButtons = [];
      for (const key of Object.keys(SCENARIOS)) {
        const button = ui.button(SCENARIOS[key].label, () => {
          this.scenario = key;
          this.build();
          this.auto = true;
          playButton.textContent = "⏸ 一時停止";
          this.updateActiveButtons();
        });
        button.dataset.value = key;
        this.scenarioButtons.push(button);
        scenarioGroup.appendChild(button);
      }
      container.appendChild(scenarioGroup);

      const playback = ui.group("再生");
      const playButton = ui.button(this.auto ? "⏸ 一時停止" : "▶ 再生", () => {
        this.auto = !this.auto;
        playButton.textContent = this.auto ? "⏸ 一時停止" : "▶ 再生";
      }, "primary");
      playback.appendChild(playButton);
      playback.appendChild(ui.button("1スロット進める ▶", () => {
        this.stepOneSlot();
        playButton.textContent = "▶ 再生";
      }));
      playback.appendChild(ui.button("最初から ↻", () => {
        this.build();
        this.auto = true;
        playButton.textContent = "⏸ 一時停止";
      }));
      playback.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (v) => (this.speed = v)));
      container.appendChild(playback);

      const params = ui.group("ネットワーク");
      params.appendChild(ui.slider("検証者数", 12, 36, 2, this.validatorCount, (value) => {
        this.validatorCount = value;
        this.build();
      }));
      container.appendChild(params);

      this.updateActiveButtons();
    },
  };

  P2P.scenes.forks = scene;
})();
