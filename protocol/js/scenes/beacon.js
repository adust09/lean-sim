/*
 * beacon.js — Capstone: the whole protocol running as a live beacon chain,
 * now including fork scenarios (§6.3) on a fork TREE with LMD-GHOST.
 *
 * One screen tying every chapter together on the per-slot heartbeat:
 *   §3 Time      — the slot clock and its five intervals drive the cycle.
 *   §5 P2P       — a proposed block propagates across a validator mesh.
 *   §6 Consensus — validators attest (pending→accepted); votes aggregate;
 *                  a 2/3 supermajority justifies; GHOST picks the head; forks
 *                  reorg, partitions stall finality.
 *   §4 State     — Υ runs at block-processing time; justification lags one slot.
 *   §2 SSZ       — each block carries a hash-tree-root and a parent link.
 *
 * The fork TREE, GHOST head selection, and scenario engine live in forkmodel.js;
 * this scene drives the per-slot pipeline and all rendering.
 */
"use strict";

(function registerBeacon() {
  const { util, draw, colors, ease } = P2P;

  const SLOT_DURATION = 12.0; // real cadence: 12s per slot (5 intervals of 2.4s)
  const INTERVAL_COUNT = 5;   // INTERVALS_PER_SLOT (config.py)
  // Per-interval wall-time at speed 1 (12s / 5 = 2.4s). Every interval's motion
  // is sized to this so it finishes exactly when the interval ends.
  const INTERVAL_DURATION = SLOT_DURATION / INTERVAL_COUNT;
  const BRANCH_COLOR = ["#2f6df6", "#f6a52f"]; // group 0 / group 1 during a fork

  // The five-interval slot pipeline — action points per timeline.py tick_interval.
  const INTERVAL_NARRATION = [
    "Interval 0 — 提案着弾 / 前票受理: proposer がブロックと state_root を配信。各ノードが Υ(§4.3) を再実行し照合し、前スロットの保留集約票を受理して justification を確定 (accept_new_attestations)。",
    "Interval 1 — Attestation Broadcast: 検証者が attestation を配信 (§6.2)。票は pending で保留(この区間は処理点なし=票がネットワークに伝搬する猶予)。",
    "Interval 2 — 署名集約: aggregator が今スロットの票を1本の証明に束ねブロードキャスト (§6.4 aggregate)。",
    "Interval 3 — Safe Target Update: 直近で 2/3 を集めたブロック (セーフターゲット) を確定し高速確定の視点を安定化 (update_safe_target)。",
    "Interval 4 — Attestation Acceptance: pending の票を受理し fork choice に投入。GHOST でヘッド再計算 (§6.3 accept_new_attestations)。",
  ];

  // Υ's 4-phase transition pipeline, run when a block is processed at I0 (§4.3).
  const UPSILON_PHASES = ["① 時刻同期", "② ヘッダ検証", "③ ペイロード実行", "④ state root"];

  const scene = {
    id: "beacon",
    title: "ビーコンチェーン稼働",
    sectionRef: "2–6",
    descriptionHTML: `
      <p><b>全章を1本のスロット・ハートビートで統合した総まとめ。</b> 5つのインターバル(§3)が毎スロットを駆動する:</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>提案/受理 (I0):</b> proposer がブロックを作り伝播 (§5)。<b>状態遷移 Υ</b>(§4.3 の4フェーズ)を各ノードが再実行し <code>state_root</code> 照合。前スロットの保留集約票をここで受理し justification 確定 (accept_new_attestations)。</li>
        <li><b>投票 (I1):</b> 検証者が attestation を配信。票は <b>pending</b>(保留)。処理点なし。</li>
        <li><b>集約 (I2):</b> aggregator が同一票を1本 <code>Sagg</code> に集約 (§6.4 aggregate / 右パネル)。</li>
        <li><b>セーフターゲット (I3):</b> 直近で 2/3 を集めたブロックを確定し視点を安定化 (update_safe_target)。</li>
        <li><b>受理 (I4):</b> pending を受理し fork choice に投入。<b>GHOST</b> でヘッド再計算。</li>
      </ol>
      <p><b>2つの軸:</b> I0–I4 は fork-choice 軸。<b>Υ はブロック処理軸</b>で、票は集約として次ブロックに載り、その Υ 処理で justification が<b>1スロット遅れて</b>確定する。</p>
      <p><b>フォーク (§6.3):</b> シナリオを選ぶとチェーンが木になり、正規ヘッドは <b>GHOST</b>(最重部分木)で決まる。<b>一時的フォーク</b>=票が割れ収束し軽い枝は reorg。<b>分断(60/40)</b>=各群が別枝を伸ばし、どちらも 2/3 未達で<b>finality 停止</b>、回復で重い枝が勝つ。<b>二重提案</b>=equivocation 枝は枯れる。検証者ノードは投票先の枝色(青=群0 / 橙=群1)に染まる。</p>
      <p><b>深いリオルグ (秘匿枝の後出し):</b> 結託した多数派(群0 ≈60%)が slot3 で<b>秘匿枝</b>(紫・破線)を分岐させ、正直な少数派(群1 ≈40%)に公開チェーンを伸ばさせたまま、裏で票を貯める(GHOST には見えないので公開枝がヘッドのまま伸びる)。slot7 で秘匿枝を<b>後出し公開</b>すると貯めた票が一気に効き、GHOST が秘匿枝に切り替わって分岐以降の正直ブロックを<b>まとめて reorg</b>(統計の「深度」が巻き戻し段数)。ただし多数派でも 2/3 には届かず<b>単独では finalize できない</b>。そして <b>finalized より下は決して巻き戻せない</b>ため、reorg 深度は finality で頭打ちになる — これが 3SF が守るもの。</p>
      <p><b>操作:</b> シナリオ・参加率・検証者数・速度を変更可。「1スロット進める」で1歩ずつ。</p>
      <p><b>色凡例:</b><br>
      <span style="color:#36d399">●</span> 提案ブロック伝播 / accepted / finalized &nbsp;
      <span style="color:#a78bfa">●</span> attestation→aggregator &nbsp;
      <span style="color:#22d3ee">●</span> 集約署名 (Sagg) &nbsp;
      <span style="color:#f59e0b">●</span> pending 投票 (I1) &nbsp;
      <span style="color:#2f6df6">●</span> 枝A (群0) 票 &nbsp;
      <span style="color:#f6a52f">●</span> 枝B (群1) 票 &nbsp;
      <span style="color:#f87171">●</span> safe target / 2/3 閾値 &nbsp;
      <span style="color:#a78bfa">▱</span> 秘匿枝 (破線=withheld・後出しで reorg)</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    rng: null,
    seed: 5,
    validators: [],
    mesh: [],
    fork: null,
    scenario: "normal",
    scenarioButtons: [],
    particles: [],
    attestationDots: [],
    aggregateParticles: [],
    collectedSigs: 0,
    aggregatePulse: 0,
    pendingAggregates: [],
    upsilonApplied: [],
    lastProcessedBlock: null,
    slotTally: null,
    headSlotVotes: 0,
    currentSlot: 0,
    slotTimer: 0,
    interval: 0,
    auto: true,
    speed: 1,
    validatorCount: 24,
    participation: 0.85,
    votesAccrued: 0,
    safeTargetSlot: 0,
    safeTargetPulse: 0,        // I3 motion: expanding-ring pulse on the safe block
    acceptPulse: 0,            // I4 motion: acceptance ripple on accepted nodes
    headMoveFrom: null,        // I4 motion: GHOST head glide (old head)
    headMoveTo: null,          //            (new head)
    headMoveProgress: 1,
    proposedThisSlot: false,
    attestedThisSlot: false,
    aggregatedThisSlot: false,
    safeTargetThisSlot: false,
    acceptedThisSlot: false,

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
      this.rng = util.makeRng(this.seed * 7919 + this.validatorCount + this.scenario.length);
      this.particles = [];
      this.attestationDots = [];
      this.aggregateParticles = [];
      this.collectedSigs = 0;
      this.aggregatePulse = 0;
      this.pendingAggregates = [];
      this.upsilonApplied = [];
      this.lastProcessedBlock = null;
      this.headSlotVotes = 0;
      this.currentSlot = 1; // slot 0 is genesis; proposals begin at slot 1
      this.slotTimer = 0;
      this.interval = 0;
      this.votesAccrued = 0;
      this.safeTargetSlot = 0;
      this.safeTargetPulse = 0;
      this.acceptPulse = 0;
      this.headMoveFrom = null;
      this.headMoveTo = null;
      this.headMoveProgress = 1;
      this.proposedThisSlot = false;
      this.attestedThisSlot = false;
      this.aggregatedThisSlot = false;
      this.safeTargetThisSlot = false;
      this.acceptedThisSlot = false;
      this.buildValidators();
      this.fork = P2P.createForkModel(this.validatorCount);
    },

    buildValidators() {
      const nodes = [];
      const count = this.validatorCount;
      let attempts = 0;
      while (nodes.length < count && attempts < count * 400) {
        attempts++;
        const angle = this.rng() * Math.PI * 2;
        const radius = Math.sqrt(this.rng()) * 0.34;
        const nx = 0.26 + Math.cos(angle) * radius * 0.9;
        const ny = 0.46 + Math.sin(angle) * radius;
        let tooClose = false;
        for (const other of nodes) {
          if (util.distance(nx, ny, other.nx, other.ny) < 0.62 / Math.sqrt(count)) { tooClose = true; break; }
        }
        if (tooClose) continue;
        nodes.push({ index: nodes.length, nx, ny, online: true, hasBlock: false, voteState: "none", group: 0 });
      }
      while (nodes.length < count) {
        nodes.push({ index: nodes.length, nx: 0.1 + this.rng() * 0.42, ny: 0.12 + this.rng() * 0.72, online: true, hasBlock: false, voteState: "none", group: 0 });
      }
      // The larger group (≈60%) is group 0, the rest group 1 (used by partition).
      const majoritySize = Math.round(count * 0.6);
      nodes.forEach((node, index) => (node.group = index < majoritySize ? 0 : 1));
      this.validators = nodes;
      this.mesh = nodes.map(() => new Set());
      for (const node of nodes) {
        const nearest = nodes
          .filter((other) => other !== node)
          .sort((a, b) => util.distance(node.nx, node.ny, a.nx, a.ny) - util.distance(node.nx, node.ny, b.nx, b.ny))
          .slice(0, 3);
        for (const other of nearest) {
          this.mesh[node.index].add(other.index);
          this.mesh[other.index].add(node.index);
        }
      }
    },

    /* ------------------------- geometry ------------------------- */
    netLeft() { return 30; },
    netRight() { return this.width * 0.52; },
    netTop() { return 150; },
    netBottom() { return this.height - 190; },
    vx(node) { return this.netLeft() + node.nx * (this.netRight() - this.netLeft()); },
    vy(node) { return this.netTop() + (node.ny - 0.12) * (this.netBottom() - this.netTop()) * 1.25; },
    onlineCount() { return this.validators.filter((v) => v.online).length; },
    threshold() { return Math.ceil((2 * this.validatorCount) / 3); },
    forkActive() { return !!(this.fork && (this.fork.competing || this.fork.partitioned)); },

    proposerForGroup(group) {
      const pool = this.validators.filter((v) => v.group === group && v.online);
      const list = pool.length ? pool : this.validators;
      return list[this.currentSlot % list.length];
    },

    /* ------------------------- per-slot events ------------------------- */
    proposeBlock() {
      this.proposedThisSlot = true;
      const proposed = this.fork.proposeSlot(this.scenario, this.currentSlot);
      this.lastProcessedBlock = proposed[0].block;
      // I0 also processes the new block: Υ applies the aggregates it carries.
      this.processStateTransition(proposed[0].block);
      this.fork.recomputeHead();
      this.votesAccrued = 0;
      for (const validator of this.validators) { validator.hasBlock = false; validator.voteState = "none"; }
      for (const { block, group } of proposed) {
        const proposer = this.proposerForGroup(group);
        block.proposerIndex = proposer.index;
        proposer.hasBlock = true;
        if (block.hidden) continue; // withheld branch is not broadcast — no propagation particles
        // Normalize by the farthest target so the last block lands exactly at I0's end.
        const targets = this.validators.filter((v) => v.index !== proposer.index && v.online);
        const maxDist = Math.max(1, ...targets.map((v) => util.distance(this.vx(proposer), this.vy(proposer), this.vx(v), this.vy(v))));
        for (const validator of targets) {
          // I0 block propagation: nearer nodes receive earlier; the farthest at I0's end.
          const reach = util.distance(this.vx(proposer), this.vy(proposer), this.vx(validator), this.vy(validator)) / maxDist;
          const duration = INTERVAL_DURATION * (0.45 + 0.55 * reach);
          this.particles.push({ fromIndex: proposer.index, toIndex: validator.index, t: 0, duration });
        }
      }
    },

    /** State transition Υ(S, B): justification advances only when a block is processed. */
    processStateTransition(newBlock) {
      newBlock.included = this.pendingAggregates.slice();
      this.upsilonApplied = [];
      for (const agg of this.pendingAggregates) {
        agg.target.stateWeight = agg.votes;
        if (agg.votes >= this.fork.threshold()) { this.fork.justify(agg.target); this.upsilonApplied.push(agg.target.slot); }
      }
      this.pendingAggregates = [];
    },

    /** I1 — Attestation Broadcast: attesters vote (possibly split by scenario). */
    castAttestations() {
      this.attestedThisSlot = true;
      this.collectedSigs = 0;
      this.aggregateParticles = [];
      this.aggregatePulse = 0;
      this.aggregatorIndex = (this.currentSlot * 13 + 7) % this.validatorCount;
      const head = this.fork.headBlock;
      this.attestTriple = { sourceSlot: this.fork.latestJustified.slot, targetSlot: head.slot };
      const voters = this.validators.filter((v) => v.online && this.rng() < this.participation);
      this.voters = voters;
      this.expectedVotes = voters.length;
      for (const voter of voters) {
        voter.voteTarget = this.fork.voteTargetFor(voter.group, this.scenario);
        // I1 voting: staggered, but the last dot lands exactly at interval 1's end.
        this.attestationDots.push({ voterIndex: voter.index, fromX: this.vx(voter), fromY: this.vy(voter), t: 0, duration: INTERVAL_DURATION * (0.6 + 0.4 * this.rng()) });
      }
    },

    /** I2 — Signature Aggregation: the aggregator bundles the slot's pending votes
     *  into one aggregate (Sagg) and broadcasts it toward the chain. Tallying the
     *  votes per target happens here; acceptance into fork choice waits for I4. */
    aggregateVotes() {
      this.aggregatedThisSlot = true;
      const tally = new Map();
      for (const voter of this.voters || []) {
        if (voter.voteState === "pending" && voter.voteTarget) {
          tally.set(voter.voteTarget, (tally.get(voter.voteTarget) || 0) + 1);
        }
      }
      this.slotTally = tally;
      this.headSlotVotes = tally.size ? Math.max(...tally.values()) : 0; // leading branch's votes
      const tgt = this.dotTarget || { x: this.netRight() + 40, y: this.netTop() + 404 };
      // I2 aggregation: the Sagg bundle travels the whole interval, landing at I2's end.
      if (this.expectedVotes > 0) this.aggregateParticles.push({ t: 0, duration: INTERVAL_DURATION, sigCount: this.collectedSigs, toX: tgt.x, toY: tgt.y });
    },

    /** I3 — Safe Target Update: anchor on the latest block with a 2/3 majority. */
    updateSafeTarget() {
      this.safeTargetThisSlot = true;
      this.safeTargetSlot = this.fork.latestJustified.slot;
      this.safeTargetPulse = 1; // motion: ring pulse on the anchored safe block
    },

    /** I4 — Attestation Acceptance: pending votes apply to fork choice (GHOST head moves). */
    acceptAttestations() {
      this.acceptedThisSlot = true;
      const previousHead = this.fork.headBlock;
      for (const voter of this.voters || []) {
        if (voter.voteState === "pending" && voter.voteTarget) {
          voter.voteState = "accepted";
          voter.voteTarget.weight += 1;
        }
      }
      this.fork.recomputeHead();
      // motion: ripple over the just-accepted nodes + glide the head marker
      // from the previous head to the recomputed GHOST head.
      this.acceptPulse = 1;
      this.headMoveFrom = previousHead;
      this.headMoveTo = this.fork.headBlock;
      this.headMoveProgress = 0;
    },

    /** Slot end: each block voted this slot becomes an aggregate, pooled for the
     *  next block to include. Justification is committed later by Υ (one-slot lag). */
    finishSlot() {
      for (const [block, votes] of this.slotTally || []) {
        this.pendingAggregates.push({ target: block, votes });
      }
      this.slotTally = null;
    },

    advanceSlot() {
      const previousHead = this.fork.headBlock;
      this.finishSlot();
      this.fork.recomputeHead();
      this.fork.detectReorg(previousHead);
      this.fork.competing = null;
      this.currentSlot++;
      this.slotTimer = 0;
      this.interval = 0;
      this.proposedThisSlot = false;
      this.attestedThisSlot = false;
      this.aggregatedThisSlot = false;
      this.safeTargetThisSlot = false;
      this.acceptedThisSlot = false;
      this.safeTargetPulse = 0;
      this.acceptPulse = 0;
      this.headMoveTo = null;
      this.headMoveProgress = 1;
      this.votesAccrued = 0;
      this.fork.applyScenarioTransitions(this.scenario, this.currentSlot);
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
      this.interval = Math.min(INTERVAL_COUNT - 1, Math.floor(this.slotTimer / (SLOT_DURATION / INTERVAL_COUNT)));
      if (this.interval >= 0 && !this.proposedThisSlot) this.proposeBlock();
      if (this.interval >= 1 && !this.attestedThisSlot) this.castAttestations();
      if (this.interval >= 2 && !this.aggregatedThisSlot) this.aggregateVotes();
      if (this.interval >= 3 && !this.safeTargetThisSlot) this.updateSafeTarget();
      if (this.interval >= 4 && !this.acceptedThisSlot) this.acceptAttestations();
    },

    advanceParticles(dt) {
      const survivingParticles = [];
      for (const particle of this.particles) {
        particle.t += dt / particle.duration;
        if (particle.t < 1) survivingParticles.push(particle);
        else if (this.validators[particle.toIndex]) this.validators[particle.toIndex].hasBlock = true;
      }
      this.particles = survivingParticles;

      const aggregator = this.validators[this.aggregatorIndex] || null;
      this.aggX = aggregator ? this.vx(aggregator) : this.netRight();
      this.aggY = aggregator ? this.vy(aggregator) : this.netBottom();
      this.dotTarget = { x: this.netRight() + 40, y: this.netTop() + 404 };

      // I1 — attestations fold into the aggregator; each marks its voter PENDING.
      const survivingDots = [];
      for (const dot of this.attestationDots) {
        dot.t += dt / dot.duration;
        if (dot.t >= 1) {
          this.collectedSigs += 1;
          const voter = this.validators[dot.voterIndex];
          if (voter && voter.voteState === "none") voter.voteState = "pending";
          this.aggregatePulse = 1;
        } else {
          survivingDots.push(dot);
        }
      }
      this.attestationDots = survivingDots;
      this.aggregatePulse = Math.max(0, this.aggregatePulse - dt * 3.5);

      // I3 / I4 motion timers: ring pulse, acceptance ripple, head glide.
      // I3 / I4 motions each span exactly one interval so they end on its boundary.
      this.safeTargetPulse = Math.max(0, this.safeTargetPulse - dt / INTERVAL_DURATION);
      this.acceptPulse = Math.max(0, this.acceptPulse - dt / INTERVAL_DURATION);
      if (this.headMoveTo) this.headMoveProgress = Math.min(1, this.headMoveProgress + dt / INTERVAL_DURATION);

      // I3 — the aggregate bundle flies to the chain; the weight bar fills to the
      // leading branch's vote count (so a 60/40 split visibly stalls below 2/3).
      const survivingBundles = [];
      for (const bundle of this.aggregateParticles) {
        bundle.t += dt / bundle.duration;
        this.votesAccrued = Math.round((this.headSlotVotes || 0) * util.clamp(bundle.t, 0, 1));
        if (bundle.t < 1) survivingBundles.push(bundle);
      }
      this.aggregateParticles = survivingBundles;
      this.aggregatingCount = this.collectedSigs;
    },

    dotPos(dot) {
      const f = ease.outCubic(util.clamp(dot.t, 0, 1));
      return { x: util.lerp(dot.fromX, this.aggX, f), y: util.lerp(dot.fromY, this.aggY, f) };
    },
    bundlePos(bundle) {
      const f = ease.inOutCubic(util.clamp(bundle.t, 0, 1));
      return { x: util.lerp(this.aggX, bundle.toX, f), y: util.lerp(this.aggY, bundle.toY, f) };
    },

    stepOneSlot() {
      this.auto = false;
      if (!this.proposedThisSlot) this.proposeBlock();
      if (!this.attestedThisSlot) this.castAttestations();
      // Manual step skips particle travel; mark voters pending so I2 can tally them.
      for (const voter of this.voters || []) { if (voter.voteState === "none") voter.voteState = "pending"; }
      this.collectedSigs = this.expectedVotes || 0;
      if (!this.aggregatedThisSlot) this.aggregateVotes();
      if (!this.safeTargetThisSlot) this.updateSafeTarget();
      if (!this.acceptedThisSlot) this.acceptAttestations();
      this.votesAccrued = this.headSlotVotes || 0;
      this.attestationDots = [];
      this.aggregateParticles = [];
      this.advanceSlot();
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderClock(ctx);
      this.renderNetwork(ctx);
      this.renderAggregatePanel(ctx);
      this.renderUpsilonPipeline(ctx);
      this.renderChain(ctx);
    },

    renderClock(ctx) {
      const top = 24;
      const left = 30;
      const right = this.width - 30;
      const segWidth = (right - left) / INTERVAL_COUNT;
      draw.label(ctx, `Slot ${this.currentSlot}`, left, top + 2, colors.nodeSource, "bold 15px ui-monospace, monospace", "left");
      const labels = ["I0 提案/受理", "I1 投票", "I2 集約", "I3 safe", "I4 受理"];
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

      for (const particle of this.particles) {
        const from = this.validators[particle.fromIndex];
        const to = this.validators[particle.toIndex];
        draw.disc(ctx, util.lerp(this.vx(from), this.vx(to), particle.t), util.lerp(this.vy(from), this.vy(to), particle.t), 3.5, colors.data, null);
      }

      for (const dot of this.attestationDots) {
        const pos = this.dotPos(dot);
        const near = dot.t > 0.55;
        ctx.save();
        ctx.globalAlpha = util.lerp(1, 0.4, util.clamp(dot.t, 0, 1));
        if (near) draw.glow(ctx, pos.x, pos.y, 9, colors.graft);
        draw.disc(ctx, pos.x, pos.y, near ? 3 : 2.5, near ? colors.graft : colors.ihave, null);
        ctx.restore();
      }
      for (const bundle of this.aggregateParticles) {
        const pos = this.bundlePos(bundle);
        const radius = 4 + Math.min(6, bundle.sigCount * 0.3);
        draw.glow(ctx, pos.x, pos.y, radius + 9, colors.graft);
        draw.disc(ctx, pos.x, pos.y, radius, colors.graft, colors.text, 1.2);
        draw.label(ctx, "集約署名", pos.x, pos.y - radius - 8, colors.graft, "9px ui-monospace, monospace");
      }

      const proposerIndex = this.proposerForGroup(0).index;
      const aggregatorActive = this.attestedThisSlot;
      const forked = this.forkActive();
      for (const node of this.validators) {
        const x = this.vx(node);
        const y = this.vy(node);
        if (!node.online) { draw.disc(ctx, x, y, 6, colors.nodeDead, "#4a3340", 1); continue; }
        let fill = node.voteState === "accepted"
          ? (forked ? BRANCH_COLOR[node.group] : colors.nodeHasMessage)
          : node.voteState === "pending" ? colors.iwant : colors.node;
        let stroke = colors.nodeStroke;
        if (node.index === this.aggregatorIndex && aggregatorActive) {
          draw.glow(ctx, x, y, 18 + 10 * this.aggregatePulse, colors.graft);
          if (this.aggregatePulse > 0.02) draw.disc(ctx, x, y, 9 + 11 * this.aggregatePulse, null, colors.graft, 1.6);
          stroke = colors.graft;
        }
        if (node.index === proposerIndex && this.proposedThisSlot) {
          draw.glow(ctx, x, y, 18, colors.nodeSource);
          fill = colors.nodeSource;
          stroke = colors.nodeSource;
        }
        // I4 acceptance ripple: an expanding ring over each just-accepted node.
        if (this.acceptPulse > 0.02 && node.voteState === "accepted") {
          ctx.save();
          ctx.globalAlpha = this.acceptPulse * 0.7;
          draw.disc(ctx, x, y, 7 + 12 * (1 - this.acceptPulse), null, colors.nodeHasMessage, 1.6);
          ctx.restore();
        }
        draw.disc(ctx, x, y, 7, fill, stroke, 1.4);
      }
      draw.label(ctx, "検証者メッシュ (§5)" + (this.fork.partitioned ? " — 2群に分断 (青60/橙40)" : ""), this.netLeft(), this.netTop() - 12, colors.textDim, "11px ui-monospace, monospace", "left");
      if (aggregatorActive) {
        const agg = this.validators[this.aggregatorIndex];
        if (agg) draw.label(ctx, `aggregator ▸ ${this.collectedSigs}署名 → 1`, this.vx(agg), this.vy(agg) - 18, colors.graft, "10px ui-monospace, monospace");
      }
    },

    /** The aggregate object being built this slot (§6.4 / Fig 6.4): AttestationData + bitfield + N→1. */
    renderAggregatePanel(ctx) {
      const x = this.netRight() + 20;
      const y = this.netTop() + 220; // below the Υ state-transition panel
      const width = this.width - x - 28;
      const height = 152;
      if (width < 190 || y + height > this.height - 170) return;
      ctx.save();
      draw.roundedRect(ctx, x, y, width, height, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = this.attestedThisSlot ? colors.graft + "99" : colors.grid;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, "集約 Aggregate (§6.4 / Fig 6.4)", x + 12, y + 16, colors.accent, "bold 11px ui-monospace, monospace", "left");
      const head = this.fork.headBlock;
      const triple = this.attestTriple || { sourceSlot: this.fork.latestJustified.slot, targetSlot: head.slot };
      draw.label(ctx, `AttestationData  source s${triple.sourceSlot} · target s${triple.targetSlot} · head ${head.root}`, x + 12, y + 36, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, "participation bitfield (橙=pending / 緑=accepted):", x + 12, y + 56, colors.textDim, "10px ui-monospace, monospace", "left");
      this.renderBitfield(ctx, x + 12, y + 66, width - 24);
      const pop = this.validators.filter((v) => v.voteState !== "none").length;
      draw.label(ctx, `${this.collectedSigs} XMSS署名 → 1 集約署名 (Sagg)`, x + 12, y + height - 28, colors.graft, "11px ui-monospace, monospace", "left");
      draw.label(ctx, `popcount = ${pop} / ${this.validatorCount}`, x + 12, y + height - 13, colors.text, "10px ui-monospace, monospace", "left");
    },

    renderBitfield(ctx, x, y, width) {
      const count = this.validatorCount;
      const gap = 2;
      const perRow = util.clamp(Math.floor(width / 13), 8, count);
      const cell = Math.max(8, Math.min(16, Math.floor(width / perRow) - gap));
      for (let i = 0; i < count; i++) {
        const cx = x + (i % perRow) * (cell + gap);
        const cy = y + Math.floor(i / perRow) * (cell + gap);
        const node = this.validators[i];
        const state = node ? node.voteState : "none";
        const online = node ? node.online : true;
        const color = state === "accepted" ? colors.nodeHasMessage : state === "pending" ? colors.iwant : null;
        ctx.save();
        draw.roundedRect(ctx, cx, cy, cell, cell, 3);
        ctx.fillStyle = color ? color + "55" : online ? "#15202f" : "#2a1822";
        ctx.fill();
        ctx.strokeStyle = color || (online ? colors.grid : "#4a3340");
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        if (cell >= 12) draw.label(ctx, color ? "1" : "0", cx + cell / 2, cy + cell / 2, color || colors.textDim, "9px ui-monospace, monospace");
      }
    },

    /** Υ state transition pipeline (§4.3): a 4-phase strip lighting up 1→4 as the I0 block is processed. */
    renderUpsilonPipeline(ctx) {
      const x = this.netRight() + 20;
      const y = this.netTop() + 144; // above the aggregate panel
      const width = this.width - x - 28;
      if (width < 300 || y + 64 > this.height - 150) return;
      const active = this.interval === 0 && this.proposedThisSlot;
      ctx.save();
      draw.roundedRect(ctx, x, y, width, 64, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = active ? colors.nodeActive + "99" : colors.grid;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      const reVerified = this.validators.filter((v) => v.hasBlock).length;
      const title = active
        ? `Υ(S,B) §4.3 — proposer#${this.proposerForGroup(0).index} 算出 → ${reVerified}/${this.onlineCount()} ノード再実行・state_root 照合✓`
        : "状態遷移 Υ(S,B) — ブロック処理パイプライン (§4.3)";
      draw.label(ctx, title, x + 12, y + 15, active ? colors.nodeActive : colors.textDim, "bold 10px ui-monospace, monospace", "left");
      const phase = active ? util.clamp(Math.floor(this.slotTimer / (INTERVAL_DURATION / 4)), 0, 4) : -1;
      const chipWidth = (width - 24 - 18) / 4;
      for (let i = 0; i < UPSILON_PHASES.length; i++) {
        const cx = x + 12 + i * (chipWidth + 6);
        const cy = y + 24;
        const done = i < phase;
        const on = i === phase;
        ctx.save();
        draw.roundedRect(ctx, cx, cy, chipWidth, 20, 5);
        ctx.fillStyle = on ? "#16263d" : "#121a27";
        ctx.fill();
        ctx.lineWidth = on ? 2 : 1;
        ctx.strokeStyle = done ? colors.nodeHasMessage : on ? colors.nodeActive : colors.grid;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, (done ? "✓ " : "") + UPSILON_PHASES[i], cx + chipWidth / 2, cy + 10, done ? colors.nodeHasMessage : on ? colors.text : colors.textDim, "9px ui-monospace, monospace");
      }
      const incl = (this.lastProcessedBlock && this.lastProcessedBlock.included || []).map((a) => "s" + a.target.slot).join(",");
      const just = this.upsilonApplied || [];
      const detail = !active ? "次の提案(I0)でブロックを処理し4フェーズを実行する"
        : !incl ? "③ Consensus Execution: 取り込む集約なし"
        : `③ Consensus Execution: incl agg(${incl})` + (just.length ? ` → s${just.join(",s")} justified 確定` : " → 2/3未達で justify せず");
      draw.label(ctx, detail, x + 12, y + 56, active ? colors.text : colors.textDim, "10px ui-monospace, monospace", "left");
    },

    /** The bottom area: the fork tree (§6.3 / GHOST) plus the per-slot weight bar. */
    renderChain(ctx) {
      draw.label(ctx, `フォーク木 + GHOST フォーク選択 (§4,§6.3) · ${P2P.forkScenarios[this.scenario].label}`, 30, this.height - 188, colors.textDim, "12px ui-monospace, monospace", "left");
      // The vote gauge moved up into the right column, so the bottom row is free:
      // extend the tree to full width — unless a short canvas drops the chain
      // level with the right-column panels, in which case stop before them.
      const chainTop = this.height - 172;
      const panelsBottom = this.netTop() + 412; // gauge bottom in the right column
      const rightLimit = chainTop >= panelsBottom ? this.width - 30 : this.netRight() - 10;
      const box = { x: 30, y: chainTop, width: rightLimit - 30, height: 92 };
      this.fork.renderTree(ctx, box);
      // I3 safe-target motion: expanding-ring pulse + badge on the anchored block.
      const safe = this.fork.latestJustified;
      if (this.safeTargetThisSlot && safe.slot >= this.fork.visibleMinSlot()) {
        const sx = this.fork.blockX(safe, box);
        const sy = this.fork.blockY(safe, box);
        if (this.safeTargetPulse > 0.01) {
          ctx.save();
          ctx.globalAlpha = this.safeTargetPulse;
          draw.disc(ctx, sx, sy, util.lerp(10, 30, 1 - this.safeTargetPulse), null, colors.nodeActive, 2);
          ctx.restore();
        }
        draw.label(ctx, "◆ safe target", sx, sy - 22, colors.nodeActive, "9px ui-monospace, monospace");
      }

      // I4 acceptance motion: glide a head marker from the old head to the
      // recomputed GHOST head, then hold it there for the rest of the slot.
      if (this.acceptedThisSlot && this.headMoveTo && this.headMoveTo.slot >= this.fork.visibleMinSlot()) {
        const fromBlock = (this.headMoveFrom && this.headMoveFrom.slot >= this.fork.visibleMinSlot())
          ? this.headMoveFrom : this.headMoveTo;
        const f = ease.inOutCubic(util.clamp(this.headMoveProgress, 0, 1));
        const hx = util.lerp(this.fork.blockX(fromBlock, box), this.fork.blockX(this.headMoveTo, box), f);
        const hy = util.lerp(this.fork.blockY(fromBlock, box), this.fork.blockY(this.headMoveTo, box), f);
        draw.glow(ctx, hx, hy, 15 + 8 * this.acceptPulse, colors.nodeHasMessage);
        draw.disc(ctx, hx, hy, 5, null, colors.nodeHasMessage, 1.8);
        draw.label(ctx, "▶ GHOST head", hx, hy - 22, colors.nodeHasMessage, "9px ui-monospace, monospace");
      }

      // Voting gauge sits in the right column, directly under the aggregate panel.
      this.renderWeightBar(ctx, this.netRight() + 20, this.netTop() + 396);
    },

    renderWeightBar(ctx, x, y) {
      const barWidth = Math.min(330, this.width - x - 36);
      if (barWidth < 80) return;
      const thresholdFraction = this.threshold() / this.validatorCount;
      const voteFraction = this.validatorCount ? this.votesAccrued / this.validatorCount : 0;
      draw.label(ctx, "先頭枝の今スロット得票 (§6)", x, y - 12, colors.textDim, "11px ui-monospace, monospace", "left");
      ctx.save();
      draw.roundedRect(ctx, x, y, barWidth, 16, 4);
      ctx.fillStyle = "#10161f";
      ctx.fill();
      ctx.restore();
      const reached = 3 * this.votesAccrued >= 2 * this.validatorCount;
      ctx.fillStyle = reached ? colors.nodeHasMessage : colors.accent;
      ctx.fillRect(x + 1, y + 1, Math.max(0, (barWidth - 2) * util.clamp(voteFraction, 0, 1)), 14);
      const thresholdX = x + barWidth * thresholdFraction;
      draw.line(ctx, thresholdX, y - 3, thresholdX, y + 19, colors.nodeTarget, 2, false);
      draw.label(ctx, "2/3", thresholdX, y + 28, colors.nodeTarget, "10px ui-monospace, monospace");
      draw.label(ctx, `${this.votesAccrued} / ${this.validatorCount}`, x + barWidth + 8, y + 8, colors.text, "11px ui-monospace, monospace", "left");
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    getStats() {
      const phase = ["提案/受理", "投票 (pending)", "集約", "セーフターゲット", "受理 (accepted)"][this.interval] || "—";
      const memo = new Map();
      const branchWeights = this.fork.tips().map((t) => this.fork.subtreeWeight(t, memo)).sort((a, b) => b - a);
      const state = this.fork.partitioned ? "分断中" : this.fork.attacking ? "秘匿構築中" : this.fork.competing ? "フォーク中" : "単一";
      return [
        { label: "スロット / I", value: `${this.currentSlot} / I${this.interval} ${phase}` },
        { label: "シナリオ / 状態", value: `${P2P.forkScenarios[this.scenario].label} (${state})` },
        { label: "検証者数 / 参加率", value: `${this.validatorCount} (online ${this.onlineCount()}) / ${Math.round(this.participation * 100)}%` },
        { label: "正規ヘッド (GHOST)", value: this.fork.headBlock.slot === 0 ? "genesis" : `slot ${this.fork.headBlock.slot}` },
        { label: "枝の重み (上位)", value: branchWeights.slice(0, 2).join(" / ") || "0" },
        { label: "先頭枝の得票", value: `${this.votesAccrued} / ${this.validatorCount}` },
        { label: "孤立 / reorg (最大深度)", value: `${this.fork.orphanedCount()} / ${this.fork.reorgCount} (深度${this.fork.reorgDepth})` },
        { label: "pending 集約 (Υ待ち)", value: (this.pendingAggregates || []).map((a) => `s${a.target.slot}(${a.votes})`).join(",") || "—" },
        { label: "latest justified (Υ)", value: `slot ${this.fork.latestJustified.slot}` },
        { label: "latest finalized", value: `slot ${this.fork.latestFinalized.slot}` },
      ];
    },

    /* ------------------------- controls ------------------------- */
    updateScenarioButtons() {
      this.scenarioButtons.forEach((b) => b.classList.toggle("primary", b.dataset.value === this.scenario));
    },

    buildControls(container) {
      const ui = P2P.ui;
      const playback = ui.group("再生");
      const playButton = ui.button(this.auto ? "⏸ 一時停止" : "▶ 再生", () => {
        this.auto = !this.auto;
        playButton.textContent = this.auto ? "⏸ 一時停止" : "▶ 再生";
      }, "primary");
      playback.appendChild(playButton);
      playback.appendChild(ui.button("1スロット進める ▶", () => { this.stepOneSlot(); playButton.textContent = "▶ 再生"; }));
      playback.appendChild(ui.button("最初から ↻", () => { this.build(); this.auto = true; playButton.textContent = "⏸ 一時停止"; }));
      playback.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (v) => (this.speed = v)));
      container.appendChild(playback);

      const scenarioGroup = ui.group("シナリオ (§6.3)");
      this.scenarioButtons = [];
      for (const key of Object.keys(P2P.forkScenarios)) {
        const button = ui.button(P2P.forkScenarios[key].label, () => {
          this.scenario = key;
          this.build();
          this.auto = true;
          playButton.textContent = "⏸ 一時停止";
          this.updateScenarioButtons();
        });
        button.dataset.value = key;
        this.scenarioButtons.push(button);
        scenarioGroup.appendChild(button);
      }
      container.appendChild(scenarioGroup);
      this.updateScenarioButtons();

      const params = ui.group("ネットワーク");
      params.appendChild(ui.slider("検証者数", 12, 40, 2, this.validatorCount, (value) => { this.validatorCount = value; this.build(); }));
      params.appendChild(ui.slider("参加率 %", 40, 100, 5, Math.round(this.participation * 100), (value) => { this.participation = value / 100; }));
      container.appendChild(params);
    },
  };

  P2P.scenes.beacon = scene;
})();
