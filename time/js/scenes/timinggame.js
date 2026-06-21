/*
 * timinggame.js — Section 3.2 / 3.6: Timing Games (Fig 3.3).
 *
 * Visualises the proposer's tradeoff between publishing a block early (high
 * reach at the attestation deadline → many votes) vs publishing late (lower
 * reach → fewer votes, potential reorg, but more MEV captured during the
 * delay).
 *
 * Axes:
 *   X — time within the slot (0 → Ts = 4 s)
 *   Y — cumulative fraction of the network that has received the block (0–100 %)
 *
 * Propagation model: logistic S-curve starting at publish time p that climbs
 * to ~100 % over ~1.5 s of simulated time.
 *
 * Attestation deadline: end of Interval 1, i.e. t = 2 s into the slot
 * (Interval 0 ends at 1 s; Interval 1 ends at 2 s).
 *
 * Timely verdict: block is "timely" if it was published within Interval 0
 * (p ≤ 1.0 s) AND reach at the deadline ≥ the configured threshold (66 %).
 */
"use strict";

(function registerTimingGame() {
  const { util, draw, colors, ease } = P2P;

  const SLOT_DURATION = 4;        // Ts in seconds
  const ATTESTATION_DEADLINE = 2; // end of Interval 1 (seconds within slot)
  const PROPAGATION_SPEED = 3.5;  // logistic steepness — how fast gossip spreads
  const PROPAGATION_MIDPOINT_OFFSET = 0.75; // seconds after p that reach hits 50 %

  /* Reference curves shown alongside the user's chosen publish time. */
  const REFERENCE_EARLY_PUBLISH_TIME = 0.2;  // early proposer (within Interval 0)
  const REFERENCE_LATE_PUBLISH_TIME = 1.8;   // late proposer (Interval 1 territory)

  const TIMELY_THRESHOLD = 0.66; // fraction of network required to call it timely

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

  /** MEV qualitative label — increases with delay (more time = more mempool). */
  function mevLabel(publishTime) {
    if (publishTime < 0.5) return "最小 (早期提案)";
    if (publishTime < 1.0) return "低";
    if (publishTime < 1.5) return "中";
    if (publishTime < 2.0) return "高";
    return "最大 (遅延提案)";
  }

  const scene = {
    id: "timinggame",
    title: "タイミングゲーム",
    sectionRef: "3.2",
    descriptionHTML: `
      <p><b>タイミングゲーム</b>：提案者はブロック内に含める MEV（Maximal Extractable Value）を
      最大化するために、提案を遅らせるインセンティブを持ちます。しかし遅延するほど、
      アテステーション締切（Interval 1 終了時）までにブロックがネットワークに伝搬する時間が短くなります。</p>
      <p><b>伝搬モデル（S字曲線）:</b> ブロックが発行されると、ゴシップ経由でバリデータに広がります。
      発行後 ~0.75 秒でネットワークの 50 % に到達し、~1.5 秒で ~100 % に近づく logistic モデルで近似します。</p>
      <ul>
        <li><b>Interval 0（0–1 秒）:</b> 提案期間。ここで発行すれば締切までに最大限伝搬できる。</li>
        <li><b>Interval 1（1–2 秒）:</b> 投票生成期間。締切（2 秒）までにバリデータがブロックを受け取っていれば投票可。</li>
        <li><b>タイムリー判定:</b> p ≤ 1.0 s かつ締切到達率 ≥ 66 % → ✓ タイムリー</li>
      </ul>
      <p><b>インターバル締切の効果:</b> Lean Consensus は「Interval 0 終了後に届いたブロックは
      時機を逸した（untimely）」と見なして棄却します。これにより提案者が遅延させても
      報酬を得られなくなり、タイミングゲームを中和します。</p>`,

    /* ---- state ---- */
    width: 0,
    height: 0,
    publishTime: 0.3,       // p — user-controlled block publish time (seconds in slot)
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
      this.renderLegend(ctx);
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

      /* Interval background shading */
      const intervalColors = [
        colors.nodeSource + "18",  // Interval 0: amber tint
        colors.nodeActive + "14",  // Interval 1: blue tint
        colors.graft + "10",       // Interval 2: cyan tint
        colors.nodeHasMessage + "0c", // Interval 3: green tint
      ];
      for (let intervalIndex = 0; intervalIndex < 4; intervalIndex++) {
        const xStart = this.timeToX(intervalIndex * 1, this.width);
        const xEnd = this.timeToX((intervalIndex + 1) * 1, this.width);
        ctx.fillStyle = intervalColors[intervalIndex];
        ctx.fillRect(xStart, plotTop, xEnd - xStart, plotHeight);
      }

      /* Attestation deadline vertical line */
      const deadlineX = this.timeToX(ATTESTATION_DEADLINE, this.width);
      draw.line(ctx, deadlineX, plotTop, deadlineX, plotBottom, colors.prune, 2, false);
      draw.label(
        ctx,
        "締切 (Interval 1 end)",
        deadlineX + 4,
        plotTop + 14,
        colors.prune,
        "bold 11px ui-monospace, monospace",
        "left",
      );

      /* Interval 0/1 boundary */
      const interval0EndX = this.timeToX(1, this.width);
      draw.line(ctx, interval0EndX, plotTop, interval0EndX, plotBottom, colors.nodeSource + "80", 1.5, true);
      draw.label(
        ctx,
        "Interval 0 終了",
        interval0EndX + 3,
        plotTop + 30,
        colors.nodeSource + "cc",
        "10px ui-monospace, monospace",
        "left",
      );

      /* Timely threshold horizontal line at 66 % */
      const thresholdY = this.reachToY(TIMELY_THRESHOLD, this.height);
      draw.line(ctx, plotLeft, thresholdY, plotRight, thresholdY, colors.nodeHasMessage + "70", 1.5, true);
      draw.label(
        ctx,
        "66 % 閾値",
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

      /* X axis ticks and labels */
      for (let tick = 0; tick <= SLOT_DURATION; tick++) {
        const xPos = this.timeToX(tick, this.width);
        draw.line(ctx, xPos, plotBottom, xPos, plotBottom + 5, colors.textDim, 1, false);
        draw.label(
          ctx,
          `${tick}s`,
          xPos,
          plotBottom + 14,
          colors.textDim,
          "10px ui-monospace, monospace",
        );
      }

      /* Interval labels along the X axis */
      const intervalNames = ["Interval 0\nブロック提案", "Interval 1\n投票生成", "Interval 2\nSafe更新", "Interval 3\n投票受理"];
      const intervalShortNames = ["Interval 0", "Interval 1", "Interval 2", "Interval 3"];
      for (let intervalIndex = 0; intervalIndex < 4; intervalIndex++) {
        const xCenter = this.timeToX(intervalIndex + 0.5, this.width);
        draw.label(
          ctx,
          intervalShortNames[intervalIndex],
          xCenter,
          plotBottom + 28,
          colors.textDim,
          "9px ui-monospace, monospace",
        );
      }

      /* Axis labels */
      draw.label(
        ctx,
        "スロット内経過時間 (秒)",
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

      /* Reference curve: early publish (blue/green — high reach) */
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

      /* Reach marker at the attestation deadline */
      const userReachAtDeadline = networkReachFraction(this.publishTime, ATTESTATION_DEADLINE);
      const deadlineReachY = this.reachToY(userReachAtDeadline, this.height);
      /* Horizontal dotted line from Y axis to the deadline */
      draw.line(ctx, plotLeft, deadlineReachY, deadlineX, deadlineReachY, colors.accent + "90", 1.5, true);
      draw.disc(ctx, deadlineX, deadlineReachY, 6, colors.accent, colors.background, 2);
      draw.label(
        ctx,
        `${(userReachAtDeadline * 100).toFixed(1)}%`,
        deadlineX + 12,
        deadlineReachY,
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

    /* ---- legend ---- */
    renderLegend(ctx) {
      const legendLeft = this.plotLeft(this.width);
      const legendTop = this.plotBottom(this.height) + 60;
      const itemSpacing = Math.floor((this.plotRight(this.width) - legendLeft) / 3);

      const legendItems = [
        {
          color: colors.nodeHasMessage,
          label: `早期提案 p=${REFERENCE_EARLY_PUBLISH_TIME}s（参考）`,
          visible: this.showReferenceEarlyPublish,
        },
        {
          color: colors.iwant,
          label: `遅延提案 p=${REFERENCE_LATE_PUBLISH_TIME}s（参考）`,
          visible: this.showReferenceLatePublish,
        },
        { color: colors.accent, label: `あなたの提案 p=${this.publishTime.toFixed(2)}s`, visible: true },
      ];

      for (let legendIndex = 0; legendIndex < legendItems.length; legendIndex++) {
        const legendItem = legendItems[legendIndex];
        if (!legendItem.visible) continue;
        const xPos = legendLeft + legendIndex * itemSpacing;
        draw.line(ctx, xPos, legendTop + 6, xPos + 24, legendTop + 6, legendItem.color, 2.5, false);
        draw.label(
          ctx,
          legendItem.label,
          xPos + 28,
          legendTop + 6,
          legendItem.visible ? colors.text : colors.textDim,
          "10px ui-monospace, monospace",
          "left",
        );
      }
    },

    /* ---- timely verdict badge ---- */
    renderVerdict(ctx) {
      const reachAtDeadline = networkReachFraction(this.publishTime, ATTESTATION_DEADLINE);
      const isPublishedInInterval0 = this.publishTime <= 1.0;
      const isReachSufficient = reachAtDeadline >= TIMELY_THRESHOLD;
      const isTimely = isPublishedInInterval0 && isReachSufficient;

      const badgeX = this.plotRight(this.width) + 10;
      const badgeY = this.plotTop(this.height) + 20;
      const badgeWidth = this.width - badgeX - 12;
      const badgeHeight = 110;

      /* Badge background */
      ctx.save();
      draw.roundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 8);
      ctx.fillStyle = isTimely ? colors.nodeHasMessage + "1a" : colors.prune + "1a";
      ctx.fill();
      ctx.strokeStyle = isTimely ? colors.nodeHasMessage + "80" : colors.prune + "80";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      const verdictMark = isTimely ? "✓ タイムリー" : "✗ タイムリー外";
      draw.label(
        ctx,
        verdictMark,
        badgeX + badgeWidth / 2,
        badgeY + 20,
        isTimely ? colors.nodeHasMessage : colors.prune,
        "bold 14px ui-monospace, monospace",
      );

      const estimatedVotes = Math.round(reachAtDeadline * 128);
      draw.label(
        ctx,
        `到達率: ${(reachAtDeadline * 100).toFixed(1)}%`,
        badgeX + badgeWidth / 2,
        badgeY + 42,
        colors.text,
        "11px ui-monospace, monospace",
      );
      draw.label(
        ctx,
        `投票(概算): ${estimatedVotes}/128`,
        badgeX + badgeWidth / 2,
        badgeY + 60,
        colors.text,
        "11px ui-monospace, monospace",
      );
      draw.label(
        ctx,
        `MEV: ${mevLabel(this.publishTime)}`,
        badgeX + badgeWidth / 2,
        badgeY + 78,
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
      const plotBottom = this.plotBottom(this.height);
      /* Accept clicks within ±20 px of the bottom axis */
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
      const reachAtDeadline = networkReachFraction(this.publishTime, ATTESTATION_DEADLINE);
      const isTimely = this.publishTime <= 1.0 && reachAtDeadline >= TIMELY_THRESHOLD;
      const estimatedVotes = Math.round(reachAtDeadline * 128);
      return [
        { label: "発行時刻 p (s)", value: this.publishTime.toFixed(2) },
        { label: "締切での到達率", value: `${(reachAtDeadline * 100).toFixed(1)} %` },
        { label: "間に合った投票(概算)", value: `${estimatedVotes} / 128` },
        { label: "タイムリー判定", value: isTimely ? "✓ はい" : "✗ いいえ" },
        { label: "想定 MEV", value: mevLabel(this.publishTime) },
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
