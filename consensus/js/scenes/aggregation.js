/*
 * aggregation.js — §6.4, §6.5.4: Signature aggregation and proposer set-cover packing.
 *
 * Part 1 (§6.4): Committee of N validators, each voting with identical AttestationData.
 * Individual BLS signatures merge into one aggregate; a participation bitfield records
 * who voted (1) vs. was offline (0). Toggle validators on/off to see updates live.
 *
 * Part 2 (§6.5.4, Fig 6.7): Gossip pool has overlapping aggregates (A:1100, B:0110,
 * C:0011). Proposer runs greedy set-cover to pick the minimal subset whose union covers
 * the most distinct validators. Redundant aggregates (e.g. B) are dropped.
 */
"use strict";

(function registerAggregation() {
  const { util, draw, colors, ease } = P2P;

  const PADDING = 24;
  const VALIDATOR_CELL_SIZE = 44;
  const VALIDATOR_CELL_GAP = 8;
  const PANEL_RADIUS = 8;
  const AGGREGATE_BOX_HEIGHT = 40;
  const BIT_CELL_SIZE = 28;
  const MERGE_ANIMATION_DURATION = 0.8;

  const C_PRESENT = "#36d399";
  const C_ABSENT = "#3a2530";
  const C_AGGREGATE_BOX = "#1e3a2a";
  const C_AGGREGATE_BORDER = "#36d399";
  const C_REDUNDANT = "#f8717155";
  const C_CHOSEN = "#36d39944";
  const C_BIT_ONE = "#36d399";
  const C_BIT_ZERO = "#3a4a63";

  const DEFAULT_AGGREGATES = [
    { label: "A", bits: [1, 1, 0, 0] },
    { label: "B", bits: [0, 1, 1, 0] },
    { label: "C", bits: [0, 0, 1, 1] },
  ];

  const scene = {
    id: "aggregation",
    title: "署名集約とパッキング",
    sectionRef: "6.4",
    descriptionHTML: `
      <p><b>Part 1 — 署名集約 (§6.4):</b></p>
      <p>同じ AttestationData に投票したバリデータの BLS 署名を<b>1本の集約署名</b>に統合。
      参加ビットフィールド: ビット i=1 → バリデータ i が投票済み、0 → 欠席。</p>
      <p>各バリデータの ON/OFF を切り替えると bitfield と集約が即座に更新される。
      「集約アニメーション」で個別署名が合流する様子を再生。</p>
      <p><b>Part 2 — Proposer パッキング / Set-Cover (§6.5.4, Fig 6.7):</b></p>
      <p>ゴシッププールには重複する集約が存在 (例: A:1100, B:0110, C:0011)。
      Proposer は<b>最小集合で最多 validator をカバー</b>する set-cover を解く。
      貪欲法: A+C → 1111 (フルカバー)、B は冗長として除外。</p>
      <p>「パッキング実行」でアニメーション付きの set-cover を表示。
      集約のビットを編集して結果の変化を確認できる。</p>`,

    width: 0, height: 0, rng: null,

    // Part 1.
    committeeSize: 8,
    validatorPresent: [],
    mergeAnimationProgress: 0,
    mergeAnimationRunning: false,

    // Part 2.
    poolAggregates: [],
    poolValidatorCount: 4,
    packingResult: null,
    packingAnimationProgress: 0,
    packingAnimationRunning: false,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.rng = util.makeRng(0xdeadbeef);
      this.initCommittee();
      this.initPool();
    },

    resize(width, height) { this.width = width; this.height = height; },

    initCommittee() {
      this.validatorPresent = Array.from({ length: this.committeeSize }, () => true);
      this.mergeAnimationProgress = 0;
      this.mergeAnimationRunning = false;
    },

    initPool() {
      this.poolAggregates = DEFAULT_AGGREGATES.map((agg) => ({ label: agg.label, bits: [...agg.bits] }));
      this.poolValidatorCount = 4;
      this.packingResult = null;
      this.packingAnimationProgress = 0;
      this.packingAnimationRunning = false;
    },

    presentCount() { return this.validatorPresent.filter(Boolean).length; },

    triggerMergeAnimation() {
      this.mergeAnimationProgress = 0;
      this.mergeAnimationRunning = true;
    },

    runPackingSetCover() {
      const validatorCount = this.poolValidatorCount;
      const covered = new Array(validatorCount).fill(false);
      const chosenIndices = [];
      const remaining = new Set(this.poolAggregates.map((_, index) => index));

      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        let bestAggregateIndex = -1;
        let bestNewCoverageCount = 0;
        for (const aggregateIndex of remaining) {
          const aggregate = this.poolAggregates[aggregateIndex];
          let newCoverageCount = 0;
          for (let bitIndex = 0; bitIndex < validatorCount; bitIndex++) {
            if (aggregate.bits[bitIndex] && !covered[bitIndex]) newCoverageCount++;
          }
          if (newCoverageCount > bestNewCoverageCount) {
            bestNewCoverageCount = newCoverageCount;
            bestAggregateIndex = aggregateIndex;
          }
        }
        if (bestAggregateIndex >= 0 && bestNewCoverageCount > 0) {
          chosenIndices.push(bestAggregateIndex);
          remaining.delete(bestAggregateIndex);
          const chosenAggregate = this.poolAggregates[bestAggregateIndex];
          for (let bitIndex = 0; bitIndex < validatorCount; bitIndex++) {
            if (chosenAggregate.bits[bitIndex]) covered[bitIndex] = true;
          }
          madeProgress = true;
        }
      }

      const redundantIndices = this.poolAggregates
        .map((_, index) => index)
        .filter((index) => !chosenIndices.includes(index));

      this.packingResult = { chosen: chosenIndices, redundant: redundantIndices, coverUnion: covered };
      this.packingAnimationProgress = 0;
      this.packingAnimationRunning = true;
    },

    coveragePercent() {
      if (!this.packingResult) return 0;
      return Math.round(this.packingResult.coverUnion.filter(Boolean).length / this.poolValidatorCount * 100);
    },

    update(realDt) {
      if (this.mergeAnimationRunning) {
        this.mergeAnimationProgress = Math.min(1, this.mergeAnimationProgress + realDt / MERGE_ANIMATION_DURATION);
        if (this.mergeAnimationProgress >= 1) this.mergeAnimationRunning = false;
      }
      if (this.packingAnimationRunning) {
        this.packingAnimationProgress = Math.min(1, this.packingAnimationProgress + realDt / 0.9);
        if (this.packingAnimationProgress >= 1) this.packingAnimationRunning = false;
      }
    },

    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      const useSideBySide = this.width >= 720;
      if (useSideBySide) {
        const halfWidth = Math.floor(this.width / 2) - PADDING;
        this.renderAggregationPanel(ctx, PADDING, PADDING, halfWidth, this.height - PADDING * 2);
        this.renderPackingPanel(ctx, Math.floor(this.width / 2) + PADDING / 2, PADDING, halfWidth, this.height - PADDING * 2);
      } else {
        const halfHeight = Math.floor(this.height / 2) - PADDING;
        this.renderAggregationPanel(ctx, PADDING, PADDING, this.width - PADDING * 2, halfHeight);
        this.renderPackingPanel(ctx, PADDING, Math.floor(this.height / 2) + PADDING / 2, this.width - PADDING * 2, halfHeight);
      }
    },

    renderAggregationPanel(ctx, panelX, panelY, panelWidth, panelHeight) {
      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, PANEL_RADIUS);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      draw.label(ctx, "Part 1 — 署名集約 (§6.4)", panelX + panelWidth / 2, panelY + 18,
        colors.accent, "bold 12px ui-monospace,monospace");

      const contentX = panelX + PADDING;
      const contentWidth = panelWidth - PADDING * 2;
      let currentY = panelY + 42;

      draw.label(ctx, "委員会バリデータ", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
      currentY += 18;

      const cellTotalWidth = VALIDATOR_CELL_SIZE + VALIDATOR_CELL_GAP;
      const validatorsPerRow = Math.max(1, Math.floor(contentWidth / cellTotalWidth));
      const validatorRowCount = Math.ceil(this.committeeSize / validatorsPerRow);

      for (let rowIndex = 0; rowIndex < validatorRowCount; rowIndex++) {
        for (let columnIndex = 0; columnIndex < validatorsPerRow; columnIndex++) {
          const validatorIndex = rowIndex * validatorsPerRow + columnIndex;
          if (validatorIndex >= this.committeeSize) break;
          const cellX = contentX + columnIndex * cellTotalWidth;
          const cellY = currentY + rowIndex * (VALIDATOR_CELL_SIZE + VALIDATOR_CELL_GAP);
          const isPresent = this.validatorPresent[validatorIndex];

          ctx.save();
          draw.roundedRect(ctx, cellX, cellY, VALIDATOR_CELL_SIZE, VALIDATOR_CELL_SIZE, 6);
          ctx.fillStyle = isPresent ? C_PRESENT + "33" : C_ABSENT;
          ctx.fill();
          ctx.strokeStyle = isPresent ? C_PRESENT : "#4a3340";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();

          draw.label(ctx, `V${validatorIndex}`, cellX + VALIDATOR_CELL_SIZE / 2, cellY + 14,
            isPresent ? C_PRESENT : colors.textDim, "bold 10px ui-monospace,monospace");

          if (isPresent) {
            ctx.fillStyle = C_PRESENT + "88";
            ctx.fillRect(cellX + 4, cellY + 22, VALIDATOR_CELL_SIZE - 8, 10);
            draw.label(ctx, "sig", cellX + VALIDATOR_CELL_SIZE / 2, cellY + 27, "#ffffff99", "8px ui-monospace,monospace");
          } else {
            draw.label(ctx, "offline", cellX + VALIDATOR_CELL_SIZE / 2, cellY + VALIDATOR_CELL_SIZE / 2 + 4,
              "#f8717166", "8px ui-monospace,monospace");
          }
        }
      }
      currentY += validatorRowCount * (VALIDATOR_CELL_SIZE + VALIDATOR_CELL_GAP) + 6;

      // Merge animation particles.
      if (this.mergeAnimationProgress > 0) {
        const mergeTargetX = contentX + contentWidth / 2;
        const mergeTargetY = currentY + AGGREGATE_BOX_HEIGHT / 2 + 6;
        const eased = ease.outCubic(this.mergeAnimationProgress);
        for (let validatorIndex = 0; validatorIndex < this.committeeSize; validatorIndex++) {
          if (!this.validatorPresent[validatorIndex]) continue;
          const columnIndex = validatorIndex % validatorsPerRow;
          const rowIndex = Math.floor(validatorIndex / validatorsPerRow);
          const sigSourceX = contentX + columnIndex * cellTotalWidth + VALIDATOR_CELL_SIZE / 2;
          const sigSourceY = panelY + 42 + 18 + rowIndex * (VALIDATOR_CELL_SIZE + VALIDATOR_CELL_GAP) + VALIDATOR_CELL_SIZE - 5;
          ctx.save();
          ctx.globalAlpha = 1 - eased * 0.5;
          draw.disc(ctx, util.lerp(sigSourceX, mergeTargetX, eased), util.lerp(sigSourceY, mergeTargetY, eased), 3, C_PRESENT, null);
          draw.glow(ctx, util.lerp(sigSourceX, mergeTargetX, eased), util.lerp(sigSourceY, mergeTargetY, eased), 8, C_PRESENT);
          ctx.restore();
        }
      }

      // Aggregate signature box.
      const aggregateBoxX = contentX + contentWidth / 4;
      const aggregateBoxWidth = contentWidth / 2;
      const aggregateBoxY = currentY + 6;
      const aggregateAlpha = ease.outCubic(Math.min(1, this.mergeAnimationProgress * 2));
      ctx.save();
      ctx.globalAlpha = Math.max(0.3, aggregateAlpha);
      draw.roundedRect(ctx, aggregateBoxX, aggregateBoxY, aggregateBoxWidth, AGGREGATE_BOX_HEIGHT, 6);
      ctx.fillStyle = C_AGGREGATE_BOX;
      ctx.fill();
      ctx.strokeStyle = C_AGGREGATE_BORDER;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, `集約署名 (${this.presentCount()} sigs → 1)`,
        contentX + contentWidth / 2, aggregateBoxY + AGGREGATE_BOX_HEIGHT / 2,
        C_PRESENT, "bold 11px ui-monospace,monospace");

      currentY = aggregateBoxY + AGGREGATE_BOX_HEIGHT + 16;
      draw.label(ctx, "参加ビットフィールド:", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
      currentY += 14;

      const bitCellTotalWidth = BIT_CELL_SIZE + 4;
      const bitsPerRow = Math.max(1, Math.floor(contentWidth / bitCellTotalWidth));
      for (let bitIndex = 0; bitIndex < this.committeeSize; bitIndex++) {
        const columnIndex = bitIndex % bitsPerRow;
        const rowIndex = Math.floor(bitIndex / bitsPerRow);
        const bitCellX = contentX + columnIndex * bitCellTotalWidth;
        const bitCellY = currentY + rowIndex * (BIT_CELL_SIZE + 4);
        const bitValue = this.validatorPresent[bitIndex] ? 1 : 0;
        ctx.save();
        draw.roundedRect(ctx, bitCellX, bitCellY, BIT_CELL_SIZE, BIT_CELL_SIZE, 4);
        ctx.fillStyle = bitValue ? C_BIT_ONE + "44" : C_BIT_ZERO + "44";
        ctx.fill();
        ctx.strokeStyle = bitValue ? C_BIT_ONE : C_BIT_ZERO;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, String(bitValue), bitCellX + BIT_CELL_SIZE / 2, bitCellY + BIT_CELL_SIZE / 2,
          bitValue ? C_BIT_ONE : colors.textDim, "bold 12px ui-monospace,monospace");
      }
      const bitfieldRowCount = Math.ceil(this.committeeSize / bitsPerRow);
      currentY += bitfieldRowCount * (BIT_CELL_SIZE + 4) + 8;
      draw.label(ctx, `popcount = ${this.presentCount()} / ${this.committeeSize}  |  集約署名 = 1 本`,
        contentX + contentWidth / 2, Math.min(currentY, panelY + panelHeight - 14),
        colors.text, "11px ui-monospace,monospace");
    },

    renderPackingPanel(ctx, panelX, panelY, panelWidth, panelHeight) {
      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, PANEL_RADIUS);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      draw.label(ctx, "Part 2 — Proposer パッキング / Set-Cover (§6.5.4)",
        panelX + panelWidth / 2, panelY + 18, colors.accent, "bold 12px ui-monospace,monospace");

      const contentX = panelX + PADDING;
      const contentWidth = panelWidth - PADDING * 2;
      let currentY = panelY + 42;
      const validatorCount = this.poolValidatorCount;
      const headerCellWidth = Math.min(40, Math.floor((contentWidth - 60) / validatorCount));

      draw.label(ctx, "集約", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
      for (let validatorIndex = 0; validatorIndex < validatorCount; validatorIndex++) {
        draw.label(ctx, `V${validatorIndex}`,
          contentX + 60 + validatorIndex * headerCellWidth + headerCellWidth / 2,
          currentY, colors.textDim, "10px ui-monospace,monospace");
      }
      currentY += 18;

      const aggregateRowHeight = 36;
      for (let aggregateIndex = 0; aggregateIndex < this.poolAggregates.length; aggregateIndex++) {
        const aggregate = this.poolAggregates[aggregateIndex];
        const aggregateRowY = currentY + aggregateIndex * (aggregateRowHeight + 6);
        const isChosen = this.packingResult && this.packingResult.chosen.includes(aggregateIndex) && this.packingAnimationProgress > aggregateIndex * 0.2;
        const isRedundant = this.packingResult && this.packingResult.redundant.includes(aggregateIndex) && this.packingAnimationProgress > 0.6;

        if (isChosen || isRedundant) {
          ctx.save();
          draw.roundedRect(ctx, contentX, aggregateRowY, contentWidth, aggregateRowHeight, 6);
          ctx.fillStyle = isChosen ? C_CHOSEN : C_REDUNDANT;
          ctx.fill();
          if (isChosen) { ctx.strokeStyle = C_AGGREGATE_BORDER; ctx.lineWidth = 1.5; ctx.stroke(); }
          ctx.restore();
        }

        draw.label(ctx, aggregate.label, contentX + 14, aggregateRowY + aggregateRowHeight / 2,
          isChosen ? C_PRESENT : isRedundant ? "#f87171" : colors.text, "bold 14px ui-monospace,monospace");

        for (let bitIndex = 0; bitIndex < validatorCount; bitIndex++) {
          const bitCellX = contentX + 60 + bitIndex * headerCellWidth;
          const bitValue = aggregate.bits[bitIndex] ? 1 : 0;
          ctx.save();
          draw.roundedRect(ctx, bitCellX + 2, aggregateRowY + 4, headerCellWidth - 4, aggregateRowHeight - 8, 4);
          ctx.fillStyle = bitValue ? C_BIT_ONE + "44" : C_BIT_ZERO + "33";
          ctx.fill();
          ctx.strokeStyle = bitValue ? C_BIT_ONE : C_BIT_ZERO;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
          draw.label(ctx, String(bitValue), bitCellX + headerCellWidth / 2, aggregateRowY + aggregateRowHeight / 2,
            bitValue ? C_BIT_ONE : colors.textDim, "bold 12px ui-monospace,monospace");
        }

        if (this.packingResult && this.packingAnimationProgress > 0.4) {
          const statusLabel = isChosen ? "✓ 選択" : isRedundant ? "✗ 冗長" : "";
          if (statusLabel) {
            draw.label(ctx, statusLabel, panelX + panelWidth - PADDING - 8, aggregateRowY + aggregateRowHeight / 2,
              isChosen ? C_PRESENT : "#f87171", "bold 10px ui-monospace,monospace", "right");
          }
        }
      }

      currentY += this.poolAggregates.length * (aggregateRowHeight + 6) + 12;

      if (this.packingResult && this.packingAnimationProgress > 0.7) {
        draw.label(ctx, "カバー合計:", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
        for (let validatorIndex = 0; validatorIndex < validatorCount; validatorIndex++) {
          const bitCellX = contentX + 60 + validatorIndex * headerCellWidth;
          const isCovered = this.packingResult.coverUnion[validatorIndex];
          ctx.save();
          draw.roundedRect(ctx, bitCellX + 2, currentY - 10, headerCellWidth - 4, 24, 4);
          ctx.fillStyle = isCovered ? C_PRESENT + "55" : C_BIT_ZERO + "33";
          ctx.fill();
          ctx.strokeStyle = isCovered ? C_PRESENT : C_BIT_ZERO;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
          draw.label(ctx, isCovered ? "1" : "0", bitCellX + headerCellWidth / 2, currentY + 2,
            isCovered ? C_PRESENT : colors.textDim, "bold 12px ui-monospace,monospace");
        }
        currentY += 30;
        const coveredCount = this.packingResult.coverUnion.filter(Boolean).length;
        draw.label(ctx,
          `カバー率: ${coveredCount}/${validatorCount} = ${this.coveragePercent()}%  |  使用集約数: ${this.packingResult.chosen.length}/${this.poolAggregates.length}`,
          contentX + contentWidth / 2, Math.min(currentY, panelY + panelHeight - 14),
          colors.text, "bold 11px ui-monospace,monospace");
      } else if (!this.packingResult) {
        draw.label(ctx, "「パッキング実行」でSet-Coverを実行",
          contentX + contentWidth / 2, currentY + 10, colors.textDim, "11px ui-monospace,monospace");
      }
    },

    onMouse() {},

    getStats() {
      return [
        { label: "委員会サイズ", value: this.committeeSize },
        { label: "参加 (popcount)", value: `${this.presentCount()} / ${this.committeeSize}` },
        { label: "集約署名", value: 1 },
        { label: "利用可能な集約数", value: this.poolAggregates.length },
        { label: "選択された集約", value: this.packingResult ? this.packingResult.chosen.length : "—" },
        { label: "カバー率", value: this.packingResult ? `${this.coveragePercent()}%` : "—" },
      ];
    },

    buildControls(container) {
      const ui = P2P.ui;

      const aggregationGroup = ui.group("Part 1 — 署名集約");
      aggregationGroup.appendChild(ui.button("集約アニメーション", () => this.triggerMergeAnimation(), "primary"));
      aggregationGroup.appendChild(
        ui.slider("委員会サイズ", 4, 16, 1, this.committeeSize, (value) => {
          this.committeeSize = value;
          this.initCommittee();
          rebuildValidatorToggles();
        }),
      );

      const validatorToggleGroup = ui.group("バリデータ ON/OFF");
      const rebuildValidatorToggles = () => {
        validatorToggleGroup.innerHTML = "";
        const heading = document.createElement("div");
        heading.className = "ctl-group-title";
        heading.textContent = "バリデータ ON/OFF";
        validatorToggleGroup.appendChild(heading);
        for (let validatorIndex = 0; validatorIndex < this.committeeSize; validatorIndex++) {
          const capturedIndex = validatorIndex;
          validatorToggleGroup.appendChild(
            ui.toggle(`V${validatorIndex}`, this.validatorPresent[validatorIndex], (checked) => {
              this.validatorPresent[capturedIndex] = checked;
              this.triggerMergeAnimation();
            }),
          );
        }
      };
      rebuildValidatorToggles();
      aggregationGroup.appendChild(validatorToggleGroup);
      container.appendChild(aggregationGroup);

      const packingGroup = ui.group("Part 2 — Proposer パッキング");
      packingGroup.appendChild(ui.button("パッキング実行 ▶", () => this.runPackingSetCover(), "primary"));
      packingGroup.appendChild(
        ui.button("結果をクリア", () => {
          this.packingResult = null;
          this.packingAnimationProgress = 0;
          this.packingAnimationRunning = false;
        }),
      );

      const bitToggleGroup = ui.group("集約ビット編集");
      const bitHeading = document.createElement("div");
      bitHeading.className = "ctl-group-title";
      bitHeading.textContent = "集約ビット編集";
      bitToggleGroup.appendChild(bitHeading);

      for (let aggregateIndex = 0; aggregateIndex < this.poolAggregates.length; aggregateIndex++) {
        const aggregate = this.poolAggregates[aggregateIndex];
        const aggLabel = document.createElement("div");
        aggLabel.className = "ctl-group-title";
        aggLabel.style.fontSize = "10px";
        aggLabel.textContent = `集約 ${aggregate.label}:`;
        bitToggleGroup.appendChild(aggLabel);
        for (let bitIndex = 0; bitIndex < this.poolValidatorCount; bitIndex++) {
          const capturedAggregateIndex = aggregateIndex;
          const capturedBitIndex = bitIndex;
          bitToggleGroup.appendChild(
            ui.toggle(`V${bitIndex}`, !!aggregate.bits[bitIndex], (checked) => {
              this.poolAggregates[capturedAggregateIndex].bits[capturedBitIndex] = checked ? 1 : 0;
              this.packingResult = null;
            }),
          );
        }
      }
      packingGroup.appendChild(bitToggleGroup);

      const presetGroup = ui.group("プリセット");
      presetGroup.appendChild(ui.button("リセット (A:1100 B:0110 C:0011)", () => this.initPool()));
      packingGroup.appendChild(presetGroup);
      container.appendChild(packingGroup);
    },
  };

  P2P.scenes.aggregation = scene;
})();
