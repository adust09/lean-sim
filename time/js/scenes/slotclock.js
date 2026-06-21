/*
 * slotclock.js — Section 3.1–3.3: The Slot Clock.
 *
 * A live, continuously-advancing clock that maps wall-clock time to slot
 * number and interval index.  Two synchronized views are rendered:
 *
 *   1. A horizontal slot grid (like Fig 3.1): slot boxes sweep left as time
 *      advances; a "now" marker shows the current position.
 *   2. A within-slot interval view (like Fig 3.2): the current slot is split
 *      into 4 one-second interval segments; the active segment glows.
 *
 * A live formula readout (like Fig 3.4) shows:
 *   t → Δ = t − tg → slot = ⌊Δ/Ts⌋, interval = ⌊(Δ mod Ts)/Ti⌋
 */
"use strict";

(function registerSlotClock() {
  const { util, draw, colors, ease } = P2P;

  /* Interval metadata — roles match the chapter spec exactly. */
  const INTERVAL_ROLES = [
    "ブロック提案",
    "投票生成",
    "セーフターゲット更新",
    "投票受理",
  ];

  /* Visual accent per interval: matching role semantics with color. */
  const INTERVAL_COLORS = [
    colors.nodeSource,   // amber — proposer action
    colors.nodeActive,   // blue  — attestation broadcast
    colors.graft,        // cyan  — safe target (stabilise view)
    colors.nodeHasMessage, // green — votes accepted into fork choice
  ];

  const scene = {
    id: "slotclock",
    title: "スロットクロック",
    sectionRef: "3.1",
    descriptionHTML: `
      <p><b>スロットクロック</b>はジェネシス時刻 t<sub>g</sub> と現在時刻 t から
      スロット番号とインターバル番号を導出する純粋な計算式です。</p>
      <ul>
        <li>スロット時間 <b>Ts = 4 秒</b>、インターバル時間 <b>Ti = 1 秒</b>。</li>
        <li>オフセット <b>Δ(t) = t − t<sub>g</sub></b></li>
        <li>スロット番号 = ⌊Δ / Ts⌋</li>
        <li>インターバル番号 = ⌊(Δ mod Ts) / Ti⌋</li>
      </ul>
      <p>スロット 0 は<b>ジェネシススロット</b>：提案者なし、親なし。
      ジェネシス状態は定義上 justified + finalized とみなされます。</p>
      <p><b>各インターバルの役割（Fig 3.2）:</b></p>
      <ul>
        <li><b>Interval 0</b> — ブロック提案（提案者がブロックをブロードキャスト）</li>
        <li><b>Interval 1</b> — 投票生成（バリデータがアテステーションを送出; PENDING 状態）</li>
        <li><b>Interval 2</b> — セーフターゲット更新（⅔ 超過多数を持つ最新ブロックを確定; フォークチョイス前の安定化）</li>
        <li><b>Interval 3</b> — 投票受理（PENDING → KNOWN に昇格; フォークチョイスに投入してヘッドを再計算）</li>
      </ul>`,

    /* ---- state ---- */
    width: 0,
    height: 0,
    simulatedTime: 0,         // seconds since genesis (t, with tg = 0)
    playbackSpeed: 1,
    isPaused: false,
    slotDuration: 4,          // Ts in seconds (configurable via slider)
    intervalDuration: 1,      // Ti fixed at 1 s per spec
    pulsePhase: 0,            // drives the glow pulse for active interval

    /* init is called once; env provides initial logical pixel dimensions. */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.simulatedTime = 0;
      this.pulsePhase = 0;
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    reset() {
      this.simulatedTime = 0;
      this.pulsePhase = 0;
    },

    /* ---- clock math ---- */
    currentSlot() {
      return Math.floor(this.simulatedTime / this.slotDuration);
    },

    currentSlotOffset() {
      return this.simulatedTime % this.slotDuration;
    },

    currentInterval() {
      const slotOffset = this.currentSlotOffset();
      return Math.min(
        Math.floor(slotOffset / this.intervalDuration),
        this.intervalCount() - 1,
      );
    },

    intervalCount() {
      return Math.round(this.slotDuration / this.intervalDuration);
    },

    /* ---- update ---- */
    update(realDt) {
      if (!this.isPaused) {
        this.simulatedTime += realDt * this.playbackSpeed;
        this.pulsePhase += realDt * this.playbackSpeed * 3.5;
      }
    },

    /* ---- render ---- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);

      const layoutMarginTop = 18;
      const slotGridHeight = Math.floor((this.height - layoutMarginTop) * 0.34);
      const intervalBarTop = layoutMarginTop + slotGridHeight + 12;
      const intervalBarHeight = Math.floor((this.height - layoutMarginTop) * 0.32);
      const formulaTop = intervalBarTop + intervalBarHeight + 12;

      this.renderSlotGrid(ctx, layoutMarginTop, slotGridHeight);
      this.renderIntervalBar(ctx, intervalBarTop, intervalBarHeight);
      this.renderFormulaReadout(ctx, formulaTop);
    },

    /* ---- horizontal slot grid (Fig 3.1 style) ---- */
    renderSlotGrid(ctx, top, height) {
      const leftMargin = 24;
      const rightMargin = 24;
      const gridLeft = leftMargin;
      const gridRight = this.width - rightMargin;
      const gridWidth = gridRight - gridLeft;
      const gridBottom = top + height;
      const slotGridTop = top + 28;
      const boxHeight = height - 44;

      /* Header */
      draw.label(
        ctx,
        "スロットグリッド（横軸＝時間、現在位置 → 右向き）",
        gridLeft,
        top + 10,
        colors.textDim,
        "11px ui-monospace, monospace",
        "left",
      );

      /* How many slots to display on each side of the current position. */
      const visibleSlotCount = 7;
      const slotPixelWidth = gridWidth / visibleSlotCount;
      const currentSlotNumber = this.currentSlot();
      const slotOffset = this.currentSlotOffset();
      /* Fraction through the current slot so we can pan continuously. */
      const panFraction = slotOffset / this.slotDuration;

      /* Draw slot boxes centered on the current slot. */
      for (let relativeSlot = -3; relativeSlot <= 4; relativeSlot++) {
        const absoluteSlot = currentSlotNumber + relativeSlot;
        if (absoluteSlot < 0) continue;

        /* X position: current slot is at center, panned by panFraction. */
        const centerX = gridLeft + gridWidth * 0.4;
        const boxLeft = centerX + (relativeSlot - panFraction) * slotPixelWidth;
        const boxRight = boxLeft + slotPixelWidth - 2;
        if (boxRight < gridLeft || boxLeft > gridRight) continue;

        const isCurrentSlot = relativeSlot === 0;
        const isGenesis = absoluteSlot === 0;

        /* Box fill */
        const clampedLeft = Math.max(boxLeft, gridLeft);
        const clampedRight = Math.min(boxRight, gridRight);
        const clampedWidth = clampedRight - clampedLeft;
        if (clampedWidth <= 0) continue;

        ctx.save();
        draw.roundedRect(ctx, clampedLeft, slotGridTop, clampedWidth, boxHeight, 6);
        if (isCurrentSlot) {
          ctx.fillStyle = colors.nodeActive + "40";
        } else {
          ctx.fillStyle = colors.panel;
        }
        ctx.fill();
        if (isCurrentSlot) {
          ctx.strokeStyle = colors.nodeActive;
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = colors.grid;
          ctx.lineWidth = 1;
        }
        ctx.stroke();
        ctx.restore();

        /* Slot label */
        const labelX = (clampedLeft + clampedRight) / 2;
        const slotLabelText = isGenesis
          ? "Slot 0\n(Genesis)"
          : `Slot ${absoluteSlot}`;
        draw.label(
          ctx,
          isGenesis ? "Slot 0" : `Slot ${absoluteSlot}`,
          labelX,
          slotGridTop + boxHeight * 0.38,
          isCurrentSlot ? colors.nodeActive : colors.textDim,
          `${isCurrentSlot ? "bold " : ""}12px ui-monospace, monospace`,
        );
        if (isGenesis) {
          draw.label(
            ctx,
            "(Genesis)",
            labelX,
            slotGridTop + boxHeight * 0.62,
            colors.nodeSource,
            "10px ui-monospace, monospace",
          );
        }
      }

      /* "Now" vertical marker at the current slot center */
      const nowX = gridLeft + gridWidth * 0.4 + (0 - panFraction) * slotPixelWidth
        + slotPixelWidth / 2;
      const clampedNowX = util.clamp(nowX, gridLeft, gridRight);
      draw.line(
        ctx,
        clampedNowX, slotGridTop - 4,
        clampedNowX, slotGridTop + boxHeight + 4,
        colors.nodeSource, 2, false,
      );
      draw.label(
        ctx, "▼ now",
        clampedNowX, slotGridTop - 11,
        colors.nodeSource, "10px ui-monospace, monospace",
      );

      /* Time axis ticks */
      draw.line(ctx, gridLeft, gridBottom - 2, gridRight, gridBottom - 2, colors.grid, 1, false);
    },

    /* ---- within-slot interval bar (Fig 3.2 style) ---- */
    renderIntervalBar(ctx, top, height) {
      const leftMargin = 24;
      const rightMargin = 24;
      const barLeft = leftMargin;
      const barRight = this.width - rightMargin;
      const barWidth = barRight - barLeft;
      const count = this.intervalCount();
      const activeIntervalIndex = this.currentInterval();
      const slotOffset = this.currentSlotOffset();
      const barTop = top + 28;
      const boxHeight = height - 52;

      /* Header */
      draw.label(
        ctx,
        `現在スロット内インターバル（スロット ${this.currentSlot()} · Ts = ${this.slotDuration}s, Ti = 1s, ${count} intervals）`,
        barLeft,
        top + 10,
        colors.textDim,
        "11px ui-monospace, monospace",
        "left",
      );

      const intervalPixelWidth = barWidth / count;

      for (let intervalIndex = 0; intervalIndex < count; intervalIndex++) {
        const boxLeft = barLeft + intervalIndex * intervalPixelWidth;
        const isActive = intervalIndex === activeIntervalIndex;

        /* Determine role label: only 4 canonical roles; extra intervals
         * (when Ts > 4s) show a generic "追加インターバル" label. */
        const roleLabel = INTERVAL_ROLES[intervalIndex] || `追加インターバル ${intervalIndex}`;
        const intervalAccent = INTERVAL_COLORS[intervalIndex] || colors.textDim;

        /* Glow pulse for the active interval */
        if (isActive) {
          const pulseValue = (Math.sin(this.pulsePhase) + 1) / 2;
          const glowAlpha = util.lerp(0.18, 0.45, pulseValue);
          ctx.save();
          draw.roundedRect(ctx, boxLeft + 1, barTop, intervalPixelWidth - 3, boxHeight, 8);
          ctx.fillStyle = intervalAccent + Math.round(glowAlpha * 255).toString(16).padStart(2, "0");
          ctx.fill();
          ctx.restore();
        }

        /* Box border */
        ctx.save();
        draw.roundedRect(ctx, boxLeft + 1, barTop, intervalPixelWidth - 3, boxHeight, 8);
        ctx.fillStyle = isActive ? intervalAccent + "22" : colors.panel;
        ctx.fill();
        ctx.strokeStyle = isActive ? intervalAccent : colors.grid;
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.stroke();
        ctx.restore();

        /* "Interval N" label at top of box */
        draw.label(
          ctx,
          `Interval ${intervalIndex}`,
          boxLeft + intervalPixelWidth / 2,
          barTop + 18,
          isActive ? intervalAccent : colors.textDim,
          `${isActive ? "bold " : ""}11px ui-monospace, monospace`,
        );

        /* Role label — only the 4 canonical ones are shown */
        if (intervalIndex < 4) {
          draw.label(
            ctx,
            roleLabel,
            boxLeft + intervalPixelWidth / 2,
            barTop + boxHeight / 2 + 4,
            isActive ? colors.text : colors.textDim,
            "11px ui-monospace, monospace",
          );
        }
      }

      /* Progress fill along the bottom of the bar showing Δ within slot */
      const progressFraction = slotOffset / this.slotDuration;
      const progressWidth = barWidth * progressFraction;
      ctx.save();
      ctx.fillStyle = colors.nodeSource + "80";
      ctx.fillRect(barLeft, barTop + boxHeight - 5, progressWidth, 5);
      ctx.restore();

      /* "Δ within slot" label */
      draw.label(
        ctx,
        `Δ mod Ts = ${slotOffset.toFixed(2)} s`,
        barLeft,
        barTop + boxHeight + 14,
        colors.textDim,
        "11px ui-monospace, monospace",
        "left",
      );
    },

    /* ---- live formula readout (Fig 3.4 style) ---- */
    renderFormulaReadout(ctx, top) {
      const leftMargin = 24;
      const panelWidth = this.width - leftMargin * 2;
      const panelHeight = 80;

      /* Panel background */
      ctx.save();
      draw.roundedRect(ctx, leftMargin, top, panelWidth, panelHeight, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      const slotOffset = this.currentSlotOffset();
      const slotNumber = this.currentSlot();
      const intervalIndex = this.currentInterval();
      const roleLabel = INTERVAL_ROLES[intervalIndex] || `追加インターバル ${intervalIndex}`;

      /* Formula line */
      const formulaText =
        `t = ${this.simulatedTime.toFixed(2)} s  →  ` +
        `Δ = ${slotOffset.toFixed(2)} s  →  ` +
        `slot = ⌊${this.simulatedTime.toFixed(2)} / ${this.slotDuration}⌋ = ${slotNumber}  ·  ` +
        `interval = ⌊${slotOffset.toFixed(2)} mod ${this.slotDuration} / 1⌋ = ${intervalIndex}`;

      draw.label(
        ctx,
        formulaText,
        leftMargin + panelWidth / 2,
        top + 28,
        colors.text,
        "12px ui-monospace, monospace",
      );

      /* Role badge */
      const roleColor = INTERVAL_COLORS[intervalIndex] || colors.textDim;
      draw.label(
        ctx,
        `▸ Interval ${intervalIndex}: ${roleLabel}`,
        leftMargin + panelWidth / 2,
        top + 56,
        roleColor,
        "bold 13px ui-monospace, monospace",
      );
    },

    onMouse() {},

    /* ---- stats ---- */
    getStats() {
      const slotNumber = this.currentSlot();
      const slotOffset = this.currentSlotOffset();
      const intervalIndex = this.currentInterval();
      const roleLabel = INTERVAL_ROLES[intervalIndex] || `追加`;
      const count = this.intervalCount();
      return [
        { label: "現在時刻 t (s)", value: this.simulatedTime.toFixed(2) },
        { label: "Δ = t − tg (s)", value: slotOffset.toFixed(2) },
        { label: "現在スロット", value: slotNumber },
        { label: "現在インターバル", value: `${intervalIndex} — ${roleLabel}` },
        { label: "Ts / Ti", value: `${this.slotDuration}s / 1s = ${count}` },
        { label: "再生速度", value: `×${this.playbackSpeed}` },
        { label: "状態", value: this.isPaused ? "一時停止" : "再生中" },
      ];
    },

    /* ---- controls ---- */
    buildControls(container) {
      const ui = P2P.ui;

      const playbackGroup = ui.group("再生");
      playbackGroup.appendChild(
        ui.toggle(
          "一時停止 / 再生",
          this.isPaused,
          (paused) => { this.isPaused = paused; },
        ),
      );
      playbackGroup.appendChild(
        ui.button("ジェネシスにリセット ↺", () => this.reset(), "primary"),
      );
      playbackGroup.appendChild(
        ui.slider(
          "再生速度 ×",
          0.25, 8, 0.25, this.playbackSpeed,
          (value) => { this.playbackSpeed = value; },
        ),
      );
      container.appendChild(playbackGroup);

      const timingGroup = ui.group("タイミングパラメータ");
      timingGroup.appendChild(
        ui.slider(
          "スロット時間 Ts (s)",
          2, 12, 1, this.slotDuration,
          (value) => {
            this.slotDuration = value;
            /* Reset so the new Ts takes effect cleanly from genesis. */
            this.reset();
          },
        ),
      );
      container.appendChild(timingGroup);
    },
  };

  P2P.scenes.slotclock = scene;
})();
