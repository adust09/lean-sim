/*
 * timinggame.js — Proposal timing vs. block propagation.
 * Reference: spec/forks/lstar/timeline.py (tick_interval: aggregate @ interval 2,
 *            update_safe_target @ interval 3), config.py (INTERVALS_PER_SLOT=5,
 *            800 ms/interval, GOSSIP_DISPARITY_INTERVALS=1).
 *
 * leanSpec does NOT impose a hard "attestation deadline" inside a slot, and it
 * does not model MEV rewards. What it does have is fixed fork-choice processing
 * points: at interval 2 aggregators bundle the slot's votes into proofs, and at
 * interval 3 the safe target advances from the freshest votes (fast
 * confirmation). A proposer broadcasts at slot start; the later (or slower) a
 * block propagates, the fewer validators have received it by the interval-2
 * aggregation point — so fewer votes are bundled and a 2/3 supermajority for
 * fast confirmation may be missed that slot.
 *
 * Axes:
 *   X — time within the slot (0 → Ts = 4 s), 5 intervals of 800 ms
 *   Y — cumulative fraction of the network that has received the block (0–100 %)
 *
 * Propagation model: logistic S-curve starting at publish time p that climbs
 * to ~100 % over ~1.5 s of simulated time.
 *
 * Soft target: reach at the interval-2 aggregation point (1.6 s) ≥ 2/3 means
 * the block's votes can be bundled in time to advance the safe target at
 * interval 3 — i.e. it qualifies for fast confirmation this slot.
 */
"use strict";

(function registerTimingGame() {
  const { util, draw, colors, ease } = P2P;

  const SLOT_DURATION = 4;          // Ts in seconds
  const INTERVAL_DURATION = 0.8;    // Ti = MILLISECONDS_PER_INTERVAL = 800 ms
  const INTERVAL_COUNT = 5;         // INTERVALS_PER_SLOT
  const AGGREGATION_POINT = 2 * INTERVAL_DURATION;  // interval 2 start = 1.6 s — aggregate()
  const SAFE_TARGET_POINT = 3 * INTERVAL_DURATION;  // interval 3 start = 2.4 s — update_safe_target()
  const PROPAGATION_SPEED = 3.5;  // logistic steepness — how fast gossip spreads
  const PROPAGATION_MIDPOINT_OFFSET = 0.75; // seconds after p that reach hits 50 %

  /* Reference curves shown alongside the user's chosen publish time. */
  const REFERENCE_EARLY_PUBLISH_TIME = 0.1;  // proposer publishes at slot start
  const REFERENCE_LATE_PUBLISH_TIME = 1.5;   // proposer delays past the aggregation point

  const SUPERMAJORITY = 2 / 3; // 3 * votes >= 2 * total (state_transition.py)

  /* 5 interval roles per timeline.py (short labels for the X axis). */
  const INTERVAL_LABELS = [
    "I0 投票受理",
    "I1 待機",
    "I2 集約",
    "I3 safe更新",
    "I4 投票受理",
  ];
  const INTERVAL_TINTS = [
    colors.nodeHasMessage + "10",
    colors.textDim + "0c",
    colors.nodeSource + "18",
    colors.graft + "14",
    colors.nodeHasMessage + "10",
  ];

  /**
   * Logistic reach function: fraction of the network (0–1) that has received
   * a block published at `publishTime`, evaluated at elapsed time `elapsed`
   * (both in seconds within the slot).
   */
  function networkReachFraction(publishTime, elapsed) {
    if (elapsed <= publishTime) return 0;
    const timeSincePublish = elapsed - publishTime;
    const logisticInput = PROPAGATION_SPEED * (timeSincePublish - PROPAGATION_MIDPOINT_OFFSET);
    return 1 / (1 + Math.exp(-logisticInput));
  }

  const scene = {
    id: "timinggame",
    title: "タイミングゲーム",
    sectionRef: "timeline.py",
    descriptionHTML: `
      <p><b>提案タイミングと伝搬</b>：提案者は各スロット先頭でブロックを
      ブロードキャストします。leanSpec には<b>スロット内の固定投票デッドラインは無く</b>、
      MEV 報酬もモデル化されません。代わりにフォークチョイスの処理点が固定されています
      (<code>timeline.py</code>):</p>
      <ul>
        <li><b>Interval 2（1.6 s）= 署名集約点</b>：アグリゲータがその時点までに
          集まった票を証明に束ねる (<code>aggregate</code>)。</li>
        <li><b>Interval 3（2.4 s）= セーフターゲット更新点</b>：束ねた最新票から
          safe target を前進させ高速確定 (<code>update_safe_target</code>)。</li>
      </ul>
      <p><b>伝搬モデル（S字曲線）:</b> ブロックは発行後 ~0.75 秒で 50 %、~1.5 秒で
      ~100 % に到達する logistic で近似します。提案が遅い/伝搬が遅いほど、
      <b>集約点（1.6 s）</b>までにブロックを受け取ったバリデータが減り、束ねられる票が
      減って、その スロットで <b>2/3 supermajority</b> による高速確定に届かなくなります。</p>
      <ul>
        <li><b>判定:</b> 集約点での到達率 ≥ 2/3 → ✓ そのスロットの高速確定に間に合う</li>
      </ul>
      <p>※ 高速確定に間に合わなくても、ブロックは無効化されません。後続の投票受理
      (interval 4) や次スロット以降でフォークチョイスに反映されます。</p>
      <p><b>色凡例 (グラフの線):</b><br>
      <span style="color:#36d399">―</span> 早期提案 (参考) &nbsp;
      <span style="color:#f59e0b">―</span> 遅延提案 (参考) &nbsp;
      <span style="color:#60a5fa">―</span> あなたの提案</p>`,

    /* ---- state ---- */
    width: 0,
    height: 0,
    publishTime: 0.1,       // p — user-controlled block publish time (seconds in slot)
    animationClock: 0,      // drives the "animate propagation" playback
    isAnimating: false,
    showReferenceEarlyPublish: true,
    showReferenceLatePublish: true,
    hoverX: -1,             // canvas X of mouse for cross-hair

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.animationClock = 0;
      this.isAnimating = false;
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* ---- coordinate helpers ---- */
    plotLeft(canvasWidth) {
      return Math.floor(canvasWidth * 0.13);
    },
    plotRight(canvasWidth) {
      return Math.floor(canvasWidth * 0.88);
    },
    plotTop(canvasHeight) {
      return Math.floor(canvasHeight * 0.10);
    },
    plotBottom(canvasHeight) {
      return Math.floor(canvasHeight * 0.70);
    },

    timeToX(slotSeconds, canvasWidth) {
      const plotLeft = this.plotLeft(canvasWidth);
      const plotRight = this.plotRight(canvasWidth);
      return plotLeft + (slotSeconds / SLOT_DURATION) * (plotRight - plotLeft);
    },

    reachToY(reachFraction, canvasHeight) {
      const plotTop = this.plotTop(canvasHeight);
      const plotBottom = this.plotBottom(canvasHeight);
      return plotBottom - reachFraction * (plotBottom - plotTop);
    },

    /* ---- update ---- */
    update(realDt) {
      if (this.isAnimating) {
        this.animationClock += realDt * 1.2;
        if (this.animationClock >= SLOT_DURATION) {
          this.animationClock = SLOT_DURATION;
          this.isAnimating = false;
        }
      }
    },

    /* ---- render ---- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderPlot(ctx);
      this.renderVerdict(ctx);
    },

    /* ---- main chart ---- */
    renderPlot(ctx) {
      const plotLeft = this.plotLeft(this.width);
      const plotRight = this.plotRight(this.width);
      const plotTop = this.plotTop(this.height);
      const plotBottom = this.plotBottom(this.height);
      const plotWidth = plotRight - plotLeft;
      const plotHeight = plotBottom - plotTop;

      /* Chart area background */
      ctx.save();
      draw.roundedRect(ctx, plotLeft - 2, plotTop - 2, plotWidth + 4, plotHeight + 4, 6);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.restore();

      /* Interval background shading — 5 intervals of 800 ms */
      for (let intervalIndex = 0; intervalIndex < INTERVAL_COUNT; intervalIndex++) {
        const xStart = this.timeToX(intervalIndex * INTERVAL_DURATION, this.width);
        const xEnd = this.timeToX((intervalIndex + 1) * INTERVAL_DURATION, this.width);
        ctx.fillStyle = INTERVAL_TINTS[intervalIndex];
        ctx.fillRect(xStart, plotTop, xEnd - xStart, plotHeight);
      }

      /* Interval boundary lines at 0.8 s multiples */
      for (let boundary = 1; boundary < INTERVAL_COUNT; boundary++) {
        const xPos = this.timeToX(boundary * INTERVAL_DURATION, this.width);
        draw.line(ctx, xPos, plotTop, xPos, plotBottom, colors.grid, 1, false);
      }

      /* Aggregation point (interval 2 = 1.6 s) — the soft target */
      const aggregationX = this.timeToX(AGGREGATION_POINT, this.width);
      draw.line(ctx, aggregationX, plotTop, aggregationX, plotBottom, colors.nodeSource, 2, false);
      draw.label(
        ctx,
        "集約点 I2 (1.6s)",
        aggregationX + 4,
        plotTop + 14,
        colors.nodeSource,
        "bold 11px ui-monospace, monospace",
        "left",
      );

      /* Safe-target point (interval 3 = 2.4 s) */
      const safeTargetX = this.timeToX(SAFE_TARGET_POINT, this.width);
      draw.line(ctx, safeTargetX, plotTop, safeTargetX, plotBottom, colors.graft + "aa", 1.5, true);
      draw.label(
        ctx,
        "safe更新 I3 (2.4s)",
        safeTargetX + 4,
        plotTop + 30,
        colors.graft + "cc",
        "10px ui-monospace, monospace",
        "left",
      );

      /* 2/3 supermajority horizontal line */
      const thresholdY = this.reachToY(SUPERMAJORITY, this.height);
      draw.line(ctx, plotLeft, thresholdY, plotRight, thresholdY, colors.nodeHasMessage + "70", 1.5, true);
      draw.label(
        ctx,
        "2/3 supermajority",
        plotLeft + 4,
        thresholdY - 9,
        colors.nodeHasMessage + "cc",
        "10px ui-monospace, monospace",
        "left",
      );

      /* Y axis grid lines and labels */
      for (let reachPercent = 0; reachPercent <= 100; reachPercent += 20) {
        const yPos = this.reachToY(reachPercent / 100, this.height);
        draw.line(ctx, plotLeft, yPos, plotRight, yPos, colors.grid, 1, false);
        draw.label(
          ctx,
          `${reachPercent}%`,
          plotLeft - 8,
          yPos,
          colors.textDim,
          "10px ui-monospace, monospace",
          "right",
        );
      }

      /* X axis ticks at each interval boundary (0, 0.8, 1.6, 2.4, 3.2, 4.0 s) */
      for (let tickIndex = 0; tickIndex <= INTERVAL_COUNT; tickIndex++) {
        const tickSeconds = tickIndex * INTERVAL_DURATION;
        const xPos = this.timeToX(tickSeconds, this.width);
        draw.line(ctx, xPos, plotBottom, xPos, plotBottom + 5, colors.textDim, 1, false);
        draw.label(
          ctx,
          `${tickSeconds.toFixed(1)}s`,
          xPos,
          plotBottom + 14,
          colors.textDim,
          "9px ui-monospace, monospace",
        );
      }

      /* Interval labels along the X axis */
      for (let intervalIndex = 0; intervalIndex < INTERVAL_COUNT; intervalIndex++) {
        const xCenter = this.timeToX((intervalIndex + 0.5) * INTERVAL_DURATION, this.width);
        draw.label(
          ctx,
          INTERVAL_LABELS[intervalIndex],
          xCenter,
          plotBottom + 28,
          colors.textDim,
          "8px ui-monospace, monospace",
        );
      }

      /* Axis labels */
      draw.label(
        ctx,
        "スロット内経過時間 (秒) — 5 インターバル × 800ms",
        (plotLeft + plotRight) / 2,
        plotBottom + 44,
        colors.textDim,
        "11px ui-monospace, monospace",
      );
      ctx.save();
      ctx.translate(plotLeft - 38, (plotTop + plotBottom) / 2);
      ctx.rotate(-Math.PI / 2);
      draw.label(ctx, "ネットワーク到達率 (%)", 0, 0, colors.textDim, "11px ui-monospace, monospace");
      ctx.restore();

      /* Reference curve: early publish (green — high reach) */
      if (this.showReferenceEarlyPublish) {
        this.renderPropagationCurve(
          ctx, REFERENCE_EARLY_PUBLISH_TIME, colors.nodeHasMessage,
          SLOT_DURATION, 0.45,
        );
      }

      /* Reference curve: late publish (orange — low reach) */
      if (this.showReferenceLatePublish) {
        this.renderPropagationCurve(
          ctx, REFERENCE_LATE_PUBLISH_TIME, colors.iwant,
          SLOT_DURATION, 0.45,
        );
      }

      /* User's chosen publish curve — drawn last and brightest */
      const userAnimationEnd = this.isAnimating ? this.animationClock : SLOT_DURATION;
      this.renderPropagationCurve(
        ctx, this.publishTime, colors.accent,
        userAnimationEnd, 1.0,
      );

      /* Publish time marker on X axis */
      const publishX = this.timeToX(this.publishTime, this.width);
      draw.line(ctx, publishX, plotBottom, publishX, plotBottom - 18, colors.accent, 2, false);
      draw.disc(ctx, publishX, plotBottom - 20, 5, colors.accent, null);
      draw.label(
        ctx,
        `p = ${this.publishTime.toFixed(2)} s`,
        publishX,
        plotBottom - 34,
        colors.accent,
        "bold 11px ui-monospace, monospace",
      );

      /* Reach marker at the aggregation point */
      const userReachAtAggregation = networkReachFraction(this.publishTime, AGGREGATION_POINT);
      const aggregationReachY = this.reachToY(userReachAtAggregation, this.height);
      /* Horizontal dotted line from Y axis to the aggregation point */
      draw.line(ctx, plotLeft, aggregationReachY, aggregationX, aggregationReachY, colors.accent + "90", 1.5, true);
      draw.disc(ctx, aggregationX, aggregationReachY, 6, colors.accent, colors.background, 2);
      draw.label(
        ctx,
        `${(userReachAtAggregation * 100).toFixed(1)}%`,
        aggregationX + 12,
        aggregationReachY,
        colors.accent,
        "bold 12px ui-monospace, monospace",
        "left",
      );

      /* Axes borders */
      draw.line(ctx, plotLeft, plotTop, plotLeft, plotBottom, colors.textDim, 1.5, false);
      draw.line(ctx, plotLeft, plotBottom, plotRight, plotBottom, colors.textDim, 1.5, false);
    },

    /**
     * Draw a single propagation S-curve for a block published at
     * `publishTime` seconds into the slot, up to `timeLimit` seconds.
     */
    renderPropagationCurve(ctx, publishTime, curveColor, timeLimit, alpha) {
      const steps = 120;
      const plotLeft = this.plotLeft(this.width);
      const plotRight = this.plotRight(this.width);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = curveColor;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.beginPath();

      let hasMovedTo = false;
      for (let step = 0; step <= steps; step++) {
        const elapsed = (step / steps) * Math.min(timeLimit, SLOT_DURATION);
        if (elapsed < publishTime) continue;
        const xPos = this.timeToX(elapsed, this.width);
        if (xPos < plotLeft - 1 || xPos > plotRight + 1) continue;
        const reach = networkReachFraction(publishTime, elapsed);
        const yPos = this.reachToY(reach, this.height);
        if (!hasMovedTo) {
          ctx.moveTo(xPos, yPos);
          hasMovedTo = true;
        } else {
          ctx.lineTo(xPos, yPos);
        }
      }
      ctx.stroke();
      ctx.restore();
    },

    /* ---- fast-confirmation verdict badge ---- */
    renderVerdict(ctx) {
      const reachAtAggregation = networkReachFraction(this.publishTime, AGGREGATION_POINT);
      const reachesSupermajority = reachAtAggregation >= SUPERMAJORITY;

      const badgeX = this.plotRight(this.width) + 10;
      const badgeY = this.plotTop(this.height) + 20;
      const badgeWidth = this.width - badgeX - 12;
      const badgeHeight = 110;

      /* Badge background */
      ctx.save();
      draw.roundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 8);
      ctx.fillStyle = reachesSupermajority ? colors.nodeHasMessage + "1a" : colors.prune + "1a";
      ctx.fill();
      ctx.strokeStyle = reachesSupermajority ? colors.nodeHasMessage + "80" : colors.prune + "80";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      const verdictMark = reachesSupermajority ? "✓ 高速確定に間に合う" : "✗ 集約点で 2/3 未達";
      draw.label(
        ctx,
        verdictMark,
        badgeX + badgeWidth / 2,
        badgeY + 20,
        reachesSupermajority ? colors.nodeHasMessage : colors.prune,
        "bold 13px ui-monospace, monospace",
      );

      draw.label(
        ctx,
        `集約点 (1.6s) 到達率:`,
        badgeX + badgeWidth / 2,
        badgeY + 42,
        colors.textDim,
        "10px ui-monospace, monospace",
      );
      draw.label(
        ctx,
        `${(reachAtAggregation * 100).toFixed(1)}%`,
        badgeX + badgeWidth / 2,
        badgeY + 60,
        colors.text,
        "bold 13px ui-monospace, monospace",
      );
      const reachAtSafe = networkReachFraction(this.publishTime, SAFE_TARGET_POINT);
      draw.label(
        ctx,
        `safe更新点 (2.4s): ${(reachAtSafe * 100).toFixed(0)}%`,
        badgeX + badgeWidth / 2,
        badgeY + 80,
        colors.textDim,
        "10px ui-monospace, monospace",
      );
      draw.label(
        ctx,
        `p = ${this.publishTime.toFixed(2)} s`,
        badgeX + badgeWidth / 2,
        badgeY + 96,
        colors.textDim,
        "10px ui-monospace, monospace",
      );
    },

    onMouse(type, mouseX) {
      if (type !== "click") return;
      /* Let user click on the X axis region to set publish time. */
      const plotLeft = this.plotLeft(this.width);
      const plotRight = this.plotRight(this.width);
      /* Accept clicks within the plot's horizontal range */
      if (mouseX >= plotLeft && mouseX <= plotRight) {
        const fraction = (mouseX - plotLeft) / (plotRight - plotLeft);
        const clickedTime = fraction * SLOT_DURATION;
        /* Only allow setting publish time within the slot */
        if (clickedTime >= 0 && clickedTime <= SLOT_DURATION - 0.05) {
          this.publishTime = parseFloat(clickedTime.toFixed(2));
          /* Restart propagation animation when the user picks a new time. */
          this.animationClock = this.publishTime;
          this.isAnimating = false;
        }
      }
    },

    /* ---- stats ---- */
    getStats() {
      const reachAtAggregation = networkReachFraction(this.publishTime, AGGREGATION_POINT);
      const reachAtSafe = networkReachFraction(this.publishTime, SAFE_TARGET_POINT);
      const reachesSupermajority = reachAtAggregation >= SUPERMAJORITY;
      return [
        { label: "発行時刻 p (s)", value: this.publishTime.toFixed(2) },
        { label: "集約点(1.6s)到達率", value: `${(reachAtAggregation * 100).toFixed(1)} %` },
        { label: "safe更新点(2.4s)到達率", value: `${(reachAtSafe * 100).toFixed(1)} %` },
        { label: "2/3 supermajority", value: reachesSupermajority ? "✓ 達成" : "✗ 未達" },
        { label: "高速確定", value: reachesSupermajority ? "間に合う" : "次スロットへ" },
      ];
    },

    /* ---- controls ---- */
    buildControls(container) {
      const ui = P2P.ui;

      const publishGroup = ui.group("提案タイミング");
      publishGroup.appendChild(
        ui.slider(
          "発行時刻 p (s)",
          0.0, 3.9, 0.05, this.publishTime,
          (value) => {
            this.publishTime = value;
            this.animationClock = value;
            this.isAnimating = false;
          },
        ),
      );
      container.appendChild(publishGroup);

      const animationGroup = ui.group("アニメーション");
      animationGroup.appendChild(
        ui.button(
          "再生 ▶",
          () => {
            this.animationClock = this.publishTime;
            this.isAnimating = true;
          },
          "primary",
        ),
      );
      animationGroup.appendChild(
        ui.button("リセット", () => {
          this.animationClock = SLOT_DURATION;
          this.isAnimating = false;
        }),
      );
      container.appendChild(animationGroup);

      const referenceGroup = ui.group("参考曲線");
      referenceGroup.appendChild(
        ui.toggle(
          `早期 (p=${REFERENCE_EARLY_PUBLISH_TIME}s)`,
          this.showReferenceEarlyPublish,
          (visible) => { this.showReferenceEarlyPublish = visible; },
        ),
      );
      referenceGroup.appendChild(
        ui.toggle(
          `遅延 (p=${REFERENCE_LATE_PUBLISH_TIME}s)`,
          this.showReferenceLatePublish,
          (visible) => { this.showReferenceLatePublish = visible; },
        ),
      );
      container.appendChild(referenceGroup);
    },
  };

  P2P.scenes.timinggame = scene;
})();
