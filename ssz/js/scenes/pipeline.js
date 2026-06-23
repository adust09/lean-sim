/*
 * pipeline.js — Unified SSZ pipeline (ssz/) on one screen, with selectable
 * containers (PDF teaching examples + real leanSpec types; see sszmodel.js).
 *
 * The chosen container flows top→bottom through every stage:
 *   ① 構造        — the container's fields.
 *   ② シリアライズ — fixed/nested fields inline + variable fields as 4-byte
 *                    offsets into the variable part (ssz/container.py).
 *   ③ マークル化   — each field's hash_tree_root is a leaf (zero-padded to a
 *                    power of two); pair-hash down to hash_tree_root (crypto/merkleization.py).
 *   ④ 証明・検証   — a field's gindex + sibling witnesses recompute the root
 *                    and compare to the trusted root (crypto/merkleization.py).
 *
 * Click a field (struct box / byte segment / leaf) to choose the proof target;
 * "検証 ▶" animates the recomputation.
 */
"use strict";

(function registerPipeline() {
  const { util, draw, colors } = P2P;
  const M = P2P.sszModel;
  const FIELD_PALETTE = [colors.nodeSource, colors.ihave, colors.graft, colors.nodeHasMessage, colors.accent, colors.iwant];
  const fieldColor = (i) => FIELD_PALETTE[i % FIELD_PALETTE.length];

  const scene = {
    id: "pipeline",
    title: "SSZ パイプライン",
    sectionRef: "ssz/ · merkleization.py",
    descriptionHTML: `
      <p><b>SSZ を構造からハッシュツリールート、証明まで1本の流れで (ssz/)。</b>
      コンテナを選ぶと、それが上から下へ各ステージを通る。</p>
      <ol style="padding-left:18px;margin:0 0 9px">
        <li><b>① 構造:</b> 選択中のコンテナのフィールド。</li>
        <li><b>② シリアライズ (ssz/container.py):</b> 固定/ネストはインライン、可変(List/Bitlist)は
        4バイトの <b>offset</b> を残し実データを<b>可変部</b>へ。リスト長が変わっても固定位置は不変。</li>
        <li><b>③ マークル化 (crypto/merkleization.py):</b> 各フィールドの hash_tree_root が葉(2の冪へ <b>zero-padding</b>)。
        ペアを下へハッシュして <code>hash_tree_root</code> に至る。実装(<code>crypto/merkleization.py</code>)の
        ハッシュは <b>SHA-256</b>(32B チャンク)。本図は見やすさのため疑似ハッシュ(4桁hex)で表示。
        ※ XMSS 署名内部は Poseidon/KoalaBear で、SSZ merkleization の SHA-256 とは別。</li>
        <li><b>④ 証明・検証 (crypto/merkleization.py):</b> <code>gindex = 2<sup>depth</sup> + position</code>。
        対象葉の<b>兄弟(witness)</b>でルートを再計算して照合。</li>
      </ol>
      <p><b>プリセット:</b> 「PDF 教材例」= ValidatorRecord(ssz/container.py 仮想・offset)/ Validator(crypto/merkleization.py Ethereum)。
      「leanSpec 実装」= Checkpoint / Validator(本物) / AttestationData(ネスト) / BlockHeader(深い木+padding)。
      フィールド数で木の深さ・gindex・padding が変わる。</p>
      <p><b>フィールド種別:</b> 固定 / 可変(offset) / ネスト(子コンテナの htr が葉) / padding(zero)。</p>
      <p><b>List/Bitlist の内部木:</b> 可変フィールド(例 <code>signatures</code>)を選ぶと、
      その葉が<b>木の上方向に展開</b>され内部の容量木が現れます。木の
      <b>高さは要素数ではなく容量(LIMIT)で固定</b>され、不足分は<b>ゼロ部分木</b>で埋め、
      最後に <code>mix_in_length(root, 長さ)</code> を取った値がコンテナ木の葉になります
      (<code>crypto/merkleization.py</code>)。「リスト長」スライダーで葉の埋まり方が変わります。</p>
      <p><b>木の色凡例:</b><br>
      <span style="color:#36d399">●</span> 証明対象 leaf &nbsp;
      <span style="color:#8da2bd">●</span> witness (兄弟・提供) &nbsp;
      <span style="color:#a78bfa">●</span> 再計算 (computed) &nbsp;
      <span style="color:#fbbf24">●</span> trusted root</p>
      <p><b>操作:</b> 「構造」プリセットでコンテナを切替。フィールド(構造ボックス / バイト / 葉)をクリックで証明対象を選択、「検証 ▶」で再計算アニメ。「リスト長」で可変部を伸縮。</p>`,

    /* ----------------------- state ----------------------- */
    width: 0,
    height: 0,
    presetKey: "validatorRecord",
    listLength: 2,
    selectedFieldIndex: 1,
    hoverGindex: -1,
    tree: null,
    presetButtons: [],
    fieldButtons: [],
    verifyClock: 0,
    isVerifying: false,
    verifyDone: false,
    verifyDuration: 2.0,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.rebuild();
    },
    resize(width, height) { this.width = width; this.height = height; },

    preset() { return M.PRESETS[this.presetKey]; },
    fields() { return this.preset().fields; },
    base() { return M.leafCount(this.preset()); },
    depth() { return M.treeDepth(this.preset()); },
    selectedField() { return this.fields()[this.selectedFieldIndex]; },
    targetGindex() { return this.base() + this.selectedFieldIndex; },

    rebuild() {
      this.tree = M.buildTree(this.preset(), this.listLength).hashes;
      if (this.selectedFieldIndex >= this.fields().length) this.selectedFieldIndex = 0;
      this.resetVerify();
    },
    resetVerify() { this.verifyClock = 0; this.isVerifying = false; this.verifyDone = false; },
    setPreset(key) {
      this.presetKey = key;
      this.selectedFieldIndex = Math.min(this.selectedFieldIndex, M.PRESETS[key].fields.length - 1);
      this.rebuild();
    },
    selectField(index) { this.selectedFieldIndex = index; this.resetVerify(); },

    update(realDt) {
      if (this.isVerifying) {
        this.verifyClock = Math.min(this.verifyDuration, this.verifyClock + realDt);
        if (this.verifyClock >= this.verifyDuration) { this.isVerifying = false; this.verifyDone = true; }
      }
    },

    /* ----------------------- geometry ----------------------- */
    serializeTop() { return 116; },
    /* When a List/Bitlist field is selected the tree grows: its leaf expands
     * upward into the capacity-sized chunk subtree, so use the full width and a
     * higher top. Otherwise the original compact box (proof panel on the right). */
    listSelected() { return this.selectedField().kind === "variable"; },
    treeBox() {
      const expand = this.listSelected();
      return {
        left: 30,
        top: expand ? 212 : 248,
        right: expand ? this.width - 30 : this.width * 0.63,
        bottom: this.height - 96,
      };
    },
    /* Vertical layout in rows. With a list selected, the chunk subtree occupies
     * the rows above the container leaf row (leaves at row 0, chunk root just
     * above the list leaf), then mix_in_length feeds the container leaf. */
    treeLayout() {
      const containerDepth = Math.max(1, this.depth());
      const expand = this.listSelected();
      const chunkDepth = expand
        ? Math.max(1, M.buildListSubtree(this.selectedField(), this.listLength).depth)
        : 0;
      const containerLeafRow = expand ? chunkDepth + 1 : 0;
      const totalRows = containerLeafRow + containerDepth;
      return { containerDepth, expand, chunkDepth, containerLeafRow, totalRows };
    },
    rowY(row) {
      const box = this.treeBox();
      const { totalRows } = this.treeLayout();
      return totalRows === 0 ? (box.top + box.bottom) / 2 : box.top + (row / totalRows) * (box.bottom - box.top);
    },
    /** Container node position (leaves at containerLeafRow, root at the bottom row). */
    gindexPos(gindex) {
      const box = this.treeBox();
      const { containerDepth, containerLeafRow } = this.treeLayout();
      const level = Math.floor(Math.log2(gindex)); // 0=root … containerDepth=leaves
      const nodesAtLevel = Math.pow(2, level);
      const pos = gindex - nodesAtLevel;
      const x = box.left + (pos + 0.5) * ((box.right - box.left) / nodesAtLevel);
      return { x, y: this.rowY(containerLeafRow + (containerDepth - level)) };
    },
    /** Chunk-subtree node position above the list leaf (centered binary fan-out). */
    chunkPos(subGindex, listLeafX, span) {
      const { chunkDepth } = this.treeLayout();
      const level = Math.floor(Math.log2(subGindex)); // 0=chunk root … chunkDepth=chunk leaves
      const n = Math.pow(2, level);
      const pos = subGindex - n;
      const box = this.treeBox();
      const x = util.clamp(listLeafX + (pos - (n - 1) / 2) * (span / n), box.left + 12, box.right - 12);
      return { x, y: this.rowY(chunkDepth - level) };
    },
    structBoxes() {
      const n = this.fields().length;
      const gap = 8;
      const boxW = Math.min(165, Math.floor((this.width - 60 - gap * (n - 1)) / n));
      return this.fields().map((field, i) => ({ field, index: i, x: 30 + i * (boxW + gap), w: boxW }));
    },
    segW(bytes) { return util.clamp(38 + bytes * 2, 44, 190); },
    /** Centered serialize-strip segments (fixed/nested/offset) + variable parts. */
    segments() {
      const layout = M.serializeLayout(this.preset(), this.listLength);
      const fields = this.fields();
      const fixedSegs = layout.segs.map((s) => ({ ...s, w: this.segW(s.bytes), fieldIndex: fields.indexOf(s.field) }));
      const varSegs = layout.varParts.map((p) => ({ ...p, variable: true, w: p.bytes > 0 ? util.clamp(p.bytes * 5, 30, 170) : 0, fieldIndex: fields.indexOf(p.field) }));
      const total = fixedSegs.reduce((a, s) => a + s.w, 0) + varSegs.reduce((a, s) => a + s.w, 0);
      let x = (this.width - total) / 2;
      for (const s of fixedSegs) { s.x = x; x += s.w; }
      const fixedEndX = x;
      for (const s of varSegs) { s.x = x; x += s.w; }
      return { layout, fixedSegs, varSegs, fixedEndX };
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
      const intermediate = M.proofPlan(this.targetGindex()).computed.slice(1);
      if (this.verifyDone) return intermediate.length;
      return Math.floor((this.verifyClock / this.verifyDuration) * intermediate.length);
    },

    /* ----------------------- rendering ----------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderStruct(ctx);
      this.renderSerialize(ctx);
      this.renderTree(ctx);
      // A List/Bitlist selection expands the tree itself (renderTree draws the
      // chunk subtree above its leaf), so it takes the full width and the proof
      // panel is hidden; otherwise show the proof panel on the right.
      if (!this.listSelected()) this.renderProofPanel(ctx);
    },

    renderStruct(ctx) {
      draw.label(ctx, `① 構造 — ${this.preset().label}`, 30, 18, colors.accent, "bold 12px ui-monospace, monospace", "left");
      for (const box of this.structBoxes()) {
        const selected = box.index === this.selectedFieldIndex;
        const color = fieldColor(box.index);
        ctx.save();
        draw.roundedRect(ctx, box.x, 30, box.w, 40, 6);
        ctx.fillStyle = selected ? color + "22" : "#15202f";
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1.3;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
        const field = box.field;
        const kindNote = field.kind === "variable" ? "可変(offset)" : field.kind === "nested" ? "nested" : `${field.bytes}B`;
        draw.label(ctx, `${field.name}`, box.x + box.w / 2, 44, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, `${field.type} · ${kindNote}`, box.x + box.w / 2, 59, colors.textDim, "9px ui-monospace, monospace");
      }
    },

    renderSerialize(ctx) {
      const { layout, fixedSegs, varSegs, fixedEndX } = this.segments();
      const top = this.serializeTop();
      const offNote = layout.varParts.length ? "" : " (可変なし=全固定)";
      draw.label(ctx, `② シリアライズ (ssz/container.py) — 固定部 ${layout.fixedBytes}B + 可変部 ${layout.variableBytes}B = 合計 ${layout.totalBytes}B${offNote}`, 30, top - 18, colors.accent, "bold 12px ui-monospace, monospace", "left");
      const h = 40;
      if (varSegs.length) draw.line(ctx, fixedEndX, top - 8, fixedEndX, top + h + 10, colors.textDim, 1.4, true);
      for (const seg of fixedSegs) {
        const isOffset = seg.kind === "offset";
        const color = isOffset ? colors.accent : fieldColor(seg.fieldIndex);
        const selected = seg.fieldIndex === this.selectedFieldIndex;
        this.drawSeg(ctx, seg.x, top, seg.w, h, color, selected);
        draw.label(ctx, isOffset ? "offset" : seg.field.name, seg.x + seg.w / 2, top + 14, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, isOffset ? `→ ${seg.offsetValue}` : `${seg.bytes}B${seg.kind === "nested" ? " nested" : ""}`, seg.x + seg.w / 2, top + 29, colors.textDim, "9px ui-monospace, monospace");
      }
      for (const seg of varSegs) {
        if (seg.w <= 0) continue;
        this.drawSeg(ctx, seg.x, top, seg.w, h, fieldColor(seg.fieldIndex), seg.fieldIndex === this.selectedFieldIndex);
        draw.label(ctx, `${seg.field.name} (可変部)`, seg.x + seg.w / 2, top + 14, colors.text, "10px ui-monospace, monospace");
        draw.label(ctx, `${seg.bytes}B`, seg.x + seg.w / 2, top + 29, colors.textDim, "9px ui-monospace, monospace");
        // offset → variable arrow
        const offSeg = fixedSegs.find((s) => s.kind === "offset" && s.fieldIndex === seg.fieldIndex);
        if (offSeg) {
          const ocx = offSeg.x + offSeg.w / 2;
          draw.line(ctx, ocx, top + h + 8, ocx, top + h + 18, colors.accent + "cc", 1.4, true);
          draw.line(ctx, ocx, top + h + 18, seg.x, top + h + 18, colors.accent + "cc", 1.4, true);
          draw.arrow(ctx, seg.x - 0.1, top + h + 18, seg.x, top + h + 6, colors.accent, 1.2);
        }
      }
    },

    drawSeg(ctx, x, y, w, h, color, selected) {
      ctx.save();
      draw.roundedRect(ctx, x, y, w, h, 5);
      ctx.fillStyle = color + (selected ? "33" : "1a");
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    },

    renderTree(ctx) {
      const base = this.base();
      const listNote = this.listSelected()
        ? " · List葉↑を容量木+mix_in_lengthに展開" : "";
      draw.label(ctx, `③ マークル化 (crypto/merkleization.py) — 葉 ${this.fields().length}→${base} (深さ ${this.depth()}, padding ${base - this.fields().length})${listNote}`, 30, 198, colors.accent, "bold 12px ui-monospace, monospace", "left");
      // edges
      for (let g = 1; g < base; g++) {
        const a = this.gindexPos(g);
        for (const child of [2 * g, 2 * g + 1]) {
          const b = this.gindexPos(child);
          const cr = this.nodeRole(child);
          const pr = this.nodeRole(g);
          let color = colors.grid;
          if (cr === "target") color = colors.nodeHasMessage + "aa";
          else if (cr === "witness") color = colors.textDim + "aa";
          else if (pr === "computed" && cr !== "passive") color = colors.ihave + "aa";
          draw.line(ctx, a.x, a.y, b.x, b.y, color, 1.5);
        }
      }
      // flow connector: selected field's byte segment → its leaf
      const seg = this.segments().fixedSegs.find((s) => s.fieldIndex === this.selectedFieldIndex);
      const leafPos = this.gindexPos(this.targetGindex());
      if (seg) draw.line(ctx, seg.x + seg.w / 2, this.serializeTop() + 40, leafPos.x, leafPos.y - 18, fieldColor(this.selectedFieldIndex) + "66", 1.2, true);

      const revealed = this.revealedComputedCount();
      const intermediate = M.proofPlan(this.targetGindex()).computed.slice(1);
      for (let g = 1; g <= 2 * base - 1; g++) {
        const pos = this.gindexPos(g);
        const role = this.nodeRole(g);
        const isLeaf = g >= base;
        const isPad = isLeaf && g - base >= this.fields().length;
        let fill = colors.node;
        let stroke = colors.nodeStroke;
        let radius = isLeaf ? 16 : 18;
        if (isPad) { fill = colors.grid; stroke = colors.textDim; }
        else if (role === "target") { fill = "#1a3040"; stroke = colors.nodeHasMessage; radius = 18; }
        else if (role === "witness") { fill = "#2a2a3a"; stroke = colors.textDim; }
        else if (role === "trusted") { fill = "#1a2840"; stroke = colors.nodeSource; radius = 18; }
        else if (role === "computed") {
          const idx = intermediate.indexOf(g);
          const shown = (idx >= 0 && idx < revealed) || this.verifyDone;
          fill = shown ? "#1a1a40" : colors.grid;
          stroke = shown ? colors.ihave : colors.textDim + "66";
          if (idx === revealed && this.isVerifying) {
            const pulse = 0.5 + 0.5 * Math.sin(this.verifyClock * 12);
            draw.glow(ctx, pos.x, pos.y, 26, colors.ihave + Math.floor(pulse * 200).toString(16).padStart(2, "0"));
          }
        }
        if (g === this.hoverGindex && isLeaf) draw.glow(ctx, pos.x, pos.y, 24, colors.accent + "55");
        if (isPad) { ctx.save(); ctx.setLineDash([4, 4]); draw.disc(ctx, pos.x, pos.y, radius, fill, stroke, 1.3); ctx.restore(); }
        else draw.disc(ctx, pos.x, pos.y, radius, fill, stroke, role === "target" || role === "trusted" ? 2 : 1.4);
        draw.label(ctx, this.tree[g] || "…", pos.x, pos.y - 3, isPad ? colors.textDim : colors.text, "9px ui-monospace, monospace");
        draw.label(ctx, "g=" + g, pos.x, pos.y + 8, colors.textDim, "8px ui-monospace, monospace");
        if (isLeaf) {
          const field = isPad ? null : this.fields()[g - base];
          const cap = isPad ? "0 (pad)" : field.name + (field.kind === "nested" ? " ⊞" : field.kind === "variable" ? " [list]" : "");
          draw.label(ctx, cap, pos.x, pos.y - radius - 8, isPad ? colors.textDim : role === "target" ? colors.nodeHasMessage : colors.textDim, "9px ui-monospace, monospace");
        }
      }
      if (this.listSelected()) this.renderChunkSubtree(ctx, base);
      const rootPos = this.gindexPos(1);
      draw.label(ctx, "hash_tree_root = " + this.tree[1], rootPos.x, rootPos.y + 28, colors.prune, "bold 11px ui-monospace, monospace");
      if (this.verifyDone) draw.label(ctx, "✓ 検証成功 (再計算 root = trusted root)", rootPos.x, rootPos.y + 44, colors.nodeHasMessage, "bold 11px ui-monospace, monospace");
    },

    /** Draw the selected list field's chunk subtree above its container leaf, with a
     *  mix_in_length edge feeding the leaf (the leaf value = the list's htr). */
    renderChunkSubtree(ctx, base) {
      const field = this.selectedField();
      const sub = M.buildListSubtree(field, this.listLength);
      const box = this.treeBox();
      const leafPos = this.gindexPos(base + this.selectedFieldIndex);
      const span = (box.right - box.left) * 0.5;
      const cpos = (sg) => this.chunkPos(sg, leafPos.x, span);

      // chunk-tree edges
      for (let sg = 1; sg < sub.capacity; sg++) {
        const a = cpos(sg);
        for (const c of [2 * sg, 2 * sg + 1]) {
          const b = cpos(c);
          draw.line(ctx, a.x, a.y, b.x, b.y, colors.graft + "66", 1.3);
        }
      }
      // mix_in_length: chunk root → list leaf
      const rootP = cpos(1);
      draw.line(ctx, rootP.x, rootP.y, leafPos.x, leafPos.y - 18, colors.ihave + "cc", 1.6, true);
      draw.label(ctx, `mix_in_length(root, 長さ=${sub.length})`, (rootP.x + leafPos.x) / 2 + 6,
        (rootP.y + leafPos.y) / 2, colors.ihave, "8px ui-monospace, monospace", "left");
      // chunk-tree nodes
      for (let sg = 1; sg <= 2 * sub.capacity - 1; sg++) {
        const p = cpos(sg);
        const isLeaf = sg >= sub.capacity;
        const idx = sg - sub.capacity;
        const isPad = isLeaf && idx >= sub.length;
        const r = isLeaf ? 12 : 13;
        let fill = colors.node;
        let stroke = colors.graft;
        if (isPad) { fill = colors.grid; stroke = colors.textDim; }
        else if (sg === 1) { fill = "#143038"; }
        if (isPad) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          draw.disc(ctx, p.x, p.y, r, fill, stroke, 1.2);
          ctx.restore();
        } else {
          draw.disc(ctx, p.x, p.y, r, fill, stroke, sg === 1 ? 2 : 1.3);
        }
        draw.label(ctx, sub.hashes[sg] || "…", p.x, p.y - 2, isPad ? colors.textDim : colors.text, "8px ui-monospace, monospace");
        if (isLeaf) draw.label(ctx, isPad ? "zero" : `[${idx}]`, p.x, p.y - r - 7, colors.textDim, "8px ui-monospace, monospace");
      }
      draw.label(ctx, `${field.type}: 容量 ${field.limit}→葉 ${sub.capacity} (高さ ${sub.depth} 固定・不足はゼロ部分木)`,
        box.left, box.top - 8, colors.graft, "9px ui-monospace, monospace", "left");
    },

    renderProofPanel(ctx) {
      const x = this.width * 0.66;
      const y = 190;
      const width = this.width - x - 16;
      if (width < 180) return;
      const field = this.selectedField();
      const gindex = this.targetGindex();
      const depth = this.depth();
      const plan = M.proofPlan(gindex);
      const binary = util.toBinary(gindex, depth + 1);
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
      draw.label(ctx, "④ 証明・検証 (crypto/merkleization.py)", cx, ly, colors.accent, "bold 11px ui-monospace, monospace", "left"); ly += 22;
      draw.label(ctx, `対象: ${field.name}`, cx, ly, colors.nodeHasMessage, "bold 10px ui-monospace, monospace", "left"); ly += 18;
      draw.label(ctx, `gindex = 2^${depth} + ${this.selectedFieldIndex} = ${gindex} (${binary})`, cx, ly, colors.accent, "10px ui-monospace, monospace", "left"); ly += 18;
      const path = binary.slice(1).split("").map((b) => (b === "0" ? "左" : "右")).join("→") || "(根)";
      draw.label(ctx, `経路: ルート→${path}`, cx, ly, colors.textDim, "10px ui-monospace, monospace", "left"); ly += 22;
      draw.label(ctx, "witness (兄弟・提供):", cx, ly, colors.textDim, "10px ui-monospace, monospace", "left"); ly += 16;
      for (const w of plan.witnesses) {
        const wf = w >= this.base() ? this.fields()[w - this.base()] : null;
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
        steps.push(`H(g${Math.min(g, sib)},g${Math.max(g, sib)}) = g${parent} ${this.tree[parent]}${parent === 1 ? " ✓" : ""}`);
        g = parent;
      }
      return steps;
    },


    /* ----------------------- interaction ----------------------- */
    onMouse(type, mx, my) {
      if (type === "move") { this.hoverGindex = this.leafAt(mx, my); return; }
      if (type !== "click") return;
      const leaf = this.leafAt(mx, my);
      if (leaf >= this.base() && leaf - this.base() < this.fields().length) { this.selectField(leaf - this.base()); this.updateFieldButtons(); return; }
      const hit = this.fieldBoxAt(mx, my);
      if (hit >= 0) { this.selectField(hit); this.updateFieldButtons(); }
    },
    leafAt(mx, my) {
      const base = this.base();
      for (let g = base; g <= 2 * base - 1; g++) {
        const pos = this.gindexPos(g);
        if (util.distance(mx, my, pos.x, pos.y) <= 20) return g;
      }
      return -1;
    },
    fieldBoxAt(mx, my) {
      if (my >= 30 && my <= 70) {
        for (const box of this.structBoxes()) if (mx >= box.x && mx <= box.x + box.w) return box.index;
      }
      if (my >= this.serializeTop() && my <= this.serializeTop() + 40) {
        for (const seg of this.segments().fixedSegs) if (seg.fieldIndex >= 0 && mx >= seg.x && mx <= seg.x + seg.w) return seg.fieldIndex;
      }
      return -1;
    },

    /* ----------------------- stats ----------------------- */
    getStats() {
      const layout = M.serializeLayout(this.preset(), this.listLength);
      const plan = M.proofPlan(this.targetGindex());
      const field = this.selectedField();
      return [
        { label: "コンテナ", value: this.preset().label },
        { label: "フィールド数 / 葉 / 深さ", value: `${this.fields().length} / ${this.base()} / ${this.depth()}` },
        { label: "合計サイズ", value: `${layout.totalBytes}B (固定 ${layout.fixedBytes} + 可変 ${layout.variableBytes})` },
        { label: "可変部 (リスト長)", value: layout.varParts.length ? `${this.listLength} (${layout.variableBytes}B)` : "なし" },
        { label: "hash_tree_root", value: this.tree[1] },
        { label: "証明対象", value: `${field.name} (g=${this.targetGindex()})` },
        { label: "witness", value: "g" + plan.witnesses.join(", g") },
        { label: "検証結果", value: this.verifyDone ? "✓ 成功" : this.isVerifying ? "計算中…" : "未実行" },
      ];
    },

    /* ----------------------- controls ----------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const presetGroup = ui.group("構造 (プリセット)");
      this.presetButtons = [];
      for (const key of Object.keys(M.PRESETS)) {
        const button = ui.button(M.PRESETS[key].label, () => { this.setPreset(key); this.updatePresetButtons(); this.rebuildFieldButtons(); });
        button.dataset.key = key;
        this.presetButtons.push(button);
        presetGroup.appendChild(button);
      }
      container.appendChild(presetGroup);
      this.updatePresetButtons();

      this.fieldGroup = ui.group("証明対象フィールド");
      container.appendChild(this.fieldGroup);
      this.rebuildFieldButtons();

      const verifyGroup = ui.group("検証");
      verifyGroup.appendChild(ui.button("検証 ▶", () => { this.verifyClock = 0; this.isVerifying = true; this.verifyDone = false; }, "primary"));
      verifyGroup.appendChild(ui.button("リセット", () => this.resetVerify()));
      container.appendChild(verifyGroup);

      const dataGroup = ui.group("可変部");
      dataGroup.appendChild(ui.slider("リスト長 (List/Bitlist)", 0, 6, 1, this.listLength, (value) => { this.listLength = value; this.rebuild(); }));
      container.appendChild(dataGroup);
    },

    rebuildFieldButtons() {
      if (!this.fieldGroup) return;
      this.fieldGroup.innerHTML = "";
      const heading = document.createElement("div");
      heading.className = "ctl-group-title";
      heading.textContent = "証明対象フィールド";
      this.fieldGroup.appendChild(heading);
      this.fieldButtons = [];
      this.fields().forEach((field, i) => {
        const button = P2P.ui.button(`${field.name} (g=${this.base() + i})`, () => { this.selectField(i); this.updateFieldButtons(); });
        button.dataset.index = i;
        this.fieldButtons.push(button);
        this.fieldGroup.appendChild(button);
      });
      this.updateFieldButtons();
    },
    updatePresetButtons() {
      this.presetButtons.forEach((b) => b.classList.toggle("primary", b.dataset.key === this.presetKey));
    },
    updateFieldButtons() {
      this.fieldButtons.forEach((b) => b.classList.toggle("primary", Number(b.dataset.index) === this.selectedFieldIndex));
    },
  };

  P2P.scenes.pipeline = scene;
})();
