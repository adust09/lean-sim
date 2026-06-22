/*
 * pipeline.js — Unified SSZ pipeline (§2.3–2.5) on one screen.
 *
 * One Validator container flows top→bottom through every stage:
 *   ① 構造        — the container's fields.
 *   ② シリアライズ — fixed fields inline + the variable field as a 4-byte offset
 *                    pointing into the variable part (§2.3).
 *   ③ マークル化   — each field's hash_tree_root is a leaf of a depth-2 tree,
 *                    pair-hashed down to the container hash_tree_root (§2.4).
 *   ④ 証明・検証   — a chosen field's gindex + sibling witnesses recompute the
 *                    root and compare to the trusted root (§2.5).
 *
 * Click a field (struct box / byte segment / leaf) to choose the proof target;
 * "検証 ▶" animates the recomputation. Model + hashing live in sszmodel.js.
 */
"use strict";

(function registerPipeline() {
  const { util, draw, colors } = P2P;
  const M = P2P.sszModel;
  const FIELD_COLOR = [colors.nodeSource, colors.ihave, colors.graft, colors.nodeHasMessage];
  // Fixed pixel widths keep the fixed fields anchored while the variable part grows.
  const FIXED_SEG_WIDTH = [56, 196, 88, 72]; // id, pubkey, balance, offset(for signatures)
  const SIG_PIXELS = 24;

  const scene = {
    id: "pipeline",
    title: "SSZ パイプライン",
    sectionRef: "2.3–2.5",
    descriptionHTML: `
      <p><b>SSZ を構造からハッシュツリールート、証明まで1本の流れで (§2.3–2.5)。</b>
      1つの <code>Validator</code> コンテナが上から下へ各ステージを通る。</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>① 構造:</b> <code>Validator { id: uint16, pubkey: Bytes48, balance: uint64, signatures: List }</code></li>
        <li><b>② シリアライズ (§2.3):</b> 固定フィールドはインライン、可変の <code>signatures</code> は
        固定部に 4 バイトの <b>offset</b> を残し実データは<b>可変部</b>へ。offset 値 = 固定部サイズ。
        リスト長が変わっても固定フィールドの位置は不変。</li>
        <li><b>③ マークル化 (§2.4):</b> 各フィールドの hash_tree_root が深さ2の木の<b>葉</b>。
        ペアを下へハッシュして <code>hash_tree_root</code> に至る。</li>
        <li><b>④ 証明・検証 (§2.5):</b> <code>gindex = 2<sup>depth</sup> + position</code>。
        対象葉の<b>兄弟(witness)</b>を与えれば、検証者がルートを再計算して照合できる。</li>
      </ol>
      <p><b>木の色凡例:</b><br>
      <span style="color:#36d399">●</span> 証明対象 leaf &nbsp;
      <span style="color:#8da2bd">●</span> witness (兄弟・提供) &nbsp;
      <span style="color:#a78bfa">●</span> 再計算 (computed) &nbsp;
      <span style="color:#fbbf24">●</span> trusted root</p>
      <p><b>操作:</b> フィールド(構造ボックス / バイト / 葉)をクリックして証明対象を選択、「検証 ▶」で再計算アニメ。
      「シグネチャ数」で可変部を伸縮。</p>`,

    /* ----------------------- state ----------------------- */
    width: 0,
    height: 0,
    signatureCount: 2,
    selectedFieldIndex: 2,
    hoverGindex: -1,
    tree: null,
    verifyClock: 0,
    isVerifying: false,
    verifyDone: false,
    verifyDuration: 2.0,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.tree = M.buildTree(this.signatureCount);
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    rebuild() {
      this.tree = M.buildTree(this.signatureCount);
      this.resetVerify();
    },
    resetVerify() {
      this.verifyClock = 0;
      this.isVerifying = false;
      this.verifyDone = false;
    },

    update(realDt) {
      if (this.isVerifying) {
        this.verifyClock = Math.min(this.verifyDuration, this.verifyClock + realDt);
        if (this.verifyClock >= this.verifyDuration) { this.isVerifying = false; this.verifyDone = true; }
      }
    },

    selectedField() { return M.FIELDS[this.selectedFieldIndex]; },
    targetGindex() { return this.selectedField().gindex; },

    /* ----------------------- geometry ----------------------- */
    serializeTop() { return 116; },
    treeBox() {
      // top leaves sit well below the ③ label so their field-name captions clear it.
      return { left: 30, top: 248, right: this.width * 0.63, bottom: this.height - 96 };
    },
    gindexPos(gindex) {
      const box = this.treeBox();
      const level = Math.floor(Math.log2(gindex)); // 0=root … 2=leaves
      const nodesAtLevel = Math.pow(2, level);
      const pos = gindex - nodesAtLevel;
      const x = box.left + (pos + 0.5) * ((box.right - box.left) / nodesAtLevel);
      const y = box.top + ((2 - level) / 2) * (box.bottom - box.top); // leaves top, root bottom
      return { x, y };
    },
    /** Centered byte-segment x ranges for the serialize strip. */
    segments() {
      const variableWidth = this.signatureCount * SIG_PIXELS;
      const fixedTotal = FIXED_SEG_WIDTH.reduce((a, b) => a + b, 0);
      const total = fixedTotal + variableWidth;
      let x = (this.width - total) / 2;
      const segs = [];
      for (let i = 0; i < 4; i++) { segs.push({ x, w: FIXED_SEG_WIDTH[i], field: i }); x += FIXED_SEG_WIDTH[i]; }
      segs.push({ x, w: variableWidth, variable: true });
      return segs;
    },

    /* ----------------------- proof roles ----------------------- */
    nodeRole(gindex) {
      const plan = M.proofPlan(this.targetGindex());
      if (gindex === 1) return "trusted";
      if (gindex === plan.targetGindex) return "target";
      if (plan.witnesses.includes(gindex)) return "witness";
      if (plan.computed.includes(gindex)) return "computed";
      return "passive";
    },
    revealedComputedCount() {
      const plan = M.proofPlan(this.targetGindex());
      const intermediate = plan.computed.slice(1); // exclude leaf
      if (this.verifyDone) return intermediate.length;
      return Math.floor((this.verifyClock / this.verifyDuration) * intermediate.length);
    },

    /* ----------------------- rendering ----------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderStruct(ctx);
      this.renderSerialize(ctx);
      this.renderTree(ctx);
      this.renderProofPanel(ctx);
    },

    renderStruct(ctx) {
      draw.label(ctx, "① 構造 — Validator container", 30, 18, colors.accent, "bold 12px ui-monospace, monospace", "left");
      const y = 30;
      let x = 30;
      M.FIELDS.forEach((field, i) => {
        const w = 150;
        const selected = i === this.selectedFieldIndex;
        ctx.save();
        draw.roundedRect(ctx, x, y, w, 40, 6);
        ctx.fillStyle = selected ? FIELD_COLOR[i] + "22" : "#15202f";
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1.3;
        ctx.strokeStyle = FIELD_COLOR[i];
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, `${field.name}: ${field.type}`, x + w / 2, y + 14, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, field.fixed ? `${field.value} (${field.bytes}B fixed)` : `signatures × ${this.signatureCount} (offset)`, x + w / 2, y + 29, colors.textDim, "9px ui-monospace, monospace");
        field._structX = x + w / 2;
        x += w + 10;
      });
    },

    renderSerialize(ctx) {
      const layout = M.serializeLayout(this.signatureCount);
      const top = this.serializeTop();
      draw.label(ctx, `② シリアライズ (§2.3) — 固定部 ${layout.fixedBytes}B + 可変部 ${layout.variableBytes}B = 合計 ${layout.totalBytes}B`, 30, top - 18, colors.accent, "bold 12px ui-monospace, monospace", "left");
      const segs = this.segments();
      const h = 40;
      // fixed/variable separator
      const sep = segs[4].x;
      draw.line(ctx, sep, top - 8, sep, top + h + 10, colors.textDim, 1.4, true);
      for (let i = 0; i < 4; i++) {
        const seg = segs[i];
        const field = M.FIELDS[i];
        const isOffset = i === 3;
        const color = isOffset ? colors.accent : FIELD_COLOR[i];
        const selected = i === this.selectedFieldIndex;
        ctx.save();
        draw.roundedRect(ctx, seg.x, top, seg.w, h, 5);
        ctx.fillStyle = color + (selected ? "33" : "1a");
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, isOffset ? "offset" : field.name, seg.x + seg.w / 2, top + 14, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, isOffset ? `→ ${layout.offsetValue}` : `${field.bytes}B`, seg.x + seg.w / 2, top + 29, colors.textDim, "9px ui-monospace, monospace");
        seg._cx = seg.x + seg.w / 2;
      }
      // variable part
      const varSeg = segs[4];
      if (varSeg.w > 0) {
        ctx.save();
        draw.roundedRect(ctx, varSeg.x, top, varSeg.w, h, 5);
        ctx.fillStyle = FIELD_COLOR[3] + (this.selectedFieldIndex === 3 ? "33" : "1a");
        ctx.fill();
        ctx.lineWidth = this.selectedFieldIndex === 3 ? 2 : 1.5;
        ctx.strokeStyle = FIELD_COLOR[3];
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, "signatures (可変部)", varSeg.x + varSeg.w / 2, top + 14, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, `${layout.variableBytes}B`, varSeg.x + varSeg.w / 2, top + 29, colors.textDim, "9px ui-monospace, monospace");
      }
      // offset → variable arrow
      const offsetCx = segs[3].x + segs[3].w / 2;
      draw.line(ctx, offsetCx, top + h + 8, offsetCx, top + h + 18, colors.accent + "cc", 1.4, true);
      draw.line(ctx, offsetCx, top + h + 18, varSeg.x, top + h + 18, colors.accent + "cc", 1.4, true);
      draw.arrow(ctx, varSeg.x - 0.1, top + h + 18, varSeg.x, top + h + 6, colors.accent, 1.2);
    },

    renderTree(ctx) {
      draw.label(ctx, "③ マークル化 (§2.4) — 各フィールド→葉→ペアハッシュ→hash_tree_root", 30, 198, colors.accent, "bold 12px ui-monospace, monospace", "left");
      // edges
      const edges = [[1, 2], [1, 3], [2, 4], [2, 5], [3, 6], [3, 7]];
      for (const [parent, child] of edges) {
        const a = this.gindexPos(parent);
        const b = this.gindexPos(child);
        const pr = this.nodeRole(parent);
        const cr = this.nodeRole(child);
        let color = colors.grid;
        if (cr === "target") color = colors.nodeHasMessage + "aa";
        else if (cr === "witness") color = colors.textDim + "aa";
        else if (pr === "computed" && cr !== "passive") color = colors.ihave + "aa";
        draw.line(ctx, a.x, a.y, b.x, b.y, color, 1.5);
      }
      // flow connectors for the selected field: byte segment → its leaf
      const seg = this.segments()[this.selectedFieldIndex];
      const leafPos = this.gindexPos(this.targetGindex());
      if (seg) draw.line(ctx, seg.x + seg.w / 2, this.serializeTop() + 40, leafPos.x, leafPos.y - 18, FIELD_COLOR[this.selectedFieldIndex] + "66", 1.2, true);

      const revealed = this.revealedComputedCount();
      const plan = M.proofPlan(this.targetGindex());
      const intermediate = plan.computed.slice(1);
      for (let g = 1; g <= 7; g++) {
        const pos = this.gindexPos(g);
        const role = this.nodeRole(g);
        const isLeaf = g >= 4;
        let fill = colors.node;
        let stroke = colors.nodeStroke;
        let radius = isLeaf ? 17 : 18;
        if (role === "target") { fill = "#1a3040"; stroke = colors.nodeHasMessage; radius = 19; }
        else if (role === "witness") { fill = "#2a2a3a"; stroke = colors.textDim; }
        else if (role === "trusted") { fill = "#1a2840"; stroke = colors.nodeSource; radius = 19; }
        else if (role === "computed") {
          const idx = intermediate.indexOf(g);
          const shown = (idx >= 0 && idx < revealed) || this.verifyDone;
          fill = shown ? "#1a1a40" : colors.grid;
          stroke = shown ? colors.ihave : colors.textDim + "66";
          if (idx === revealed && this.isVerifying) {
            const pulse = 0.5 + 0.5 * Math.sin(this.verifyClock * 12);
            draw.glow(ctx, pos.x, pos.y, 28, colors.ihave + Math.floor(pulse * 200).toString(16).padStart(2, "0"));
          }
        }
        if (g === this.hoverGindex && isLeaf) draw.glow(ctx, pos.x, pos.y, 26, colors.accent + "55");
        draw.disc(ctx, pos.x, pos.y, radius, fill, stroke, role === "target" || role === "trusted" ? 2 : 1.4);
        draw.label(ctx, this.tree[g] || "…", pos.x, pos.y - 3, colors.text, "9px ui-monospace, monospace");
        draw.label(ctx, "g=" + g, pos.x, pos.y + 8, colors.textDim, "8px ui-monospace, monospace");
        if (isLeaf) {
          const field = M.FIELDS[g - 4];
          draw.label(ctx, field.name, pos.x, pos.y - radius - 8, role === "target" ? colors.nodeHasMessage : colors.textDim, "9px ui-monospace, monospace");
        }
      }
      const rootPos = this.gindexPos(1);
      draw.label(ctx, "hash_tree_root = " + this.tree[1], rootPos.x, rootPos.y + 30, colors.prune, "bold 11px ui-monospace, monospace");
      if (this.verifyDone) draw.label(ctx, "✓ 検証成功 (再計算 root = trusted root)", rootPos.x, rootPos.y + 46, colors.nodeHasMessage, "bold 11px ui-monospace, monospace");
    },

    renderProofPanel(ctx) {
      const x = this.width * 0.66;
      const y = 190; // below the serialize strip (② ends ~174) to avoid overlap
      const width = this.width - x - 16;
      if (width < 180) return;
      const field = this.selectedField();
      const plan = M.proofPlan(field.gindex);
      const binary = util.toBinary(field.gindex, 3);
      ctx.save();
      draw.roundedRect(ctx, x, y, width, this.height - y - 96, 8);
      ctx.fillStyle = "#0e1420ee";
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      let ly = y + 18;
      const cx = x + 12;
      draw.label(ctx, "④ 証明・検証 (§2.5)", cx, ly, colors.accent, "bold 11px ui-monospace, monospace", "left"); ly += 22;
      draw.label(ctx, `対象: ${field.name}`, cx, ly, colors.nodeHasMessage, "bold 10px ui-monospace, monospace", "left"); ly += 18;
      draw.label(ctx, `gindex = 2³ + ${field.gindex - 4} = ${field.gindex} (${binary})`, cx, ly, colors.accent, "10px ui-monospace, monospace", "left"); ly += 18;
      const path = binary.slice(1).split("").map((b) => (b === "0" ? "左" : "右")).join("→");
      draw.label(ctx, `経路: ルート→${path}`, cx, ly, colors.textDim, "10px ui-monospace, monospace", "left"); ly += 22;
      draw.label(ctx, "witness (兄弟・提供):", cx, ly, colors.textDim, "10px ui-monospace, monospace", "left"); ly += 16;
      for (const w of plan.witnesses) {
        const wf = M.FIELDS.find((f) => f.gindex === w);
        draw.label(ctx, `  g=${w} ${wf ? wf.name : "node"} ${this.tree[w]}`, cx, ly, colors.textDim, "9px ui-monospace, monospace", "left"); ly += 15;
      }
      ly += 6;
      draw.label(ctx, "再計算 (computed):", cx, ly, colors.textDim, "10px ui-monospace, monospace", "left"); ly += 16;
      const steps = this.verifySteps(plan);
      const shown = Math.ceil((this.verifyClock / this.verifyDuration) * steps.length);
      steps.forEach((step, i) => {
        const lit = i < shown || this.verifyDone;
        draw.label(ctx, "  " + step, cx, ly, lit ? colors.ihave : colors.textDim + "55", "9px ui-monospace, monospace", "left"); ly += 15;
      });
    },

    verifySteps(plan) {
      const steps = [];
      let g = plan.targetGindex;
      while (g > 1) {
        const sib = g % 2 === 0 ? g + 1 : g - 1;
        const parent = Math.floor(g / 2);
        const lo = Math.min(g, sib);
        const hi = Math.max(g, sib);
        steps.push(`H(g${lo},g${hi}) = g${parent} ${this.tree[parent]}${parent === 1 ? " ✓" : ""}`);
        g = parent;
      }
      return steps;
    },

    /* ----------------------- interaction ----------------------- */
    onMouse(type, mx, my) {
      if (type === "move") {
        this.hoverGindex = this.leafAt(mx, my);
        return;
      }
      if (type !== "click") return;
      const leaf = this.leafAt(mx, my);
      if (leaf >= 4) { this.selectField(leaf - 4); return; }
      // struct boxes / byte segments
      const hit = this.fieldBoxAt(mx, my);
      if (hit >= 0) this.selectField(hit);
    },
    selectField(index) {
      this.selectedFieldIndex = index;
      this.resetVerify();
    },
    leafAt(mx, my) {
      for (let g = 4; g <= 7; g++) {
        const pos = this.gindexPos(g);
        if (util.distance(mx, my, pos.x, pos.y) <= 22) return g;
      }
      return -1;
    },
    fieldBoxAt(mx, my) {
      // struct row (y 30..70): 4 boxes width 150 gap 10 from x 30
      if (my >= 30 && my <= 70) {
        const i = Math.floor((mx - 30) / 160);
        if (i >= 0 && i < 4 && (mx - 30) % 160 <= 150) return i;
      }
      // serialize segments
      if (my >= this.serializeTop() && my <= this.serializeTop() + 40) {
        for (const seg of this.segments()) {
          if (seg.field != null && mx >= seg.x && mx <= seg.x + seg.w) return seg.field;
        }
      }
      return -1;
    },

    /* ----------------------- stats ----------------------- */
    getStats() {
      const layout = M.serializeLayout(this.signatureCount);
      const plan = M.proofPlan(this.targetGindex());
      const field = this.selectedField();
      return [
        { label: "シグネチャ数 (可変部)", value: `${this.signatureCount} (${layout.variableBytes}B)` },
        { label: "合計サイズ", value: `${layout.totalBytes}B (固定 ${layout.fixedBytes} + 可変 ${layout.variableBytes})` },
        { label: "offset 値", value: `${layout.offsetValue}` },
        { label: "hash_tree_root", value: this.tree[1] },
        { label: "証明対象", value: `${field.name} (g=${field.gindex})` },
        { label: "witness", value: "g" + plan.witnesses.join(", g") },
        { label: "検証結果", value: this.verifyDone ? "✓ 成功" : this.isVerifying ? "計算中…" : "未実行" },
      ];
    },

    /* ----------------------- controls ----------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const fieldGroup = ui.group("証明対象フィールド");
      this.fieldButtons = [];
      M.FIELDS.forEach((field, i) => {
        const button = ui.button(`${field.name} (g=${field.gindex})`, () => {
          this.selectField(i);
          this.updateFieldButtons();
        });
        button.dataset.index = i;
        this.fieldButtons.push(button);
        fieldGroup.appendChild(button);
      });
      container.appendChild(fieldGroup);
      this.updateFieldButtons();

      const verifyGroup = ui.group("検証");
      verifyGroup.appendChild(ui.button("検証 ▶", () => { this.verifyClock = 0; this.isVerifying = true; this.verifyDone = false; }, "primary"));
      verifyGroup.appendChild(ui.button("リセット", () => this.resetVerify()));
      container.appendChild(verifyGroup);

      const dataGroup = ui.group("コンテナ");
      dataGroup.appendChild(ui.slider("シグネチャ数 (可変部)", 0, 6, 1, this.signatureCount, (value) => {
        this.signatureCount = value;
        this.rebuild();
      }));
      container.appendChild(dataGroup);
    },

    updateFieldButtons() {
      (this.fieldButtons || []).forEach((b) => b.classList.toggle("primary", Number(b.dataset.index) === this.selectedFieldIndex));
    },
  };

  P2P.scenes.pipeline = scene;
})();
