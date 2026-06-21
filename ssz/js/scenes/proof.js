/*
 * proof.js — Section 2.5: Generalized indices and Merkle multiproofs.
 *
 * Uses a Validator container with 4 fields → depth-2 binary tree.
 * Generalized index rule: gindex = 2^depth + field_position.
 *   pubkey (position 0)               → gindex 4  (100 binary)
 *   withdrawal_credentials (position 1) → gindex 5  (101 binary)
 *   effective_balance (position 2)     → gindex 6  (110 binary)
 *   slashed (position 3)               → gindex 7  (111 binary)
 *
 * Binary path navigation: strip the leading 1 from the gindex binary.
 *   Each subsequent bit = 0 → go Left, 1 → go Right.
 *   gindex 6 = 1·1·0 → Root, Right child (node 3), Left child (node 6).
 *
 * Proof: to prove leaf N, provide the sibling at each level as a "witness".
 *   For gindex 6 (effective_balance):
 *     - witness: node 7 (sibling), node 2 (uncle)
 *     - compute: node 6 (leaf value), H(6,7)=node 3, H(2,3)=root
 *
 * Animation climbs the tree level by level, showing hash re-computation.
 */
"use strict";

(function registerProof() {
  const { util, draw, colors } = P2P;

  /** Rolling polynomial hash → 4-hex tag for display. */
  function deterministicHash(inputString) {
    let hashAccumulator = 0x811c9dc5;
    for (let charIndex = 0; charIndex < inputString.length; charIndex++) {
      hashAccumulator ^= inputString.charCodeAt(charIndex);
      hashAccumulator = (Math.imul(hashAccumulator, 0x01000193) >>> 0);
    }
    return util.toHexTag(hashAccumulator & 0xffff, 4);
  }

  function hashPair(leftLabel, rightLabel) {
    return deterministicHash(leftLabel + "|" + rightLabel);
  }

  // Validator container fields (in order, position 0..3).
  const VALIDATOR_FIELDS = [
    { name: "pubkey", typeName: "BLSPubkey", fieldPosition: 0, gindex: 4, valueLabel: "0xab12" },
    { name: "withdrawal_credentials", typeName: "Bytes32", fieldPosition: 1, gindex: 5, valueLabel: "0xcc00" },
    { name: "effective_balance", typeName: "uint64", fieldPosition: 2, gindex: 6, valueLabel: "32ETH" },
    { name: "slashed", typeName: "boolean", fieldPosition: 3, gindex: 7, valueLabel: "false" },
  ];

  // Node roles during proof verification.
  const NODE_ROLE_LEAF_TARGET = "target";   // the leaf being proven
  const NODE_ROLE_WITNESS = "witness";      // sibling that must be provided
  const NODE_ROLE_COMPUTED = "computed";    // re-computed by the verifier
  const NODE_ROLE_TRUSTED_ROOT = "trusted"; // the known root to compare against
  const NODE_ROLE_PASSIVE = "passive";      // not involved in this proof

  const scene = {
    id: "proof",
    title: "マークル証明",
    sectionRef: "2.5",
    descriptionHTML: `
      <p><b>一般化インデックス (Generalized Index) §2.5</b></p>
      <p>ツリー内の任意ノードに一意な整数 gindex を割り当てる:<br>
      <code>gindex = 2<sup>depth</sup> + position</code></p>
      <p>gindex の <b>2進数表現</b>がルートからのパスを符号化している。
      先頭の 1 を除いた各ビット: <code>0</code> = 左、<code>1</code> = 右。<br>
      例: gindex 6 = <code>110</code> → 先頭1除去 → <code>10</code> → 右→左。</p>
      <p><b>マークル証明:</b> 葉 N の証明には、ルートまでの経路の
      <em>兄弟ノード</em>（提供）があれば、検証者がルートを再計算して照合できる。</p>
      <p>葉をクリックして証明対象を選択。「検証 ▶」でアニメーション。</p>`,

    /* ----------------------- state ----------------------- */
    width: 0,
    height: 0,

    // Currently selected leaf field index (0–3).
    selectedFieldIndex: 2, // default: effective_balance (gindex 6)

    // Verification animation.
    verificationAnimationClock: 0,
    isVerifying: false,
    verificationDuration: 2.2,
    verificationCompleted: false,

    // Hover for interactivity.
    hoverGindex: -1,

    // Pre-computed node hashes for display.
    nodeHashes: {},

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.computeNodeHashes();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* ----------------------- hash computation ----------------------- */
    computeNodeHashes() {
      // Leaves (gindex 4–7).
      for (const field of VALIDATOR_FIELDS) {
        this.nodeHashes[field.gindex] = deterministicHash(field.name + "=" + field.valueLabel);
      }
      // Internal nodes.
      this.nodeHashes[2] = hashPair(this.nodeHashes[4], this.nodeHashes[5]);
      this.nodeHashes[3] = hashPair(this.nodeHashes[6], this.nodeHashes[7]);
      this.nodeHashes[1] = hashPair(this.nodeHashes[2], this.nodeHashes[3]);
    },

    /* ----------------------- proof logic ----------------------- */
    selectedField() {
      return VALIDATOR_FIELDS[this.selectedFieldIndex];
    },

    /** Return proof witnesses and computed nodes for the selected leaf. */
    proofPlan() {
      const targetGindex = this.selectedField().gindex;

      // Walk from leaf up to root, collecting sibling gindices (witnesses).
      const witnessGindices = [];
      const computedGindices = [targetGindex];
      let currentGindex = targetGindex;

      while (currentGindex > 1) {
        // Sibling: flip the last bit.
        const siblingGindex = currentGindex % 2 === 0 ? currentGindex + 1 : currentGindex - 1;
        witnessGindices.push(siblingGindex);
        // Parent.
        const parentGindex = Math.floor(currentGindex / 2);
        computedGindices.push(parentGindex);
        currentGindex = parentGindex;
      }

      return { targetGindex, witnessGindices, computedGindices };
    },

    nodeRole(gindex) {
      const plan = this.proofPlan();
      if (gindex === 1) return NODE_ROLE_TRUSTED_ROOT;
      if (gindex === plan.targetGindex) return NODE_ROLE_LEAF_TARGET;
      if (plan.witnessGindices.includes(gindex)) return NODE_ROLE_WITNESS;
      if (plan.computedGindices.includes(gindex) && gindex !== plan.targetGindex) return NODE_ROLE_COMPUTED;
      return NODE_ROLE_PASSIVE;
    },

    /* ----------------------- update ----------------------- */
    update(realDt) {
      if (this.isVerifying) {
        this.verificationAnimationClock = Math.min(
          this.verificationDuration,
          this.verificationAnimationClock + realDt,
        );
        if (this.verificationAnimationClock >= this.verificationDuration) {
          this.isVerifying = false;
          this.verificationCompleted = true;
        }
      }
    },

    /* ----------------------- tree layout ----------------------- */
    treeBounds() {
      return {
        left: 30,
        top: 60,
        right: this.width * 0.65,
        bottom: this.height * 0.72,
      };
    },

    /** Pixel position for generalized index gindex in the tree. */
    gindexPixelPosition(gindex) {
      const bounds = this.treeBounds();
      const treeWidth = bounds.right - bounds.left;
      const treeHeight = bounds.bottom - bounds.top;

      // Determine depth (level) from gindex. Level 0 = root (gindex 1), level 1 = gindex 2-3, etc.
      const nodeLevel = Math.floor(Math.log2(gindex));
      const nodesAtLevel = Math.pow(2, nodeLevel);
      const positionAtLevel = gindex - nodesAtLevel; // 0-based position within level

      const x = bounds.left + (positionAtLevel + 0.5) * (treeWidth / nodesAtLevel);
      const y = bounds.top + nodeLevel * (treeHeight / 2);
      return { x, y };
    },

    /* ----------------------- rendering ----------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderTreeEdges(ctx);
      this.renderTreeNodes(ctx);
      this.renderPathPanel(ctx);
      this.renderProofPanel(ctx);
      this.renderLegend(ctx);
    },

    renderTreeEdges(ctx) {
      // Edges: 1→2, 1→3, 2→4, 2→5, 3→6, 3→7.
      const edgePairs = [[1, 2], [1, 3], [2, 4], [2, 5], [3, 6], [3, 7]];
      for (const [parentGindex, childGindex] of edgePairs) {
        const parentPos = this.gindexPixelPosition(parentGindex);
        const childPos = this.gindexPixelPosition(childGindex);
        const parentRole = this.nodeRole(parentGindex);
        const childRole = this.nodeRole(childGindex);

        let edgeColor = colors.grid;
        if (parentRole === NODE_ROLE_COMPUTED && childRole !== NODE_ROLE_PASSIVE) {
          edgeColor = colors.ihave + "88";
        } else if (childRole === NODE_ROLE_LEAF_TARGET) {
          edgeColor = colors.nodeHasMessage + "88";
        } else if (childRole === NODE_ROLE_WITNESS) {
          edgeColor = colors.nodeStroke + "88";
        }
        draw.line(ctx, parentPos.x, parentPos.y, childPos.x, childPos.y, edgeColor, 1.5);
      }
    },

    renderTreeNodes(ctx) {
      const plan = this.proofPlan();
      const totalGindices = [1, 2, 3, 4, 5, 6, 7];

      // Compute which computed nodes have been "revealed" by the animation.
      const animationFraction = this.verificationAnimationClock / this.verificationDuration;
      // Computed nodes in order from leaf toward root (skip the leaf itself for animation purposes).
      const computedIntermediateGindices = plan.computedGindices.slice(1); // exclude leaf
      const revealedComputedCount = Math.floor(animationFraction * computedIntermediateGindices.length);

      for (const gindex of totalGindices) {
        const pos = this.gindexPixelPosition(gindex);
        const role = this.nodeRole(gindex);
        const isLeaf = gindex >= 4;
        const isHovered = gindex === this.hoverGindex;

        // Check animation reveal state for computed nodes.
        const computedIndex = computedIntermediateGindices.indexOf(gindex);
        const isRevealedComputed = computedIndex >= 0 && computedIndex < revealedComputedCount;
        const isAnimatingNow = computedIndex === revealedComputedCount && this.isVerifying;

        if (isHovered && isLeaf) {
          draw.glow(ctx, pos.x, pos.y, 28, colors.accent + "55");
        }

        let fillColor = colors.node;
        let strokeColor = colors.nodeStroke;
        let nodeRadius = 20;

        if (role === NODE_ROLE_LEAF_TARGET) {
          fillColor = "#1a3040";
          strokeColor = colors.nodeHasMessage;
          nodeRadius = 22;
        } else if (role === NODE_ROLE_WITNESS) {
          fillColor = "#2a2a3a";
          strokeColor = colors.textDim;
        } else if (role === NODE_ROLE_COMPUTED) {
          if (isRevealedComputed || (!this.isVerifying && this.verificationCompleted)) {
            fillColor = "#1a1a40";
            strokeColor = colors.ihave;
          } else {
            fillColor = colors.grid;
            strokeColor = colors.textDim + "55";
          }
          if (isAnimatingNow) {
            const pulse = 0.5 + 0.5 * Math.sin(this.verificationAnimationClock * 12);
            draw.glow(ctx, pos.x, pos.y, 30, colors.ihave + Math.floor(pulse * 200).toString(16).padStart(2, "0"));
          }
        } else if (role === NODE_ROLE_TRUSTED_ROOT) {
          fillColor = "#1a2840";
          strokeColor = colors.nodeSource;
          nodeRadius = 22;
        }

        draw.disc(ctx, pos.x, pos.y, nodeRadius, fillColor, strokeColor, role === NODE_ROLE_LEAF_TARGET || role === NODE_ROLE_TRUSTED_ROOT ? 2 : 1.4);

        // Hash label inside node.
        const hashDisplayLabel = this.nodeHashes[gindex] || "…";
        draw.label(ctx, hashDisplayLabel, pos.x, pos.y - 4, colors.text, "9px ui-monospace, monospace");

        // gindex label below hash.
        draw.label(ctx, "g=" + gindex, pos.x, pos.y + 8, colors.textDim, "8px ui-monospace, monospace");

        // For leaf nodes: field name and value above.
        if (isLeaf) {
          const fieldIndex = gindex - 4;
          const field = VALIDATOR_FIELDS[fieldIndex];
          draw.label(ctx, field.name, pos.x, pos.y - nodeRadius - 18, role === NODE_ROLE_LEAF_TARGET ? colors.nodeHasMessage : colors.textDim, "10px ui-monospace, monospace");
          draw.label(ctx, field.valueLabel, pos.x, pos.y - nodeRadius - 6, colors.textDim, "9px ui-monospace, monospace");
        }
      }

      // Verification result checkmark.
      if (this.verificationCompleted && !this.isVerifying) {
        const rootPos = this.gindexPixelPosition(1);
        draw.label(ctx, "✓ 検証成功", rootPos.x, rootPos.y - 36, colors.nodeHasMessage, "bold 13px ui-monospace, monospace");
      }
    },

    renderPathPanel(ctx) {
      const field = this.selectedField();
      const gindex = field.gindex;
      const binaryString = util.toBinary(gindex, 3); // 3 bits for gindex 4–7

      const panelX = this.width * 0.67;
      const panelY = 60;
      const panelWidth = this.width - panelX - 16;
      const panelHeight = 130;

      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 8);
      ctx.fillStyle = "#0e1420ee";
      ctx.fill();
      ctx.restore();

      draw.label(
        ctx,
        "gindex パスデコード",
        panelX + panelWidth / 2,
        panelY + 16,
        colors.textDim,
        "bold 11px ui-monospace, monospace",
      );

      const contentX = panelX + 12;
      let lineY = panelY + 36;
      const lineHeight = 20;

      draw.label(ctx, "対象フィールド:", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, field.name, contentX + 110, lineY, colors.nodeHasMessage, "bold 10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      draw.label(ctx, "gindex:", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, String(gindex) + " (2進: " + binaryString + ")", contentX + 110, lineY, colors.accent, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      draw.label(ctx, "計算:", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, `2³ + ${field.fieldPosition} = ${gindex}`, contentX + 110, lineY, colors.accent, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      // Path steps from binary.
      const pathBits = binaryString.slice(1); // remove leading 1
      const pathSteps = ["ルート"];
      for (const bit of pathBits) {
        pathSteps.push(bit === "0" ? "← 左" : "→ 右");
      }
      draw.label(ctx, "経路:", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      draw.label(ctx, pathSteps.join(" → "), contentX + 110, lineY, colors.accent, "9px ui-monospace, monospace", "left");
      lineY += lineHeight;

      draw.label(ctx, `${binaryString[0]}·${binaryString[1]}·${binaryString[2]} → 先頭1除去 → ${pathBits}`, contentX, lineY, colors.textDim, "9px ui-monospace, monospace", "left");
    },

    renderProofPanel(ctx) {
      const plan = this.proofPlan();
      const panelX = this.width * 0.67;
      const panelY = 210;
      const panelWidth = this.width - panelX - 16;
      const panelHeight = 180;

      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 8);
      ctx.fillStyle = "#0e1420ee";
      ctx.fill();
      ctx.restore();

      draw.label(
        ctx,
        "証明ステップ",
        panelX + panelWidth / 2,
        panelY + 16,
        colors.textDim,
        "bold 11px ui-monospace, monospace",
      );

      const contentX = panelX + 12;
      let lineY = panelY + 36;
      const lineHeight = 18;

      draw.label(ctx, "提供 (witnesses):", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;
      for (const witnessGindex of plan.witnessGindices) {
        const witnessField = VALIDATOR_FIELDS.find((f) => f.gindex === witnessGindex);
        const witnessName = witnessField ? witnessField.name : "node" + witnessGindex;
        draw.label(ctx, `  g=${witnessGindex} (${witnessName})`, contentX, lineY, colors.nodeStroke, "10px ui-monospace, monospace", "left");
        lineY += lineHeight;
      }

      lineY += 4;
      draw.label(ctx, "計算 (computed):", contentX, lineY, colors.textDim, "10px ui-monospace, monospace", "left");
      lineY += lineHeight;

      // Show verification steps.
      const steps = this.buildVerificationSteps(plan);
      const animationFraction = this.verificationAnimationClock / this.verificationDuration;
      const revealedStepCount = Math.ceil(animationFraction * steps.length);

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const step = steps[stepIndex];
        const isRevealed = stepIndex < revealedStepCount || (!this.isVerifying && this.verificationCompleted);
        const stepColor = isRevealed ? colors.ihave : colors.textDim + "44";
        draw.label(ctx, "  " + step, contentX, lineY, stepColor, "9px ui-monospace, monospace", "left");
        lineY += lineHeight;
      }
    },

    buildVerificationSteps(plan) {
      const steps = [];
      const targetGindex = plan.targetGindex;
      let currentGindex = targetGindex;

      while (currentGindex > 1) {
        const siblingGindex = currentGindex % 2 === 0 ? currentGindex + 1 : currentGindex - 1;
        const parentGindex = Math.floor(currentGindex / 2);
        const isLeftChild = currentGindex % 2 === 0;
        const leftGindex = isLeftChild ? currentGindex : siblingGindex;
        const rightGindex = isLeftChild ? siblingGindex : currentGindex;
        const leftHash = this.nodeHashes[leftGindex] || "?";
        const rightHash = this.nodeHashes[rightGindex] || "?";
        const parentHash = this.nodeHashes[parentGindex] || "?";
        const checkmark = parentGindex === 1 ? " ✓" : "";
        steps.push(`H(g${leftGindex},g${rightGindex}) = g${parentGindex} ${parentHash}${checkmark}`);
        currentGindex = parentGindex;
      }

      return steps;
    },

    renderLegend(ctx) {
      const legendX = 30;
      const legendY = this.height * 0.77;
      const items = [
        { color: colors.nodeHasMessage, label: "証明対象 (target leaf)" },
        { color: colors.textDim, label: "提供ノード (witness)" },
        { color: colors.ihave, label: "再計算ノード (computed)" },
        { color: colors.nodeSource, label: "信頼済みルート (trusted root)" },
      ];
      ctx.save();
      draw.roundedRect(ctx, legendX - 8, legendY - 10, 230, items.length * 18 + 16, 6);
      ctx.fillStyle = "#0e1420cc";
      ctx.fill();
      ctx.restore();
      for (let legendIndex = 0; legendIndex < items.length; legendIndex++) {
        const legendItemY = legendY + legendIndex * 18;
        draw.disc(ctx, legendX + 6, legendItemY, 5, items[legendIndex].color, null);
        draw.label(ctx, items[legendIndex].label, legendX + 18, legendItemY, colors.textDim, "10px ui-monospace, monospace", "left");
      }
    },

    /* ----------------------- mouse interaction ----------------------- */
    onMouse(type, mouseX, mouseY) {
      if (type === "move") {
        this.hoverGindex = this.leafGindexAt(mouseX, mouseY);
      } else if (type === "click") {
        const clickedGindex = this.leafGindexAt(mouseX, mouseY);
        if (clickedGindex >= 4 && clickedGindex <= 7) {
          this.selectedFieldIndex = clickedGindex - 4;
          this.verificationAnimationClock = 0;
          this.isVerifying = false;
          this.verificationCompleted = false;
        }
      }
    },

    leafGindexAt(mouseX, mouseY) {
      for (let gindex = 4; gindex <= 7; gindex++) {
        const pos = this.gindexPixelPosition(gindex);
        if (util.distance(mouseX, mouseY, pos.x, pos.y) <= 24) return gindex;
      }
      return -1;
    },

    /* ----------------------- stats ----------------------- */
    getStats() {
      const field = this.selectedField();
      const plan = this.proofPlan();
      return [
        { label: "対象フィールド", value: field.name },
        { label: "generalized index", value: field.gindex },
        { label: "2進数", value: util.toBinary(field.gindex, 3) },
        { label: "証明 witnesses", value: "g" + plan.witnessGindices.join(", g") },
        { label: "検証結果", value: this.verificationCompleted ? "✓ 成功" : "未実行" },
      ];
    },

    /* ----------------------- controls ----------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const fieldGroup = ui.group("証明対象フィールド");
      for (let fieldIndex = 0; fieldIndex < VALIDATOR_FIELDS.length; fieldIndex++) {
        const field = VALIDATOR_FIELDS[fieldIndex];
        const capturedIndex = fieldIndex;
        const fieldButton = ui.button(
          field.name + " (g=" + field.gindex + ")",
          () => {
            this.selectedFieldIndex = capturedIndex;
            this.verificationAnimationClock = 0;
            this.isVerifying = false;
            this.verificationCompleted = false;
          },
          fieldIndex === this.selectedFieldIndex ? "primary" : undefined,
        );
        fieldGroup.appendChild(fieldButton);
      }
      container.appendChild(fieldGroup);

      const verifyGroup = ui.group("検証");
      verifyGroup.appendChild(
        ui.button("検証 ▶", () => {
          this.verificationAnimationClock = 0;
          this.isVerifying = true;
          this.verificationCompleted = false;
        }, "primary"),
      );
      verifyGroup.appendChild(
        ui.button("リセット", () => {
          this.verificationAnimationClock = 0;
          this.isVerifying = false;
          this.verificationCompleted = false;
        }),
      );
      container.appendChild(verifyGroup);
    },
  };

  P2P.scenes.proof = scene;
})();
