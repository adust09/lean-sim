/*
 * aggregation.js — Signature aggregation (post-quantum XMSS proofs).
 * Reference: spec/forks/lstar/containers/aggregation.py
 *            (SingleMessageAggregate, MultiMessageAggregate),
 *            containers/block.py (SignedBlock.proof: MultiMessageAggregate).
 *
 * Part 1 — SingleMessageAggregate: a committee of N validators all sign the
 * SAME message (one AttestationData). Their individual XMSS signatures fold
 * into one proof; a participants bitfield records who signed. Toggle validators
 * on/off to see the bitfield and proof update live.
 *
 * Part 2 — MultiMessageAggregate: a block gathers several single-message
 * aggregates over DISTINCT messages and merges them into ONE proof
 * (merge_many_single_message_proof). The block carries that single proof as
 * SignedBlock.proof. There is NO greedy "set-cover packing" — every
 * single-message aggregate is merged into the one multi-message proof, and the
 * merged proof stores no public keys (they are supplied at verify time).
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
  const MULTI_MERGE_DURATION = 0.9;

  const C_PRESENT = "#36d399";
  const C_ABSENT = "#3a2530";
  const C_AGGREGATE_BOX = "#1e3a2a";
  const C_AGGREGATE_BORDER = "#36d399";
  const C_BIT_ONE = "#36d399";
  const C_BIT_ZERO = "#3a4a63";
  const C_MMA_BORDER = "#22d3ee";
  const C_MMA_BOX = "#15323a";

  /* Distinct single-message aggregates (each over its own AttestationData /
   * message). Participants may overlap across messages — they are different
   * messages, so they merge rather than dedupe. */
  const DEFAULT_MESSAGES = [
    { label: "SMA₁", msg: "target s12", bits: [1, 1, 0, 1] },
    { label: "SMA₂", msg: "target s13", bits: [0, 1, 1, 0] },
    { label: "SMA₃", msg: "target s14", bits: [1, 0, 1, 1] },
    { label: "SMA₄", msg: "target s15", bits: [0, 1, 0, 1] },
  ];

  const scene = {
    id: "aggregation",
    title: "署名集約と統合",
    sectionRef: "6.4",
    descriptionHTML: `
      <p><b>Part 1 — 単一メッセージ集約 (SingleMessageAggregate):</b></p>
      <p>同じ AttestationData(メッセージ)に投票したバリデータの XMSS 署名
      (ハッシュベース・耐量子)を <b>1本の証明</b>に統合。<code>participants</code>
      ビットフィールドが「誰が署名したか」を記録する(ビット i=1 → バリデータ i が署名)。
      公開鍵は proof に含めず、検証側がブロック本体から再導出する。</p>
      <p>各バリデータの ON/OFF を切り替えると bitfield と集約が即座に更新される。</p>
      <p><b>Part 2 — マルチメッセージ統合 (MultiMessageAggregate):</b></p>
      <p>ブロックは<b>異なるメッセージ</b>に対する複数の SingleMessageAggregate を集め、
      <code>merge_many_single_message_proof</code> で <b>1本の proof</b> に統合する。
      ブロックはこの単一 proof を <code>SignedBlock.proof</code> として運ぶ。</p>
      <p><b>貪欲 set-cover パッキングは存在しない</b> — 重複を選り分けるのではなく、
      全ての single-message aggregate を1本の multi-message proof にマージする。
      統合後の proof は公開鍵もビットフィールドも持たず、検証時に外部から供給される。</p>
      <p>「マージ実行」で統合アニメーションを再生。「メッセージ数」で統合する SMA の数を変更できる。</p>`,

    width: 0, height: 0, rng: null,

    // Part 1.
    committeeSize: 8,
    validatorPresent: [],
    mergeAnimationProgress: 0,
    mergeAnimationRunning: false,

    // Part 2.
    messages: [],
    mergeValidatorCount: 4,
    multiMergeResult: null,
    multiMergeProgress: 0,
    multiMergeRunning: false,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.rng = util.makeRng(0xdeadbeef);
      this.initCommittee();
      this.initMessages(3);
    },

    resize(width, height) { this.width = width; this.height = height; },

    initCommittee() {
      this.validatorPresent = Array.from({ length: this.committeeSize }, () => true);
      this.mergeAnimationProgress = 0;
      this.mergeAnimationRunning = false;
    },

    initMessages(count) {
      const messageCount = util.clamp(count, 2, DEFAULT_MESSAGES.length);
      this.messages = DEFAULT_MESSAGES.slice(0, messageCount).map((m) => ({
        label: m.label, msg: m.msg, bits: [...m.bits],
      }));
      this.multiMergeResult = null;
      this.multiMergeProgress = 0;
      this.multiMergeRunning = false;
    },

    presentCount() { return this.validatorPresent.filter(Boolean).length; },

    triggerMergeAnimation() {
      this.mergeAnimationProgress = 0;
      this.mergeAnimationRunning = true;
    },

    runMultiMerge() {
      this.multiMergeResult = { count: this.messages.length };
      this.multiMergeProgress = 0;
      this.multiMergeRunning = true;
    },

    update(realDt) {
      if (this.mergeAnimationRunning) {
        this.mergeAnimationProgress = Math.min(1, this.mergeAnimationProgress + realDt / MERGE_ANIMATION_DURATION);
        if (this.mergeAnimationProgress >= 1) this.mergeAnimationRunning = false;
      }
      if (this.multiMergeRunning) {
        this.multiMergeProgress = Math.min(1, this.multiMergeProgress + realDt / MULTI_MERGE_DURATION);
        if (this.multiMergeProgress >= 1) this.multiMergeRunning = false;
      }
    },

    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      const useSideBySide = this.width >= 720;
      if (useSideBySide) {
        const halfWidth = Math.floor(this.width / 2) - PADDING;
        this.renderAggregationPanel(ctx, PADDING, PADDING, halfWidth, this.height - PADDING * 2);
        this.renderMergePanel(ctx, Math.floor(this.width / 2) + PADDING / 2, PADDING, halfWidth, this.height - PADDING * 2);
      } else {
        const halfHeight = Math.floor(this.height / 2) - PADDING;
        this.renderAggregationPanel(ctx, PADDING, PADDING, this.width - PADDING * 2, halfHeight);
        this.renderMergePanel(ctx, PADDING, Math.floor(this.height / 2) + PADDING / 2, this.width - PADDING * 2, halfHeight);
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

      draw.label(ctx, "Part 1 — SingleMessageAggregate", panelX + panelWidth / 2, panelY + 18,
        colors.accent, "bold 12px ui-monospace,monospace");

      const contentX = panelX + PADDING;
      const contentWidth = panelWidth - PADDING * 2;
      let currentY = panelY + 42;

      draw.label(ctx, "委員会バリデータ (同一メッセージに署名)", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
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

      // Single-message aggregate proof box.
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
      draw.label(ctx, `SingleMessageAggregate (${this.presentCount()} sigs → 1)`,
        contentX + contentWidth / 2, aggregateBoxY + AGGREGATE_BOX_HEIGHT / 2,
        C_PRESENT, "bold 11px ui-monospace,monospace");

      currentY = aggregateBoxY + AGGREGATE_BOX_HEIGHT + 16;
      draw.label(ctx, "participants bitfield:", contentX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
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
      draw.label(ctx, `popcount = ${this.presentCount()} / ${this.committeeSize}  |  proof = 1 本`,
        contentX + contentWidth / 2, Math.min(currentY, panelY + panelHeight - 14),
        colors.text, "11px ui-monospace,monospace");
    },

    renderMergePanel(ctx, panelX, panelY, panelWidth, panelHeight) {
      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, PANEL_RADIUS);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      draw.label(ctx, "Part 2 — MultiMessageAggregate", panelX + panelWidth / 2, panelY + 18,
        colors.accent, "bold 12px ui-monospace,monospace");

      const contentX = panelX + PADDING;
      const contentWidth = panelWidth - PADDING * 2;
      let currentY = panelY + 40;
      const validatorCount = this.mergeValidatorCount;
      const headerCellWidth = Math.min(34, Math.floor((contentWidth - 120) / validatorCount));

      draw.label(ctx, "single-message aggregates (異なるメッセージ)", contentX, currentY,
        colors.textDim, "10px ui-monospace,monospace", "left");
      currentY += 16;

      // Each single-message aggregate: label, message, participants bitfield, proof chip.
      const rowHeight = 34;
      const eased = ease.outCubic(this.multiMergeProgress);
      for (let messageIndex = 0; messageIndex < this.messages.length; messageIndex++) {
        const sma = this.messages[messageIndex];
        const rowY = currentY + messageIndex * (rowHeight + 6);

        draw.label(ctx, sma.label, contentX + 4, rowY + rowHeight / 2,
          C_PRESENT, "bold 12px ui-monospace,monospace", "left");
        draw.label(ctx, sma.msg, contentX + 4, rowY + rowHeight / 2 + 13,
          colors.textDim, "8px ui-monospace,monospace", "left");

        const bitsX = contentX + 76;
        for (let bitIndex = 0; bitIndex < validatorCount; bitIndex++) {
          const bitCellX = bitsX + bitIndex * headerCellWidth;
          const bitValue = sma.bits[bitIndex] ? 1 : 0;
          ctx.save();
          draw.roundedRect(ctx, bitCellX + 2, rowY + 4, headerCellWidth - 4, rowHeight - 8, 4);
          ctx.fillStyle = bitValue ? C_BIT_ONE + "44" : C_BIT_ZERO + "33";
          ctx.fill();
          ctx.strokeStyle = bitValue ? C_BIT_ONE : C_BIT_ZERO;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
          draw.label(ctx, String(bitValue), bitCellX + headerCellWidth / 2, rowY + rowHeight / 2,
            bitValue ? C_BIT_ONE : colors.textDim, "bold 11px ui-monospace,monospace");
        }

        // proof chip
        const chipX = bitsX + validatorCount * headerCellWidth + 8;
        ctx.save();
        draw.roundedRect(ctx, chipX, rowY + 6, 44, rowHeight - 12, 4);
        ctx.strokeStyle = C_AGGREGATE_BORDER;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, "proof", chipX + 22, rowY + rowHeight / 2, C_AGGREGATE_BORDER, "8px ui-monospace,monospace");
      }

      currentY += this.messages.length * (rowHeight + 6) + 6;

      // Merge arrow + the single MultiMessageAggregate output.
      const mergeLabel = this.multiMergeResult ? "merge_many_single_message_proof()" : "「マージ実行」で統合";
      draw.label(ctx, "▼ " + mergeLabel, panelX + panelWidth / 2, currentY + 6,
        this.multiMergeResult ? C_MMA_BORDER : colors.textDim, "10px ui-monospace,monospace");
      currentY += 22;

      const mmaWidth = contentWidth * 0.7;
      const mmaX = contentX + (contentWidth - mmaWidth) / 2;
      const mmaHeight = 40;
      const mmaAlpha = this.multiMergeResult ? Math.max(0.3, ease.outCubic(this.multiMergeProgress * 1.5)) : 0.25;
      ctx.save();
      ctx.globalAlpha = mmaAlpha;
      draw.roundedRect(ctx, mmaX, currentY, mmaWidth, mmaHeight, 6);
      ctx.fillStyle = C_MMA_BOX;
      ctx.fill();
      ctx.strokeStyle = C_MMA_BORDER;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, "MultiMessageAggregate { proof }", mmaX + mmaWidth / 2, currentY + 16,
        C_MMA_BORDER, "bold 11px ui-monospace,monospace");
      draw.label(ctx,
        this.multiMergeResult ? `${this.multiMergeResult.count} SMA → 1 proof` : "公開鍵・bitfield を持たない単一 proof",
        mmaX + mmaWidth / 2, currentY + 30, colors.textDim, "9px ui-monospace,monospace");
      currentY += mmaHeight + 12;

      draw.label(ctx, "→ SignedBlock.proof として運ばれる (set-cover ではなく全 SMA を統合)",
        panelX + panelWidth / 2, Math.min(currentY, panelY + panelHeight - 12),
        colors.text, "9px ui-monospace,monospace");

      // A faint pulse on the MMA box while merging.
      if (this.multiMergeRunning) {
        ctx.save();
        ctx.globalAlpha = 0.4 * (1 - eased);
        draw.glow(ctx, mmaX + mmaWidth / 2, currentY - mmaHeight - 6, 28, C_MMA_BORDER);
        ctx.restore();
      }
    },

    onMouse() {},

    getStats() {
      return [
        { label: "委員会サイズ", value: this.committeeSize },
        { label: "参加 (popcount)", value: `${this.presentCount()} / ${this.committeeSize}` },
        { label: "SingleMessageAggregate", value: 1 },
        { label: "統合する SMA 数", value: this.messages.length },
        { label: "MultiMessageAggregate", value: this.multiMergeResult ? "1 proof" : "—" },
      ];
    },

    buildControls(container) {
      const ui = P2P.ui;

      const aggregationGroup = ui.group("Part 1 — SingleMessageAggregate");
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

      const mergeGroup = ui.group("Part 2 — MultiMessageAggregate");
      mergeGroup.appendChild(ui.button("マージ実行 ▶", () => this.runMultiMerge(), "primary"));
      mergeGroup.appendChild(
        ui.button("結果をクリア", () => {
          this.multiMergeResult = null;
          this.multiMergeProgress = 0;
          this.multiMergeRunning = false;
        }),
      );
      mergeGroup.appendChild(
        ui.slider("メッセージ数 (distinct messages)", 2, DEFAULT_MESSAGES.length, 1, this.messages.length, (value) => {
          this.initMessages(Math.round(value));
        }),
      );
      container.appendChild(mergeGroup);
    },
  };

  P2P.scenes.aggregation = scene;
})();
