/*
 * beacon.js — Capstone: the whole protocol running as a live beacon chain.
 *
 * One screen that ties every chapter together on the per-slot heartbeat:
 *   §3 Time      — the slot clock and its four intervals drive the cycle.
 *   §5 P2P       — a proposed block propagates across a validator mesh.
 *   §6 Consensus — validators attest (head/source/target); votes aggregate;
 *                  a 2/3 supermajority justifies a block; a continuous chain
 *                  of justified blocks finalizes earlier ones.
 *   §4 State     — the chain of blocks advances; head/justified/finalized move.
 *   §2 SSZ       — every block carries a hash-tree-root (short hex) and links
 *                  to its parent_root.
 *
 * It auto-runs as a living chain; pause, step by slot, and tune the validator
 * set and participation rate to see justification stall below the 2/3 line.
 */
"use strict";

(function registerBeacon() {
  const { util, draw, colors } = P2P;

  const SLOT_DURATION = 4.0; // simulated seconds per slot (4 intervals of 1s)
  const INTERVAL_COUNT = 4;

  const INTERVAL_NARRATION = [
    "Interval 0 — 提案者がブロックを生成し P2P で配信 (§3,§5)。提案者の票も同梱。",
    "Interval 1 — 検証者が attestation を生成: head / source / target を署名 (§6.2)。",
    "Interval 2 — aggregator が同一票を集約 (1署名へ)。セーフターゲットを計算 (§6.4)。",
    "Interval 3 — 票を受理しフォーク選択ヘッドを更新。次スロットで取り込み (§6.3)。",
  ];

  const scene = {
    id: "beacon",
    title: "ビーコンチェーン稼働",
    sectionRef: "2–6",
    descriptionHTML: `
      <p><b>全章を1本のスロット・ハートビートで統合した総まとめ。</b>
      プロトコルが「生きたチェーン」として動く様子を観察できる。</p>
      <p>毎スロット、4つのインターバル(§3)が次を駆動する:</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>提案 (I0):</b> 提案者がブロックを作り、検証者メッシュへ伝播 (§5)。
        各ブロックは <code>parent_root</code> で連結し、<code>hash_tree_root</code>(§2) を持つ。</li>
        <li><b>投票 (I1):</b> 検証者が attestation を生成。
        <code>source</code>(直近justified) → <code>target</code>(今回のブロック) → <code>head</code> (§6.2)。</li>
        <li><b>集約 (I2):</b> 同一票を1つに集約 (§6.4)。票が下の重みバーに積み上がる。</li>
        <li><b>受理 (I3):</b> フォーク選択ヘッドを更新。スロット終了時に判定。</li>
      </ol>
      <p><b>justification / finalization (§4,§6):</b> 1スロットの票が
      <code>3·票 ≥ 2·総数</code> (2/3) を超えるとそのブロックは <b>justified</b>。
      justified が連続すると一つ前が <b>finalized</b> (不可逆) になる。</p>
      <p><b>操作:</b> 「参加率」を 2/3 未満に下げると justification が止まる様子が見える。
      検証者数・速度も変更可。「1スロット進める」で1歩ずつ。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    rng: null,
    seed: 5,
    validators: [],
    mesh: [],
    chain: [],
    particles: [],
    attestationDots: [],
    currentSlot: 0,
    slotTimer: 0,
    interval: 0,
    auto: true,
    speed: 1,
    validatorCount: 24,
    participation: 0.85,
    votesAccrued: 0,
    latestJustified: 0,
    latestFinalized: 0,
    proposedThisSlot: false,
    attestedThisSlot: false,

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
      this.rng = util.makeRng(this.seed * 7919 + this.validatorCount);
      this.particles = [];
      this.attestationDots = [];
      // Slot 0 is the genesis slot (no proposer); proposals begin at slot 1.
      this.currentSlot = 1;
      this.slotTimer = 0;
      this.interval = 0;
      this.votesAccrued = 0;
      this.latestJustified = 0;
      this.latestFinalized = 0;
      this.proposedThisSlot = false;
      this.attestedThisSlot = false;
      this.buildValidators();
      // Genesis block (slot 0): justified + finalized by definition.
      this.chain = [
        {
          slot: 0,
          proposerIndex: -1,
          root: util.toHexTag(0xa11ce, 4),
          parentRoot: "0x0000",
          justified: true,
          finalized: true,
          weight: this.validatorCount,
        },
      ];
    },

    buildValidators() {
      const nodes = [];
      const count = this.validatorCount;
      // Cluster validators in the left-center region (normalized coords).
      let attempts = 0;
      while (nodes.length < count && attempts < count * 400) {
        attempts++;
        const angle = this.rng() * Math.PI * 2;
        const radius = Math.sqrt(this.rng()) * 0.34;
        const nx = 0.26 + Math.cos(angle) * radius * 0.9;
        const ny = 0.46 + Math.sin(angle) * radius;
        let tooClose = false;
        for (const other of nodes) {
          if (util.distance(nx, ny, other.nx, other.ny) < 0.62 / Math.sqrt(count)) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        nodes.push({ index: nodes.length, nx, ny, online: true, hasBlock: false });
      }
      // Guarantee exactly validatorCount nodes (relax spacing if needed) so
      // proposer indexing and the 2/3 threshold always use the real count.
      while (nodes.length < count) {
        nodes.push({
          index: nodes.length,
          nx: 0.1 + this.rng() * 0.42,
          ny: 0.12 + this.rng() * 0.72,
          online: true,
          hasBlock: false,
        });
      }
      this.validators = nodes;
      // Proximity mesh for the propagation flourish.
      this.mesh = nodes.map(() => new Set());
      for (const node of nodes) {
        const nearest = nodes
          .filter((other) => other !== node)
          .sort(
            (a, b) =>
              util.distance(node.nx, node.ny, a.nx, a.ny) -
              util.distance(node.nx, node.ny, b.nx, b.ny),
          )
          .slice(0, 3);
        for (const other of nearest) {
          this.mesh[node.index].add(other.index);
          this.mesh[other.index].add(node.index);
        }
      }
    },

    /* ------------------------- geometry ------------------------- */
    netLeft() {
      return 30;
    },
    netRight() {
      return this.width * 0.52;
    },
    netTop() {
      return 150;
    },
    netBottom() {
      return this.height - 190;
    },
    vx(node) {
      return this.netLeft() + node.nx * (this.netRight() - this.netLeft());
    },
    vy(node) {
      return this.netTop() + (node.ny - 0.12) * (this.netBottom() - this.netTop()) * 1.25;
    },
    onlineCount() {
      return this.validators.filter((v) => v.online).length;
    },
    threshold() {
      // 2/3 supermajority in validator-count units.
      return Math.ceil((2 * this.validatorCount) / 3);
    },

    /* ------------------------- per-slot events ------------------------- */
    proposeBlock() {
      this.proposedThisSlot = true;
      const parent = this.chain[this.chain.length - 1];
      const proposerIndex = this.currentSlot % this.validatorCount;
      const rootValue = (this.currentSlot * 2654435761) ^ (parent.weight * 40503);
      const block = {
        slot: this.currentSlot,
        proposerIndex,
        root: util.toHexTag(rootValue & 0xffff, 4),
        parentRoot: parent.root,
        justified: false,
        finalized: false,
        weight: 0,
      };
      this.chain.push(block);
      this.votesAccrued = 0;
      for (const validator of this.validators) {
        validator.hasBlock = false;
        validator.voted = false;
      }
      const proposer = this.validators[proposerIndex];
      if (proposer) proposer.hasBlock = true;
      // Propagate from the proposer to every validator (P2P broadcast flourish).
      for (const validator of this.validators) {
        if (validator.index === proposerIndex || !validator.online) continue;
        this.particles.push({
          fromIndex: proposerIndex,
          toIndex: validator.index,
          t: 0,
          duration: 0.5 + util.distance(this.vx(proposer), this.vy(proposer), this.vx(validator), this.vy(validator)) / 600,
        });
      }
    },

    castAttestations() {
      this.attestedThisSlot = true;
      // Pick a deterministic aggregator that collects the slot's attestations.
      this.aggregatorIndex = (this.currentSlot * 13 + 7) % this.validatorCount;
      // The attestation triple every voter signs this slot (§6.2):
      //   source = latest justified checkpoint, target = head = current block.
      const block = this.chain[this.chain.length - 1];
      const source = this.chain.find((b) => b.slot === this.latestJustified) || this.chain[0];
      this.attestTriple = { sourceSlot: source.slot, targetSlot: block.slot };
      const voters = this.validators.filter((v) => v.online && this.rng() < this.participation);
      this.expectedVotes = voters.length;
      // Each voter sends an attestation dot: voter → aggregator → chain.
      for (const voter of voters) {
        this.attestationDots.push({
          voterIndex: voter.index,
          fromX: this.vx(voter),
          fromY: this.vy(voter),
          t: 0,
          duration: 0.6 + this.rng() * 0.5,
          counted: false,
        });
      }
    },

    finishSlot() {
      const block = this.chain[this.chain.length - 1];
      block.weight = this.votesAccrued;
      // Justification: 3 * votes >= 2 * total validators.
      if (3 * this.votesAccrued >= 2 * this.validatorCount) {
        block.justified = true;
        const previousJustified = this.chain.find((b) => b.slot === this.latestJustified);
        this.latestJustified = block.slot;
        // Finalization: a justified block directly justifying on the prior
        // justified checkpoint finalizes that prior checkpoint.
        if (previousJustified && previousJustified.justified) {
          previousJustified.finalized = true;
          this.latestFinalized = previousJustified.slot;
          for (const b of this.chain) if (b.slot <= previousJustified.slot) b.finalized = true;
        }
      }
    },

    advanceSlot() {
      this.finishSlot();
      this.currentSlot++;
      this.slotTimer = 0;
      this.interval = 0;
      this.proposedThisSlot = false;
      this.attestedThisSlot = false;
      this.votesAccrued = 0;
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      const dt = realDt * this.speed;
      if (this.auto) {
        this.slotTimer += dt;
        this.tickIntervals();
        if (this.slotTimer >= SLOT_DURATION) this.advanceSlot();
      }
      this.advanceParticles(dt);
    },

    tickIntervals() {
      const interval = Math.min(INTERVAL_COUNT - 1, Math.floor(this.slotTimer / (SLOT_DURATION / INTERVAL_COUNT)));
      this.interval = interval;
      if (interval >= 0 && !this.proposedThisSlot) this.proposeBlock();
      if (interval >= 1 && !this.attestedThisSlot) this.castAttestations();
    },

    advanceParticles(dt) {
      const survivingParticles = [];
      for (const particle of this.particles) {
        particle.t += dt / particle.duration;
        if (particle.t < 1) survivingParticles.push(particle);
      }
      this.particles = survivingParticles;

      const block = this.chain[this.chain.length - 1];
      const aggregator = this.validators[this.aggregatorIndex] || null;
      this.aggX = aggregator ? this.vx(aggregator) : this.netRight();
      this.aggY = aggregator ? this.vy(aggregator) : this.netBottom();
      this.dotTarget = { x: this.netRight() + 40, y: this.height - 110 };

      let aggregating = 0;
      const survivingDots = [];
      for (const dot of this.attestationDots) {
        dot.t += dt / dot.duration;
        // First half (voter → aggregator) counts the vote at the aggregator.
        if (dot.t >= 0.5 && !dot.counted) {
          dot.counted = true;
          const voter = this.validators[dot.voterIndex];
          if (voter) voter.voted = true;
        }
        if (dot.t >= 0.5) aggregating++;
        if (dot.t >= 1) {
          this.votesAccrued = Math.min(this.expectedVotes || 0, this.votesAccrued + 1);
          if (block) block.weight = this.votesAccrued;
        } else {
          survivingDots.push(dot);
        }
      }
      this.attestationDots = survivingDots;
      this.aggregatingCount = aggregating;
    },

    /** Two-segment path for an attestation dot: voter → aggregator → chain. */
    dotPos(dot) {
      if (dot.t < 0.5) {
        const f = dot.t / 0.5;
        return { x: util.lerp(dot.fromX, this.aggX, f), y: util.lerp(dot.fromY, this.aggY, f) };
      }
      const f = (dot.t - 0.5) / 0.5;
      const target = this.dotTarget || { x: this.netRight(), y: this.height - 110 };
      return { x: util.lerp(this.aggX, target.x, f), y: util.lerp(this.aggY, target.y, f) };
    },

    stepOneSlot() {
      this.auto = false;
      // Run proposal + attestations immediately, accrue all votes, then finish.
      if (!this.proposedThisSlot) this.proposeBlock();
      if (!this.attestedThisSlot) this.castAttestations();
      for (const dot of this.attestationDots) {
        const voter = this.validators[dot.voterIndex];
        if (voter) voter.voted = true;
      }
      this.votesAccrued = this.expectedVotes || 0;
      this.attestationDots = [];
      this.advanceSlot();
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderClock(ctx);
      this.renderNetwork(ctx);
      this.renderChain(ctx);
      this.renderLegend(ctx);
    },

    renderClock(ctx) {
      const top = 24;
      const left = 30;
      const right = this.width - 30;
      const segWidth = (right - left) / INTERVAL_COUNT;
      draw.label(ctx, `Slot ${this.currentSlot}`, left, top + 2, colors.nodeSource, "bold 15px ui-monospace, monospace", "left");
      const labels = ["I0 提案", "I1 投票", "I2 集約", "I3 受理"];
      for (let i = 0; i < INTERVAL_COUNT; i++) {
        const x = left + i * segWidth;
        const active = i === this.interval;
        ctx.save();
        draw.roundedRect(ctx, x + 3, top + 12, segWidth - 6, 26, 6);
        ctx.fillStyle = active ? "#16263d" : "#121a27";
        ctx.fill();
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeStyle = active ? colors.accent : colors.grid;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, labels[i], x + segWidth / 2, top + 25, active ? colors.text : colors.textDim, "12px ui-monospace, monospace");
        // Sub-interval progress fill on the active segment.
        if (active && this.auto) {
          const intervalLength = SLOT_DURATION / INTERVAL_COUNT;
          const progress = util.clamp((this.slotTimer % intervalLength) / intervalLength, 0, 1);
          ctx.fillStyle = colors.accent;
          ctx.fillRect(x + 4, top + 35, (segWidth - 8) * progress, 2);
        }
      }
      draw.label(ctx, INTERVAL_NARRATION[this.interval], this.width / 2, top + 54, colors.text, "12px ui-monospace, monospace");
    },

    renderNetwork(ctx) {
      // Mesh edges.
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.peerEdge;
      ctx.beginPath();
      for (const node of this.validators) {
        for (const other of this.mesh[node.index]) {
          if (other <= node.index) continue;
          ctx.moveTo(this.vx(node), this.vy(node));
          ctx.lineTo(this.vx(this.validators[other]), this.vy(this.validators[other]));
        }
      }
      ctx.stroke();

      // Block-propagation pulses (proposer -> validators).
      for (const particle of this.particles) {
        const from = this.validators[particle.fromIndex];
        const to = this.validators[particle.toIndex];
        const x = util.lerp(this.vx(from), this.vx(to), particle.t);
        const y = util.lerp(this.vy(from), this.vy(to), particle.t);
        draw.disc(ctx, x, y, 3.5, colors.data, null);
      }

      // Attestation dots flowing voter → aggregator → chain (votes collected).
      for (const dot of this.attestationDots) {
        const pos = this.dotPos(dot);
        // Brighten as the vote crosses the aggregator into the aggregate.
        draw.disc(ctx, pos.x, pos.y, dot.t >= 0.5 ? 3 : 2.5, dot.t >= 0.5 ? colors.graft : colors.ihave, null);
      }

      // Validator nodes, colored by their role/state this slot.
      const proposerIndex = this.currentSlot % this.validatorCount;
      const aggregatorActive = this.attestedThisSlot && this.interval >= 2;
      for (const node of this.validators) {
        const x = this.vx(node);
        const y = this.vy(node);
        if (!node.online) {
          draw.disc(ctx, x, y, 6, colors.nodeDead, "#4a3340", 1);
          continue;
        }
        let fill = node.voted ? colors.nodeHasMessage : colors.node;
        let stroke = colors.nodeStroke;
        if (node.index === this.aggregatorIndex && aggregatorActive) {
          draw.glow(ctx, x, y, 18, colors.graft);
          stroke = colors.graft;
        }
        if (node.index === proposerIndex && this.proposedThisSlot) {
          draw.glow(ctx, x, y, 18, colors.nodeSource);
          fill = colors.nodeSource;
          stroke = colors.nodeSource;
        }
        draw.disc(ctx, x, y, 7, fill, stroke, 1.4);
      }
      draw.label(ctx, "検証者メッシュ (§5)", this.netLeft(), this.netTop() - 12, colors.textDim, "11px ui-monospace, monospace", "left");
      if (aggregatorActive) {
        const agg = this.validators[this.aggregatorIndex];
        if (agg) draw.label(ctx, `aggregator ▸ 集約 ${this.aggregatingCount || 0}`, this.vx(agg), this.vy(agg) - 16, colors.graft, "10px ui-monospace, monospace");
      }
    },

    renderChain(ctx) {
      const y = this.height - 150;
      draw.label(ctx, "ブロックチェーン (§4) — parent_root 連結 / hash_tree_root (§2)", 30, y - 14, colors.textDim, "12px ui-monospace, monospace", "left");
      const boxWidth = 96;
      const gap = 16;
      const visible = this.chain.slice(-8);
      const totalWidth = visible.length * (boxWidth + gap);
      const startX = Math.max(30, this.width - totalWidth - 30);
      let previousCenter = null;
      const centerBySlot = new Map();
      visible.forEach((block, index) => {
        const x = startX + index * (boxWidth + gap);
        centerBySlot.set(block.slot, x + boxWidth / 2);
        let stroke = colors.nodeStroke;
        let badge = "";
        if (block.finalized) {
          stroke = colors.nodeHasMessage;
          badge = "finalized";
        } else if (block.justified) {
          stroke = colors.graft;
          badge = "justified";
        } else if (block.slot === this.currentSlot) {
          stroke = colors.nodeSource;
          badge = "head";
        }
        ctx.save();
        draw.roundedRect(ctx, x, y, boxWidth, 56, 7);
        ctx.fillStyle = "#15202f";
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = stroke;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, block.slot === 0 ? "genesis" : `slot ${block.slot}`, x + boxWidth / 2, y + 13, colors.text, "11px ui-monospace, monospace");
        draw.label(ctx, `root ${block.root}`, x + boxWidth / 2, y + 29, colors.textDim, "10px ui-monospace, monospace");
        if (badge) draw.label(ctx, badge, x + boxWidth / 2, y + 45, stroke, "10px ui-monospace, monospace");
        if (previousCenter !== null) {
          draw.arrow(ctx, x - 2, y + 28, previousCenter + 2, y + 28, colors.textDim, 1.2);
        }
        previousCenter = x + boxWidth;
      });

      // FFG attestation triple (source → target/head) arced over the chain.
      this.renderVoteTriple(ctx, centerBySlot, y);

      // Vote-weight bar for the current slot vs the 2/3 threshold.
      this.renderWeightBar(ctx, startX, y + 78);
    },

    renderVoteTriple(ctx, centerBySlot, blockY) {
      if (!this.attestTriple || !this.attestedThisSlot) return;
      const sourceX = centerBySlot.get(this.attestTriple.sourceSlot);
      const targetX = centerBySlot.get(this.attestTriple.targetSlot);
      if (sourceX == null || targetX == null) return;
      const top = blockY - 8;
      const midX = (sourceX + targetX) / 2;
      ctx.save();
      ctx.strokeStyle = colors.graft;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sourceX, top);
      ctx.quadraticCurveTo(midX, top - 34, targetX, top);
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, "FFG投票: source → target (§6.2)", midX, top - 42, colors.textDim, "10px ui-monospace, monospace");
      draw.label(ctx, "source", sourceX, top - 12, colors.graft, "9px ui-monospace, monospace");
      if (targetX !== sourceX) draw.label(ctx, "target/head", targetX, top - 12, colors.nodeSource, "9px ui-monospace, monospace");
    },

    renderWeightBar(ctx, x, y) {
      const barWidth = Math.min(360, this.width - x - 40);
      if (barWidth < 80) return;
      const thresholdFraction = this.threshold() / this.validatorCount;
      const voteFraction = this.validatorCount ? this.votesAccrued / this.validatorCount : 0;
      draw.label(ctx, "今スロットの得票 (§6 justification)", x, y - 12, colors.textDim, "11px ui-monospace, monospace", "left");
      ctx.save();
      draw.roundedRect(ctx, x, y, barWidth, 16, 4);
      ctx.fillStyle = "#10161f";
      ctx.fill();
      ctx.restore();
      const reached = 3 * this.votesAccrued >= 2 * this.validatorCount;
      ctx.fillStyle = reached ? colors.nodeHasMessage : colors.accent;
      ctx.fillRect(x + 1, y + 1, Math.max(0, (barWidth - 2) * util.clamp(voteFraction, 0, 1)), 14);
      // 2/3 threshold marker.
      const thresholdX = x + barWidth * thresholdFraction;
      draw.line(ctx, thresholdX, y - 3, thresholdX, y + 19, colors.nodeTarget, 2, false);
      draw.label(ctx, "2/3", thresholdX, y + 28, colors.nodeTarget, "10px ui-monospace, monospace");
      draw.label(ctx, `${this.votesAccrued} / ${this.validatorCount}`, x + barWidth + 8, y + 8, colors.text, "11px ui-monospace, monospace", "left");
    },

    renderLegend(ctx) {
      const items = [
        ["提案ブロック伝播", colors.data],
        ["attestation (voter→agg)", colors.ihave],
        ["aggregator / 集約済み票", colors.graft],
        ["提案者 / target・head", colors.nodeSource],
        ["投票済み検証者 / finalized", colors.nodeHasMessage],
        ["2/3 閾値", colors.nodeTarget],
      ];
      let y = this.netTop() + 4;
      const x = this.netRight() + 24;
      ctx.save();
      ctx.globalAlpha = 0.94;
      draw.roundedRect(ctx, x - 10, y - 14, 232, items.length * 18 + 14, 8);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();
      draw.label(ctx, "凡例", x, y, colors.textDim, "11px ui-monospace, monospace", "left");
      y += 18;
      for (const [text, color] of items) {
        draw.disc(ctx, x + 4, y, 4, color, null);
        draw.label(ctx, text, x + 16, y, colors.textDim, "11px ui-monospace, monospace", "left");
        y += 18;
      }
      draw.label(ctx, "右下: チェーンと得票バー", x, y + 2, colors.textDim, "10px ui-monospace, monospace", "left");
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    getStats() {
      const reached = 3 * this.votesAccrued >= 2 * this.validatorCount;
      const percent = this.validatorCount ? Math.round((this.votesAccrued / this.validatorCount) * 100) : 0;
      return [
        { label: "スロット / インターバル", value: `${this.currentSlot} / I${this.interval}` },
        { label: "検証者数", value: `${this.validatorCount} (online ${this.onlineCount()})` },
        { label: "参加率", value: `${Math.round(this.participation * 100)}%` },
        { label: "今スロット得票", value: `${this.votesAccrued} / ${this.validatorCount} (${percent}%)` },
        { label: "2/3 到達", value: reached ? "はい (justify)" : "いいえ" },
        { label: "aggregator", value: this.attestedThisSlot ? `#${this.aggregatorIndex} (集約 ${this.aggregatingCount || 0})` : "—" },
        { label: "latest justified", value: `slot ${this.latestJustified}` },
        { label: "latest finalized", value: `slot ${this.latestFinalized}` },
        { label: "ブロック数", value: this.chain.length },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;
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
      params.appendChild(ui.slider("検証者数", 12, 40, 2, this.validatorCount, (value) => {
        this.validatorCount = value;
        this.build();
      }));
      params.appendChild(ui.slider("参加率 %", 40, 100, 5, Math.round(this.participation * 100), (value) => {
        this.participation = value / 100;
      }));
      container.appendChild(params);
    },
  };

  P2P.scenes.beacon = scene;
})();
