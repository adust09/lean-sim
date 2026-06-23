/*
 * forkchoice.js — §6.2, §6.3, §6.5.3: Fork choice, justification, and finalization.
 *
 * Block tree with attestation references (source/target/head), vote accumulation,
 * supermajority justification, and finalization. Also shows the 3SF-mini admissible-
 * target ruler (§6.5.3.2). Click a block to move the head vote; "投票を追加" to add
 * vote weight; "次のスロット" to advance time.
 */
"use strict";

(function registerForkchoice() {
  const { util, draw, colors, ease } = P2P;

  const BLOCK_RADIUS = 18;
  const SLOT_COLUMN_WIDTH = 90;
  const TREE_TOP_MARGIN = 60;
  const TREE_LEFT_MARGIN = 60;
  const RULER_HEIGHT = 56;
  const RULER_MARGIN = 12;
  const LEGEND_WIDTH = 170;

  const C_FINALIZED = "#36d399";
  const C_JUSTIFIED = "#22d3ee";
  const C_CHECKPOINT = "#a78bfa";
  const C_BLOCK_DEFAULT = "#3a4a63";
  const C_SOURCE_LINK = "#36d399";
  const C_HEAD_ARROW = "#60a5fa";
  const C_TARGET_RING = "#fbbf24";
  const C_FORK = "#f87171";

  function visibleSlotCount(width) {
    return Math.max(3, Math.floor((width - TREE_LEFT_MARGIN - LEGEND_WIDTH) / SLOT_COLUMN_WIDTH));
  }

  const scene = {
    id: "forkchoice",
    title: "フォーク選択と正当化",
    sectionRef: "fork_choice.py · slot.py",
    descriptionHTML: `
      <p><b>Attestation の3参照 (§6.2):</b></p>
      <ul>
        <li><span style="color:#36d399">■</span> <b>Source:</b> 最後に正当化されたチェックポイント (バリデータの「錨」)。</li>
        <li><span style="color:#fbbf24">■</span> <b>Target:</b> 次に正当化すべきチェックポイント。
            3·votes ≥ 2·total で正当化達成。</li>
        <li><span style="color:#60a5fa">■</span> <b>Head:</b> フォーク選択による現在のチェーン先端。</li>
      </ul>
      <p>制約: source.slot ≤ target.slot ≤ head.slot</p>
      <p><b>操作:</b> ブロックをクリックでヘッド票を移動。「投票を追加」→ 2/3 超で
      <span style="color:#22d3ee">正当化</span>、連続チェーン →
      <span style="color:#36d399">確定</span>。「次のスロット」で先端を延ばす。</p>
      <p><b>下段ルーラー (§6.5.3.2):</b>
      <span style="color:#36d399">δ≤5 即時窓</span> /
      <span style="color:#a78bfa">平方・長方形数</span> /
      <span style="color:#f87171">無効ギャップ</span></p>
      <p><b>色凡例:</b><br>
      <span style="color:#36d399">●</span> F 確定 (Finalized) &nbsp;
      <span style="color:#22d3ee">●</span> J 正当化済み &nbsp;
      <span style="color:#a78bfa">●</span> Target (候補) &nbsp;
      <span style="color:#36d399">●</span> Source リング &nbsp;
      <span style="color:#60a5fa">●</span> Head 囲み &nbsp;
      <span style="color:#f87171">●</span> フォーク枝</p>`,

    width: 0, height: 0, rng: null,
    blocks: [], nextBlockId: 0,
    currentSlot: 0, totalValidators: 32, addVotesBatchSize: 4,
    sourceBlockId: 0, targetBlockId: 0, headBlockId: 0,
    latestJustifiedSlot: 0, latestFinalizedSlot: 0, currentLinkVotes: 0,
    voteParticles: [], voteFlash: 0, justifyFlash: 0,
    scrollSlotOffset: 0, showRuler: true,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.rng = util.makeRng(0xc0ffee42);
      this.resetTree();
    },

    resize(width, height) { this.width = width; this.height = height; },

    resetTree() {
      this.blocks = [];
      this.nextBlockId = 0;
      this.currentSlot = 0;
      this.latestJustifiedSlot = 0;
      this.latestFinalizedSlot = 0;
      this.currentLinkVotes = 0;
      this.voteParticles = [];
      this.voteFlash = 0;
      this.justifyFlash = 0;
      this.scrollSlotOffset = 0;
      this.blocks.push({
        id: this.nextBlockId++, slot: 0, parentId: null,
        votes: this.totalValidators, status: "finalized",
        isFork: false, layoutY: 0.5,
      });
      this.addBlockOnChain(1, 0, 0.5);
      this.addBlockOnChain(2, 1, 0.5);
      this.addBlockOnChain(3, 2, 0.5);
      this.currentSlot = 3;
      this.sourceBlockId = 0;
      this.targetBlockId = 3;
      this.headBlockId = 3;
    },

    addBlockOnChain(slot, parentId, layoutY) {
      const block = { id: this.nextBlockId++, slot, parentId, votes: 0, status: "pending", isFork: false, layoutY };
      this.blocks.push(block);
      return block;
    },

    addForkBlock() {
      const headBlock = this.blockById(this.headBlockId);
      if (!headBlock || headBlock.parentId === null) return;
      const parentBlock = this.blockById(headBlock.parentId);
      if (!parentBlock) return;
      this.blocks.push({
        id: this.nextBlockId++, slot: headBlock.slot, parentId: parentBlock.id,
        votes: 0, status: "pending", isFork: true, layoutY: headBlock.layoutY + 0.3,
      });
    },

    blockById(blockId) { return this.blocks.find((b) => b.id === blockId) || null; },

    leafBlocks() {
      const parentIds = new Set(this.blocks.filter((b) => b.parentId !== null).map((b) => b.parentId));
      return this.blocks.filter((b) => !parentIds.has(b.id));
    },

    heaviestLeaf() {
      const leaves = this.leafBlocks();
      if (!leaves.length) return null;
      return leaves.reduce((best, b) =>
        this.accumulatedWeight(b.id) > this.accumulatedWeight(best.id) ? b : best,
      );
    },

    accumulatedWeight(blockId) {
      let total = 0;
      let current = this.blockById(blockId);
      while (current) {
        total += current.votes;
        if (current.parentId === null) break;
        current = this.blockById(current.parentId);
      }
      return total;
    },

    supermajorityThreshold() { return Math.ceil((2 * this.totalValidators) / 3); },

    addVotes() {
      const targetBlock = this.blockById(this.targetBlockId);
      if (!targetBlock || targetBlock.status !== "pending") return;
      targetBlock.votes = Math.min(targetBlock.votes + this.addVotesBatchSize, this.totalValidators);
      this.currentLinkVotes = targetBlock.votes;
      this.voteFlash = 0.8;
      const particleCount = Math.min(this.addVotesBatchSize, 6);
      for (let particleIndex = 0; particleIndex < particleCount; particleIndex++) {
        this.voteParticles.push({
          progress: 0,
          duration: 0.5 + this.rng() * 0.3,
          fromBlockId: this.sourceBlockId,
          toBlockId: this.targetBlockId,
          offsetY: (this.rng() - 0.5) * 30,
        });
      }
      if (3 * targetBlock.votes >= 2 * this.totalValidators) this.justifyTarget();
    },

    justifyTarget() {
      const targetBlock = this.blockById(this.targetBlockId);
      if (!targetBlock || targetBlock.status !== "pending") return;
      targetBlock.status = "justified";
      this.latestJustifiedSlot = targetBlock.slot;
      this.justifyFlash = 1.0;
      const sourceBlock = this.blockById(this.sourceBlockId);
      if (sourceBlock && sourceBlock.status === "justified") {
        sourceBlock.status = "finalized";
        this.latestFinalizedSlot = sourceBlock.slot;
        this.finalizeAncestors(sourceBlock.id);
      }
      this.sourceBlockId = this.targetBlockId;
      this.currentLinkVotes = 0;
      const heaviestLeafBlock = this.heaviestLeaf();
      if (heaviestLeafBlock) {
        this.headBlockId = heaviestLeafBlock.id;
        this.targetBlockId = this.headBlockId;
      }
    },

    finalizeAncestors(blockId) {
      let currentBlock = this.blockById(blockId);
      while (currentBlock && currentBlock.parentId !== null) {
        const parentBlock = this.blockById(currentBlock.parentId);
        if (parentBlock && parentBlock.status !== "finalized") {
          parentBlock.status = "finalized";
          this.latestFinalizedSlot = Math.max(this.latestFinalizedSlot, parentBlock.slot);
        }
        currentBlock = parentBlock;
      }
    },

    advanceSlot() {
      this.currentSlot++;
      const newBlock = this.addBlockOnChain(this.currentSlot, this.headBlockId, 0.5);
      this.headBlockId = newBlock.id;
      const targetBlock = this.blockById(this.targetBlockId);
      if (!targetBlock || targetBlock.status !== "pending") this.targetBlockId = newBlock.id;
      const maxVisible = visibleSlotCount(this.width);
      if (this.currentSlot >= this.scrollSlotOffset + maxVisible) {
        this.scrollSlotOffset = this.currentSlot - maxVisible + 1;
      }
    },

    treeAreaHeight() {
      const rulerAreaHeight = this.showRuler ? RULER_HEIGHT + RULER_MARGIN * 2 : 0;
      return this.height - TREE_TOP_MARGIN - rulerAreaHeight;
    },

    slotToPixelX(slot) {
      return TREE_LEFT_MARGIN + (slot - this.scrollSlotOffset) * SLOT_COLUMN_WIDTH + SLOT_COLUMN_WIDTH / 2;
    },

    blockPixelY(block) {
      return TREE_TOP_MARGIN + block.layoutY * (this.treeAreaHeight() - TREE_TOP_MARGIN);
    },

    blockPixelPosition(block) { return { x: this.slotToPixelX(block.slot), y: this.blockPixelY(block) }; },

    isSlotVisible(slot) {
      const maxVisible = visibleSlotCount(this.width);
      return slot >= this.scrollSlotOffset && slot < this.scrollSlotOffset + maxVisible;
    },

    blockAt(pixelX, pixelY) {
      for (const block of this.blocks) {
        if (!this.isSlotVisible(block.slot)) continue;
        const pos = this.blockPixelPosition(block);
        if (util.distance(pixelX, pixelY, pos.x, pos.y) <= BLOCK_RADIUS + 6) return block;
      }
      return null;
    },

    update(realDt) {
      this.voteFlash = Math.max(0, this.voteFlash - realDt * 2);
      this.justifyFlash = Math.max(0, this.justifyFlash - realDt * 1.2);
      const survivors = [];
      for (const particle of this.voteParticles) {
        particle.progress += realDt / particle.duration;
        if (particle.progress < 1) survivors.push(particle);
      }
      this.voteParticles = survivors;
    },

    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderSlotColumns(ctx);
      this.renderBlockEdges(ctx);
      this.renderAttestationLinks(ctx);
      this.renderVoteParticles(ctx);
      this.renderBlocks(ctx);
      this.renderSlotLabels(ctx);
      this.renderLegend(ctx);
      if (this.showRuler) this.renderAdmissibleTargetRuler(ctx);
    },

    renderSlotColumns(ctx) {
      const maxVisible = visibleSlotCount(this.width);
      for (let slotIndex = 0; slotIndex < maxVisible; slotIndex++) {
        const slot = this.scrollSlotOffset + slotIndex;
        const columnX = TREE_LEFT_MARGIN + slotIndex * SLOT_COLUMN_WIDTH;
        if (slotIndex % 2 === 0) {
          ctx.fillStyle = "#ffffff06";
          ctx.fillRect(columnX, TREE_TOP_MARGIN, SLOT_COLUMN_WIDTH, this.treeAreaHeight() - TREE_TOP_MARGIN);
        }
        if (slot === this.currentSlot) {
          ctx.save();
          ctx.strokeStyle = "#60a5fa33";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(columnX + 1, TREE_TOP_MARGIN, SLOT_COLUMN_WIDTH - 2, this.treeAreaHeight() - TREE_TOP_MARGIN - 2);
          ctx.restore();
        }
      }
    },

    renderSlotLabels(ctx) {
      const maxVisible = visibleSlotCount(this.width);
      for (let slotIndex = 0; slotIndex < maxVisible; slotIndex++) {
        const slot = this.scrollSlotOffset + slotIndex;
        const columnCenterX = TREE_LEFT_MARGIN + slotIndex * SLOT_COLUMN_WIDTH + SLOT_COLUMN_WIDTH / 2;
        const isCurrentSlot = slot === this.currentSlot;
        draw.label(
          ctx, `スロット ${slot}`, columnCenterX, TREE_TOP_MARGIN - 18,
          isCurrentSlot ? colors.accent : colors.textDim,
          isCurrentSlot ? "bold 11px ui-monospace,monospace" : "11px ui-monospace,monospace",
        );
      }
    },

    renderBlockEdges(ctx) {
      for (const block of this.blocks) {
        if (!this.isSlotVisible(block.slot) || block.parentId === null) continue;
        const parentBlock = this.blockById(block.parentId);
        if (!parentBlock) continue;
        const pos = this.blockPixelPosition(block);
        const parentPos = this.blockPixelPosition(parentBlock);
        draw.line(ctx, parentPos.x, parentPos.y, pos.x, pos.y,
          block.isFork ? C_FORK + "88" : colors.peerEdge, block.isFork ? 1.5 : 2, block.isFork);
      }
    },

    renderAttestationLinks(ctx) {
      const sourceBlock = this.blockById(this.sourceBlockId);
      const targetBlock = this.blockById(this.targetBlockId);
      const headBlock = this.blockById(this.headBlockId);
      if (!sourceBlock || !targetBlock || !headBlock) return;

      if (sourceBlock.id !== targetBlock.id &&
          this.isSlotVisible(sourceBlock.slot) && this.isSlotVisible(targetBlock.slot)) {
        const srcPos = this.blockPixelPosition(sourceBlock);
        const tgtPos = this.blockPixelPosition(targetBlock);
        draw.arrow(ctx, srcPos.x, srcPos.y - BLOCK_RADIUS - 4, tgtPos.x, tgtPos.y - BLOCK_RADIUS - 4, C_SOURCE_LINK + "cc", 2);
        draw.label(ctx, "確定票 (source→target)",
          (srcPos.x + tgtPos.x) / 2, Math.min(srcPos.y, tgtPos.y) - BLOCK_RADIUS - 18,
          C_SOURCE_LINK, "10px ui-monospace,monospace");
      }

      if (this.isSlotVisible(headBlock.slot)) {
        const headPos = this.blockPixelPosition(headBlock);
        draw.arrow(ctx, headPos.x, headPos.y + BLOCK_RADIUS + 22, headPos.x, headPos.y + BLOCK_RADIUS + 4, C_HEAD_ARROW + "cc", 2);
        draw.label(ctx, "ヘッド票", headPos.x, headPos.y + BLOCK_RADIUS + 32, C_HEAD_ARROW, "10px ui-monospace,monospace");
      }
    },

    renderVoteParticles(ctx) {
      for (const particle of this.voteParticles) {
        const fromBlock = this.blockById(particle.fromBlockId);
        const toBlock = this.blockById(particle.toBlockId);
        if (!fromBlock || !toBlock) continue;
        const fromPos = this.blockPixelPosition(fromBlock);
        const toPos = this.blockPixelPosition(toBlock);
        const eased = ease.outCubic(particle.progress);
        const x = util.lerp(fromPos.x, toPos.x, eased);
        const y = util.lerp(fromPos.y, toPos.y, eased) + particle.offsetY * (1 - eased);
        draw.disc(ctx, x, y, 4, C_TARGET_RING, null);
        draw.glow(ctx, x, y, 12, C_TARGET_RING);
      }
    },

    renderBlocks(ctx) {
      for (const block of this.blocks) {
        if (!this.isSlotVisible(block.slot)) continue;
        const pos = this.blockPixelPosition(block);
        const isSource = block.id === this.sourceBlockId;
        const isTarget = block.id === this.targetBlockId;
        const isHead = block.id === this.headBlockId;

        let fillColor = C_BLOCK_DEFAULT;
        if (block.status === "finalized") fillColor = C_FINALIZED;
        else if (block.status === "justified") fillColor = C_JUSTIFIED;
        else if (isTarget) fillColor = C_CHECKPOINT;

        if (isHead && this.justifyFlash > 0) draw.glow(ctx, pos.x, pos.y, BLOCK_RADIUS * 2, C_JUSTIFIED);
        draw.disc(ctx, pos.x, pos.y, BLOCK_RADIUS, fillColor, colors.nodeStroke, 1.5);

        if (isSource) draw.disc(ctx, pos.x, pos.y, BLOCK_RADIUS + 5, null, C_SOURCE_LINK, 2.5);
        if (isTarget && block.status === "pending") {
          ctx.save();
          ctx.setLineDash([4, 3]);
          draw.disc(ctx, pos.x, pos.y, BLOCK_RADIUS + 8, null, C_TARGET_RING, 2);
          ctx.restore();
        }
        if (isHead) {
          ctx.save();
          ctx.strokeStyle = C_HEAD_ARROW;
          ctx.lineWidth = 2;
          ctx.strokeRect(pos.x - BLOCK_RADIUS - 6, pos.y - BLOCK_RADIUS - 6, (BLOCK_RADIUS + 6) * 2, (BLOCK_RADIUS + 6) * 2);
          ctx.restore();
        }

        if (block.status === "pending" && block.votes > 0) {
          const barWidth = (BLOCK_RADIUS * 2 - 6) * (block.votes / this.totalValidators);
          ctx.fillStyle = C_TARGET_RING + "aa";
          ctx.fillRect(pos.x - BLOCK_RADIUS + 3, pos.y + BLOCK_RADIUS - 7, barWidth, 4);
        }

        const statusLabel =
          block.status === "finalized" ? "F" : block.status === "justified" ? "J"
          : block.votes > 0 ? String(block.votes) : String(block.slot);
        draw.label(ctx, statusLabel, pos.x, pos.y, colors.text, "bold 11px ui-monospace,monospace");
      }
    },

    renderLegend(ctx) {
      const legendX = this.width - LEGEND_WIDTH + 8;
      const threshold = this.supermajorityThreshold();
      const targetBlock = this.blockById(this.targetBlockId);
      const currentVotes = targetBlock ? targetBlock.votes : 0;
      let currentY = TREE_TOP_MARGIN;
      draw.label(ctx, `票: ${currentVotes}/${this.totalValidators} (${Math.round(currentVotes / this.totalValidators * 100)}%)`,
        legendX, currentY, this.voteFlash > 0.3 ? C_TARGET_RING : colors.text, "11px ui-monospace,monospace", "left");
      currentY += 16;
      draw.label(ctx, `閾値: ${threshold} (${Math.round(threshold / this.totalValidators * 100)}%)`,
        legendX, currentY, colors.textDim, "10px ui-monospace,monospace", "left");
    },

    renderAdmissibleTargetRuler(ctx) {
      const rulerY = this.height - RULER_HEIGHT - RULER_MARGIN;
      const rulerX = TREE_LEFT_MARGIN;
      const rulerWidth = this.width - TREE_LEFT_MARGIN - LEGEND_WIDTH - 8;
      const contentHeight = RULER_HEIGHT - 24;

      ctx.save();
      draw.roundedRect(ctx, rulerX - 6, rulerY - 4, rulerWidth + 12, RULER_HEIGHT + 8, 6);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();

      draw.label(ctx, "§6.5.3.2 許容ターゲット距離 δ",
        rulerX + rulerWidth / 2, rulerY + 8, colors.textDim, "10px ui-monospace,monospace");

      function admissibility(delta) {
        if (delta <= 5) return "immediate";
        if (Number.isInteger(Math.sqrt(delta))) return "square";
        const n = Math.floor((-1 + Math.sqrt(1 + 4 * delta)) / 2);
        if (n * (n + 1) === delta) return "pronic";
        return "invalid";
      }

      const cellWidth = Math.max(10, Math.floor(rulerWidth / Math.min(30, Math.floor(rulerWidth / 14))));
      const cellsToShow = Math.floor(rulerWidth / cellWidth);

      for (let deltaIndex = 0; deltaIndex <= cellsToShow; deltaIndex++) {
        const kind = admissibility(deltaIndex);
        const cellX = rulerX + deltaIndex * cellWidth;
        const cellY = rulerY + 18;
        ctx.fillStyle = (kind === "invalid") ? C_FORK + "66" : (kind === "immediate") ? C_FINALIZED : C_CHECKPOINT;
        ctx.fillRect(cellX + 1, cellY, cellWidth - 2, contentHeight);
        if (cellWidth >= 12) {
          draw.label(ctx, String(deltaIndex), cellX + cellWidth / 2, cellY + contentHeight / 2,
            kind === "invalid" ? "#ffffff44" : "#ffffffcc", "9px ui-monospace,monospace");
        }
      }

      const labelY = rulerY + RULER_HEIGHT - 6;
      draw.label(ctx, "■ 即時窓(δ≤5)", rulerX, labelY, C_FINALIZED, "9px ui-monospace,monospace", "left");
      draw.label(ctx, "■ 平方/長方形数", rulerX + 90, labelY, C_CHECKPOINT, "9px ui-monospace,monospace", "left");
      draw.label(ctx, "■ 無効ギャップ", rulerX + 190, labelY, C_FORK, "9px ui-monospace,monospace", "left");
    },

    onMouse(type, pixelX, pixelY) {
      if (type !== "click") return;
      const clickedBlock = this.blockAt(pixelX, pixelY);
      if (!clickedBlock) return;
      const sourceBlock = this.blockById(this.sourceBlockId);
      if (!sourceBlock || clickedBlock.slot < sourceBlock.slot) return;
      this.headBlockId = clickedBlock.id;
      if (clickedBlock.id !== this.targetBlockId && clickedBlock.status === "pending") {
        this.targetBlockId = clickedBlock.id;
        this.currentLinkVotes = clickedBlock.votes;
      }
    },

    getStats() {
      const sourceBlock = this.blockById(this.sourceBlockId);
      const targetBlock = this.blockById(this.targetBlockId);
      const headBlock = this.blockById(this.headBlockId);
      const threshold = this.supermajorityThreshold();
      const currentVotes = targetBlock ? targetBlock.votes : 0;
      return [
        { label: "現在スロット", value: this.currentSlot },
        { label: "総validator数", value: this.totalValidators },
        { label: "target票 / 閾値", value: `${currentVotes}/${threshold} (${Math.round(currentVotes / this.totalValidators * 100)}%)` },
        { label: "最新正当化スロット", value: `スロット ${this.latestJustifiedSlot}` },
        { label: "最新確定スロット", value: `スロット ${this.latestFinalizedSlot}` },
        { label: "現在ヘッド", value: headBlock ? `スロット ${headBlock.slot} (#${headBlock.id})` : "—" },
        { label: "Source → Target", value: sourceBlock && targetBlock ? `スロット ${sourceBlock.slot} → ${targetBlock.slot}` : "—" },
      ];
    },

    buildControls(container) {
      const ui = P2P.ui;

      const slotControls = ui.group("スロット操作");
      slotControls.appendChild(ui.button("次のスロット ▶", () => this.advanceSlot(), "primary"));
      slotControls.appendChild(ui.button("対立フォークを作成", () => this.addForkBlock()));
      container.appendChild(slotControls);

      const voteControls = ui.group("投票");
      voteControls.appendChild(ui.button("投票を追加 (バッチ)", () => this.addVotes(), "primary"));
      voteControls.appendChild(
        ui.slider("バッチサイズ", 1, 16, 1, this.addVotesBatchSize, (v) => { this.addVotesBatchSize = v; }),
      );
      voteControls.appendChild(
        ui.slider("総validator数", 8, 64, 8, this.totalValidators, (v) => { this.totalValidators = v; }),
      );
      container.appendChild(voteControls);

      const displayControls = ui.group("表示");
      displayControls.appendChild(
        ui.toggle("§6.5.3.2 許容ターゲットルーラー", this.showRuler, (checked) => { this.showRuler = checked; }),
      );
      container.appendChild(displayControls);

      const resetControls = ui.group("リセット");
      resetControls.appendChild(ui.button("最初からやり直す", () => this.resetTree(), "danger"));
      container.appendChild(resetControls);
    },
  };

  P2P.scenes.forkchoice = scene;
})();
