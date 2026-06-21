/*
 * merkleize.js — Section 2.4: Merkleization and hash tree root.
 *
 * Visualizes the three-phase process for List[uint64]:
 *   1. Packing: pack consecutive 8-byte uint64 values into 32-byte chunks.
 *   2. Padding: extend chunk count to the next power of two with zero-chunks.
 *   3. Merkle tree: hash pairs bottom-up until a single content root remains.
 *   4. Mix-in Length: hash_tree_root = H(content_root ∥ length_as_uint256).
 *
 * Key teaching: [A,B] and [A,B,0] produce IDENTICAL chunk trees (padding collision)
 * but DIFFERENT hash_tree_roots once length is mixed in (length distinguishes them).
 *
 * Hash simulation: we derive a short deterministic 4-hex "hash" from child labels
 * using a simple polynomial rolling hash — no real SHA-256 needed.
 */
"use strict";

(function registerMerkleize() {
  const { util, draw, colors } = P2P;

  const DEFAULT_VALUES = [100, 200, 300, 400, 500, 600];
  const BYTES_PER_UINT64 = 8;
  const BYTES_PER_CHUNK = 32;
  const UINT64_PER_CHUNK = BYTES_PER_CHUNK / BYTES_PER_UINT64; // 4 per chunk

  // Reserved leaf capacity: the tree always has at least 4 leaves (depth 2),
  // so the full data + padding + internal + root structure is always shown.
  const MINIMUM_LEAF_CHUNKS = 4;

  /** Deterministic 4-hex hash derived from a string label (rolling polynomial). */
  function hashLabel(labelString) {
    let hashAccumulator = 0x811c9dc5;
    for (let charIndex = 0; charIndex < labelString.length; charIndex++) {
      hashAccumulator ^= labelString.charCodeAt(charIndex);
      hashAccumulator = (Math.imul(hashAccumulator, 0x01000193) >>> 0);
    }
    return util.toHexTag(hashAccumulator & 0xffff, 4);
  }

  function hashPair(leftLabel, rightLabel) {
    return hashLabel(leftLabel + "|" + rightLabel);
  }

  function nextPowerOfTwo(value) {
    if (value <= 1) return 1;
    let power = 1;
    while (power < value) power *= 2;
    return power;
  }

  const scene = {
    id: "merkleize",
    title: "マークル化",
    sectionRef: "2.4",
    descriptionHTML: `
      <p><b>SSZ Merkleization (§2.4)</b></p>
      <p>すべての SSZ 型はハッシュツリールートに変換できる。
      <code>List[uint64]</code> の例で3ステップを確認しよう。</p>
      <ol>
        <li><b>パッキング:</b> 8バイト uint64 を 32バイトのチャンクに詰める (4個/chunk)。</li>
        <li><b>パディング:</b> チャンク数が 2 の冪になるようゼロチャンクを末尾に追加。</li>
        <li><b>ツリー構築:</b> 葉から根に向かってペアを順にハッシュ。</li>
      </ol>
      <p><b>長さのミックスイン:</b><br>
      <code>hash_tree_root = H(content_root ∥ length_as_uint256)</code><br>
      これにより <code>[A,B]</code> と <code>[A,B,0]</code> は
      コンテンツツリーが同一でも <b>異なる</b> ルートを持つ。</p>
      <p>「長さ衝突デモ」ボタンで 2 つのリストを並べて比較。</p>`,

    /* ----------------------- state ----------------------- */
    width: 0,
    height: 0,
    elementCount: 6,
    animationClock: 0,
    animationDuration: 0,
    isAnimating: false,
    autoAnimate: true,
    showLengthCollisionDemo: false,

    /** Computed tree for the current element count. */
    treeNodes: [],
    leafCount: 0,
    chunkCount: 0,
    paddedChunkCount: 0,
    contentRootLabel: "",
    mixedInRootLabel: "",

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.rebuildTree();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* ----------------------- tree construction ----------------------- */
    rebuildTree() {
      const elementCount = this.elementCount;
      const values = DEFAULT_VALUES.slice(0, elementCount);

      // Packing: fill chunks with uint64 values (4 per chunk).
      const chunkCount = Math.max(1, Math.ceil(elementCount / UINT64_PER_CHUNK));
      // Pad the chunk count up to a power of two. A List has a reserved
      // capacity, so the Merkle tree always reserves a fixed number of leaves;
      // for this example the capacity rounds the leaf count up to at least
      // MINIMUM_LEAF_CHUNKS (depth 2). This keeps the full structure visible —
      // data chunks + zero-padding chunks → internal nodes → root — for every
      // element count the slider can produce (0–8).
      const paddedChunkCount = Math.max(MINIMUM_LEAF_CHUNKS, nextPowerOfTwo(chunkCount));

      // Build leaf labels. Real chunks: "chunk<i>:[v0,v1,v2,v3]"; padding: "zero".
      const leafLabels = [];
      for (let chunkIndex = 0; chunkIndex < paddedChunkCount; chunkIndex++) {
        if (chunkIndex < chunkCount) {
          const chunkValues = values.slice(chunkIndex * UINT64_PER_CHUNK, (chunkIndex + 1) * UINT64_PER_CHUNK);
          leafLabels.push("C" + chunkIndex + ":[" + chunkValues.join(",") + "]");
        } else {
          leafLabels.push("zero");
        }
      }

      // Build binary tree bottom-up. Each node: { level, position, label, isLeaf, isPadding }.
      const treeDepth = Math.log2(paddedChunkCount); // exact since paddedChunkCount is power-of-two
      const totalLevels = treeDepth + 1; // level 0 = root, level treeDepth = leaves
      const nodesByLevel = [];

      // Leaves at level treeDepth.
      const leafNodes = leafLabels.map((leafLabel, leafPosition) => ({
        level: treeDepth,
        position: leafPosition,
        label: leafPosition < chunkCount ? "C" + leafPosition : "0",
        isLeaf: true,
        isPadding: leafPosition >= chunkCount,
        hashLabel: hashLabel(leafLabel),
      }));
      nodesByLevel[treeDepth] = leafNodes;

      // Internal nodes from leaves up.
      for (let currentLevel = treeDepth - 1; currentLevel >= 0; currentLevel--) {
        const childLevel = nodesByLevel[currentLevel + 1];
        const nodesAtLevel = [];
        for (let position = 0; position < childLevel.length / 2; position++) {
          const leftChild = childLevel[position * 2];
          const rightChild = childLevel[position * 2 + 1];
          nodesAtLevel.push({
            level: currentLevel,
            position,
            isLeaf: false,
            isPadding: false,
            hashLabel: hashPair(leftChild.hashLabel, rightChild.hashLabel),
            leftChildPosition: position * 2,
            rightChildPosition: position * 2 + 1,
          });
        }
        nodesByLevel[currentLevel] = nodesAtLevel;
      }

      // Flatten for lookup.
      const flatNodes = [];
      for (let level = 0; level < totalLevels; level++) {
        for (const node of nodesByLevel[level]) {
          flatNodes.push(node);
        }
      }

      this.treeNodes = flatNodes;
      this.nodesByLevel = nodesByLevel;
      this.chunkCount = chunkCount;
      this.paddedChunkCount = paddedChunkCount;
      this.treeDepth = treeDepth;
      this.contentRootLabel = nodesByLevel[0][0].hashLabel;

      // Mix-in length: H(content_root || element_count).
      this.mixedInRootLabel = hashPair(this.contentRootLabel, "len=" + elementCount);

      // Reset animation.
      this.animationClock = 0;
      this.animationDuration = (treeDepth + 2) * 0.8;
      if (this.autoAnimate) this.isAnimating = true;
    },

    /* ----------------------- update ----------------------- */
    update(realDt) {
      if (this.isAnimating) {
        this.animationClock = Math.min(this.animationDuration, this.animationClock + realDt * 0.9);
        if (this.animationClock >= this.animationDuration) this.isAnimating = false;
      }
    },

    /* ----------------------- layout helpers ----------------------- */
    /*
     * Vertical bands of the canvas (top to bottom):
     *   - title strip            : y ≈ 18      (one clean line)
     *   - tree band              : top .. bottom (root row near the top,
     *                              leaf row near the bottom of the band)
     *   - Mix-in Length panel    : starts at this.height * 0.66
     * Each tree level is given a generous row so node labels never collide
     * with the title above or the panel below.
     */
    TITLE_STRIP_HEIGHT: 44,

    treeCanvasBounds() {
      const leftMargin = 30;
      // Tree starts below the title strip; leave headroom for the root's
      // "content root" caption that is drawn above the root disc.
      const topMargin = this.TITLE_STRIP_HEIGHT + 18;
      const rightMargin = this.showLengthCollisionDemo ? this.width * 0.5 : this.width - 30;
      // Keep the leaf row clear of the Mix-in panel that begins at 0.66h.
      const bottomMargin = this.height * 0.6;
      return {
        left: leftMargin,
        top: topMargin,
        right: rightMargin,
        bottom: bottomMargin,
        width: rightMargin - leftMargin,
        height: bottomMargin - topMargin,
      };
    },

    nodePixelPosition(level, position, bounds) {
      const levelCount = this.treeDepth + 1;
      const nodesAtLevel = this.paddedChunkCount / Math.pow(2, this.treeDepth - level);
      const cellWidth = bounds.width / nodesAtLevel;
      const x = bounds.left + cellWidth * position + cellWidth / 2;
      // Level 0 (root) sits at bounds.top, the deepest level (leaves) at
      // bounds.bottom; intermediate levels are spread evenly between them.
      const y = bounds.top + (level / Math.max(1, levelCount - 1)) * bounds.height;
      return { x, y };
    },

    /* Level that should be visible at the current animation clock. */
    revealedDepthLevel() {
      if (!this.isAnimating && this.animationClock >= this.animationDuration) return 0;
      // Reveal from leaves (deepest) up to root (level 0).
      const fraction = this.animationClock / this.animationDuration;
      const deepestVisibleLevel = Math.round(this.treeDepth - fraction * (this.treeDepth + 1));
      return Math.max(0, deepestVisibleLevel);
    },

    /* ----------------------- rendering ----------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderTree(ctx, false, this.treeCanvasBounds());
      if (this.showLengthCollisionDemo) {
        this.renderLengthCollisionDemo(ctx);
      }
      this.renderMixInPanel(ctx);
      this.renderLegend(ctx);
    },

    renderTree(ctx, forceFull, bounds) {
      const depthLevelVisible = forceFull ? 0 : this.revealedDepthLevel();

      // Title: ONE clean line in the top strip, centered over the tree band.
      draw.label(
        ctx,
        `List[uint64] (${this.elementCount} 要素) — チャンク: ${this.chunkCount}, パディング後 (2の冪): ${this.paddedChunkCount}`,
        bounds.left + bounds.width / 2,
        this.TITLE_STRIP_HEIGHT / 2,
        colors.textDim,
        "12px ui-monospace, monospace",
      );

      // Draw edges first.
      for (const node of this.treeNodes) {
        if (node.isLeaf) continue;
        if (node.level < depthLevelVisible) continue;
        const nodePosition = this.nodePixelPosition(node.level, node.position, bounds);
        const childLevel = node.level + 1;
        const leftPosition = this.nodePixelPosition(childLevel, node.leftChildPosition, bounds);
        const rightPosition = this.nodePixelPosition(childLevel, node.rightChildPosition, bounds);

        const edgeOpacity = node.level === depthLevelVisible ? "88" : "ff";
        draw.line(ctx, nodePosition.x, nodePosition.y, leftPosition.x, leftPosition.y, colors.grid + edgeOpacity, 1.2);
        draw.line(ctx, nodePosition.x, nodePosition.y, rightPosition.x, rightPosition.y, colors.grid + edgeOpacity, 1.2);
      }

      // Draw nodes.
      for (const node of this.treeNodes) {
        if (node.level < depthLevelVisible) continue;
        const pos = this.nodePixelPosition(node.level, node.position, bounds);

        // Pulsing glow on the currently-being-revealed level.
        const isHashingLevel = node.level === depthLevelVisible && this.isAnimating && !node.isLeaf;
        if (isHashingLevel) {
          const pulse = 0.5 + 0.5 * Math.sin(this.animationClock * 8);
          draw.glow(ctx, pos.x, pos.y, 22, colors.accent + Math.floor(pulse * 255).toString(16).padStart(2, "0"));
        }

        let fillColor = colors.node;
        let strokeColor = colors.nodeStroke;

        if (node.isLeaf && node.isPadding) {
          fillColor = colors.grid;
          strokeColor = colors.textDim;
        } else if (node.isLeaf) {
          fillColor = "#1a3040";
          strokeColor = colors.accent;
        } else if (node.level === 0) {
          fillColor = "#1a2840";
          strokeColor = colors.nodeHasMessage;
        } else {
          fillColor = "#1a2030";
          strokeColor = colors.ihave;
        }

        const nodeRadius = node.level === 0 ? 17 : 15;

        // Padding leaves use a dashed outline to read as "filler, not data".
        if (node.isLeaf && node.isPadding) {
          ctx.save();
          ctx.setLineDash([4, 4]);
          draw.disc(ctx, pos.x, pos.y, nodeRadius, fillColor, strokeColor, 1.4);
          ctx.restore();
        } else {
          draw.disc(ctx, pos.x, pos.y, nodeRadius, fillColor, strokeColor, node.level === 0 ? 2 : 1.4);
        }
        draw.label(ctx, node.hashLabel || "…", pos.x, pos.y, colors.text, "9px ui-monospace, monospace");

        if (node.isLeaf) {
          // Caption below leaf: chunk name (C0, C1, …) or "0 (pad)".
          const leafCaption = node.isPadding ? "0 (pad)" : node.label;
          draw.label(
            ctx,
            leafCaption,
            pos.x,
            pos.y + nodeRadius + 10,
            node.isPadding ? colors.textDim : colors.accent,
            "9px ui-monospace, monospace",
          );
        } else if (node.level > 0) {
          // Caption above internal node: H<left><right>, e.g. H01 / H23.
          const internalLabel =
            "H" + node.leftChildPosition + node.rightChildPosition;
          draw.label(
            ctx,
            internalLabel,
            pos.x,
            pos.y - nodeRadius - 9,
            colors.ihave,
            "9px ui-monospace, monospace",
          );
        }
      }

      // Root caption: drawn above the root disc, inside the headroom gap
      // between the title strip and bounds.top — never on top of the title.
      const rootPos = this.nodePixelPosition(0, 0, bounds);
      if (depthLevelVisible === 0) {
        draw.label(ctx, "content root: " + this.contentRootLabel, rootPos.x, rootPos.y - 22, colors.nodeHasMessage, "10px ui-monospace, monospace");
      }
    },

    renderMixInPanel(ctx) {
      const panelX = 20;
      const panelY = this.height * 0.66;
      const panelWidth = this.showLengthCollisionDemo ? this.width * 0.45 : this.width - 40;
      const panelHeight = 90;

      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 8);
      ctx.fillStyle = "#0e1420ee";
      ctx.fill();
      ctx.restore();

      draw.label(
        ctx,
        "長さのミックスイン (Mix-in Length)",
        panelX + panelWidth / 2,
        panelY + 16,
        colors.textDim,
        "bold 11px ui-monospace, monospace",
      );

      const formulaY = panelY + 38;
      draw.label(ctx, "content_root =", panelX + 16, formulaY, colors.textDim, "11px ui-monospace, monospace", "left");
      draw.label(ctx, this.contentRootLabel, panelX + 130, formulaY, colors.nodeHasMessage, "11px ui-monospace, monospace", "left");

      draw.label(ctx, "length =", panelX + 16, formulaY + 20, colors.textDim, "11px ui-monospace, monospace", "left");
      draw.label(ctx, String(this.elementCount), panelX + 130, formulaY + 20, colors.nodeSource, "11px ui-monospace, monospace", "left");

      draw.label(ctx, "hash_tree_root =", panelX + 16, formulaY + 40, colors.textDim, "11px ui-monospace, monospace", "left");
      draw.label(ctx, this.mixedInRootLabel, panelX + 140, formulaY + 40, colors.prune, "bold 11px ui-monospace, monospace", "left");
      draw.label(ctx, "H(content_root ‖ length)", panelX + 220, formulaY + 40, colors.textDim, "9px ui-monospace, monospace", "left");
    },

    renderLengthCollisionDemo(ctx) {
      // Show two lists side by side: [100,200] vs [100,200,0].
      // They have the same chunk content but different lengths → different roots.
      const demoX = this.width * 0.52;
      const demoY = this.height * 0.06;

      draw.label(
        ctx,
        "長さ衝突デモ: [100,200] vs [100,200,0]",
        demoX + (this.width - demoX) / 2,
        demoY,
        colors.nodeSource,
        "bold 11px ui-monospace, monospace",
      );

      const rootLabelA = hashPair(hashLabel("C0:[100,200]"), hashLabel("zero"));
      const mixedRootLabelA = hashPair(rootLabelA, "len=2");
      const rootLabelB = hashPair(hashLabel("C0:[100,200,0]"), hashLabel("zero"));
      const mixedRootLabelB = hashPair(rootLabelB, "len=3");

      const columnA = demoX + 30;
      const columnB = demoX + (this.width - demoX) / 2 + 10;
      const lineHeight = 18;
      let lineY = demoY + 20;

      draw.label(ctx, "[100, 200]", columnA + 60, lineY, colors.accent, "bold 11px ui-monospace, monospace");
      draw.label(ctx, "[100, 200, 0]", columnB + 70, lineY, colors.ihave, "bold 11px ui-monospace, monospace");
      lineY += lineHeight;

      draw.label(ctx, "content_root:", columnA, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, rootLabelA, columnA + 100, lineY, colors.nodeHasMessage, "10px ui-monospace, monospace", "left");
      draw.label(ctx, "content_root:", columnB, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, rootLabelB, columnB + 100, lineY, colors.nodeHasMessage, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      const sameRoot = rootLabelA === rootLabelB;
      draw.label(
        ctx,
        sameRoot ? "← 同一 (パディング衝突！)" : "← 異なる",
        (columnA + columnB) / 2 + 50,
        lineY - 9,
        sameRoot ? colors.nodeTarget : colors.nodeHasMessage,
        "10px ui-monospace, monospace",
      );
      lineY += lineHeight;

      draw.label(ctx, "length:", columnA, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, "2", columnA + 100, lineY, colors.nodeSource, "10px ui-monospace, monospace", "left");
      draw.label(ctx, "length:", columnB, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, "3", columnB + 100, lineY, colors.nodeSource, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      draw.label(ctx, "hash_tree_root:", columnA, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, mixedRootLabelA, columnA + 110, lineY, colors.prune, "bold 10px ui-monospace, monospace", "left");
      draw.label(ctx, "hash_tree_root:", columnB, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, mixedRootLabelB, columnB + 110, lineY, colors.prune, "bold 10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      const sameRoot2 = mixedRootLabelA === mixedRootLabelB;
      draw.label(
        ctx,
        sameRoot2 ? "← 同一" : "← 異なる (長さで区別！) ✓",
        (columnA + columnB) / 2 + 50,
        lineY - 9,
        sameRoot2 ? colors.nodeTarget : colors.nodeHasMessage,
        "bold 10px ui-monospace, monospace",
      );
    },

    renderLegend(ctx) {
      const legendX = this.width - 168;
      // When the collision demo occupies the top-right, drop the legend below
      // it so the two never overlap; otherwise keep it high-right in the gap
      // between the root row and the internal-node row.
      const legendY = this.showLengthCollisionDemo ? this.height * 0.42 : this.height * 0.12;
      const items = [
        { color: colors.accent, label: "データチャンク" },
        { color: colors.textDim, label: "パディング (zero)" },
        { color: colors.ihave, label: "内部ノード" },
        { color: colors.nodeHasMessage, label: "コンテンツルート" },
        { color: colors.prune, label: "hash_tree_root" },
      ];
      ctx.save();
      draw.roundedRect(ctx, legendX - 8, legendY - 10, 158, items.length * 18 + 18, 6);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();
      for (let legendIndex = 0; legendIndex < items.length; legendIndex++) {
        const legendItemY = legendY + legendIndex * 18;
        draw.disc(ctx, legendX + 6, legendItemY, 5, items[legendIndex].color, null);
        draw.label(ctx, items[legendIndex].label, legendX + 16, legendItemY, colors.textDim, "10px ui-monospace, monospace", "left");
      }
    },

    onMouse() {},

    /* ----------------------- stats ----------------------- */
    getStats() {
      return [
        { label: "要素数", value: this.elementCount },
        { label: "使用チャンク数", value: this.chunkCount },
        { label: "パディング後 (2の冪)", value: this.paddedChunkCount },
        { label: "木の深さ", value: this.treeDepth },
        { label: "content root", value: this.contentRootLabel },
        { label: "hash_tree_root", value: this.mixedInRootLabel },
      ];
    },

    /* ----------------------- controls ----------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const listGroup = ui.group("リスト設定");
      listGroup.appendChild(
        ui.slider("要素数 (List[uint64])", 0, 8, 1, this.elementCount, (newCount) => {
          this.elementCount = newCount;
          this.rebuildTree();
        }),
      );
      container.appendChild(listGroup);

      const animGroup = ui.group("アニメーション");
      animGroup.appendChild(
        ui.button("再ハッシュ ▶", () => {
          this.animationClock = 0;
          this.isAnimating = true;
        }, "primary"),
      );
      animGroup.appendChild(
        ui.toggle("自動アニメーション", this.autoAnimate, (checked) => {
          this.autoAnimate = checked;
          if (checked) {
            this.animationClock = 0;
            this.isAnimating = true;
          }
        }),
      );
      container.appendChild(animGroup);

      const demoGroup = ui.group("デモ");
      demoGroup.appendChild(
        ui.toggle("長さ衝突デモを表示", this.showLengthCollisionDemo, (checked) => {
          this.showLengthCollisionDemo = checked;
        }),
      );
      container.appendChild(demoGroup);
    },
  };

  P2P.scenes.merkleize = scene;
})();
