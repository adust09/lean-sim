/*
 * anatomy-data.js — Shared state/block anatomy metadata + renderers (containers/state.py).
 *
 * Extracted so the integrated pipeline scene (state_transition.py) can render the FULL field
 * structure of the State container and the Block while staying under the
 * per-file size budget. Exposes `P2P.stateAnatomy`:
 *   - FIELD_CATALOG / SECTION_GROUPS  — field metadata + group colors
 *   - buildStateFields / buildBlockFields — ordered field layout
 *   - PHASE_FIELDS — which fields each transition phase reads/writes
 *   - renderStateContainer / renderBlockContainer — draw the panels, push hit
 *     boxes onto scene.fieldHitBoxes, and overlay live values + phase highlight
 *   - renderFieldExplanation — the hovered field's tooltip (center column)
 *
 * The render functions read live data off the passed `scene` object
 * (currentState, blockData, attestations, scenario, hovered/selected field,
 * currentPhaseIndex, finalVerdict) so the same panels serve as both the live
 * pipeline state and the explorable anatomy.
 */
"use strict";

(function registerAnatomyData() {
  const { draw, colors } = P2P;

  /* ------------------------------------------------------------------ */
  /* Field / section metadata                                            */
  /* ------------------------------------------------------------------ */
  const FIELD_CATALOG = {
    config: {
      label: "config",
      sectionGroup: "config",
      fixedSize: true,
      category: "状態",
      explanation: "ネットワーク全体で共有される定数群（スロット時間、最大バリデータ数など）。ハードフォークで書き換えられる以外は不変。",
    },
    validators: {
      label: "validators[]",
      sectionGroup: "registry",
      fixedSize: false,
      category: "状態 › Validator Registry",
      explanation: "バリデータ登録簿（可変長リスト・containers/validator.py）。各 Validator は {attestation_public_key: Bytes52, proposal_public_key: Bytes52, index: uint64}。鍵は XMSS（ハッシュベース・耐量子）で BLS ではない。ステーク残高は持たず、投票はバリデータ数で等価に重み付けされる。",
    },
    chrono_slot: {
      label: "slot",
      sectionGroup: "chronology",
      fixedSize: true,
      category: "状態 › Chronology",
      explanation: "現在のスロット番号（Uint64）。Phase 1 の時刻同期でブロックのスロットまで進められる。",
    },
    chrono_latest_block_header: {
      label: "latest_block_header",
      sectionGroup: "chronology",
      fixedSize: true,
      category: "状態 › Chronology",
      explanation: "最後に処理したブロックのヘッダ。parent_root の検証でここのハッシュと照合する。",
    },
    chrono_latest_finalized: {
      label: "latest_finalized",
      sectionGroup: "chronology",
      fixedSize: true,
      category: "状態 › Chronology",
      explanation: "安全フロア。このチェックポイント以前のブロックは覆らない。3SF（3-slot finality）の確定性。",
    },
    chrono_latest_justified: {
      label: "latest_justified",
      sectionGroup: "chronology",
      fixedSize: true,
      category: "状態 › Chronology",
      explanation: "最新の正当化済みチェックポイント。次の finalized への踏み台。スーパーマジョリティで昇格。",
    },
    chrono_historical_block_hashes: {
      label: "historical_block_hashes",
      sectionGroup: "chronology",
      fixedSize: false,
      category: "状態 › Chronology",
      explanation: "空スロットを含む過去ブロックの root 一覧（可変長リスト）。Phase 1 で空スロットごとに追記される。",
    },
    chrono_justified_slots: {
      label: "justified_slots",
      sectionGroup: "chronology",
      fixedSize: false,
      category: "状態 › Chronology",
      explanation: "どのスロットが justified 済みかを記録するビットフィールド。finalization の連鎖判定に使う。",
    },
    voting_justification_roots: {
      label: "justifications_roots",
      sectionGroup: "voting",
      fixedSize: false,
      category: "状態 › Active Voting",
      explanation: "票を集めている候補ブロック root の一覧（containers/state.py の justifications_roots）。各 attestation の target がここに記録される。",
    },
    voting_validator_bitfields: {
      label: "justifications_validators",
      sectionGroup: "voting",
      fixedSize: false,
      category: "状態 › Active Voting",
      explanation: "候補 root × バリデータの投票ビットフィールド（justifications_validators）。1本の平坦な bitlist に連結され、誰がどの候補に投票したかを追跡して二重投票を防ぐ。",
    },
    header_slot: {
      label: "slot",
      sectionGroup: "header",
      fixedSize: true,
      size: "Uint64",
      category: "ブロック › Header",
      explanation: "このブロックが提案されるスロット番号。state.slot より大きい必要がある（Phase 2 検証）。",
    },
    header_proposer_index: {
      label: "proposer_index",
      sectionGroup: "header",
      fixedSize: true,
      size: "Uint64",
      category: "ブロック › Header",
      explanation: "提案者のバリデータインデックス。Phase 2 でランダム委員会選出の結果と照合される。",
    },
    header_parent_root: {
      label: "parent_root",
      sectionGroup: "header",
      fixedSize: true,
      size: "Bytes32",
      category: "ブロック › Header",
      explanation: "直前ブロックの SSZ ハッシュ。state.latest_block_header のハッシュと一致しないと却下。",
    },
    header_state_root: {
      label: "state_root",
      sectionGroup: "header",
      fixedSize: true,
      size: "Bytes32",
      category: "ブロック › Header",
      explanation: "提案者が申告する遷移後の状態ルート。Phase 4 で実際の HashTreeRoot と照合。嘘をつくと却下。",
    },
    header_body_root: {
      label: "body_root",
      sectionGroup: "header",
      fixedSize: true,
      size: "Bytes32",
      category: "ブロック › Header",
      explanation: "ボディのハッシュコミットメント。hash(body) の結果。ヘッダとボディの不正改ざんを防ぐ。",
    },
    body_attestations: {
      label: "attestations[]",
      sectionGroup: "body",
      fixedSize: false,
      category: "ブロック › Body",
      explanation: "集約された投票リスト（可変長）。各 attestation に source・target チェックポイントと署名集約が含まれる。",
    },
  };

  const SECTION_GROUPS = {
    config: { title: "Configuration", color: colors.textDim },
    chronology: { title: "Chronology", color: colors.accent },
    registry: { title: "Validator Registry", color: colors.nodeSource },
    voting: { title: "Active Voting", color: colors.ihave },
    header: { title: "Header (固定サイズ)", color: colors.graft },
    body: { title: "Body (可変サイズ)", color: colors.nodeHasMessage },
  };

  /* State field order mirrors containers/state.py:
   * config, slot, latest_block_header, latest_justified, latest_finalized,
   * historical_block_hashes, justified_slots, validators,
   * justifications_roots, justifications_validators. */
  function buildStateFields() {
    return [
      { key: "config", groupBoundary: "config" },
      { key: "chrono_slot", groupBoundary: "chronology" },
      { key: "chrono_latest_block_header" },
      { key: "chrono_latest_justified" },
      { key: "chrono_latest_finalized" },
      { key: "chrono_historical_block_hashes" },
      { key: "chrono_justified_slots" },
      { key: "validators", groupBoundary: "registry" },
      { key: "voting_justification_roots", groupBoundary: "voting" },
      { key: "voting_validator_bitfields" },
    ];
  }

  function buildBlockFields() {
    return [
      { key: "header_slot", groupBoundary: "header" },
      { key: "header_proposer_index" },
      { key: "header_parent_root" },
      { key: "header_state_root" },
      { key: "header_body_root" },
      { key: "body_attestations", groupBoundary: "body" },
    ];
  }

  /* Which state/block fields each phase (0..3) reads or writes. Drives the
   * amber "currently inspected" highlight, tying the dynamic pipeline to the
   * static anatomy. */
  const PHASE_FIELDS = [
    { state: ["chrono_slot", "chrono_historical_block_hashes"], block: [] },
    {
      state: ["chrono_latest_block_header"],
      block: ["header_slot", "header_proposer_index", "header_parent_root"],
    },
    {
      state: [
        "voting_justification_roots",
        "voting_validator_bitfields",
        "chrono_latest_justified",
        "chrono_justified_slots",
      ],
      block: ["body_attestations"],
    },
    { state: [], block: ["header_state_root"] },
  ];

  /* ------------------------------------------------------------------ */
  /* Live value formatters — overlay the running state onto the fields   */
  /* ------------------------------------------------------------------ */
  const TONE_COLORS = {
    changed: colors.nodeSource,
    invalid: colors.nodeTarget,
    normal: colors.text,
    dim: colors.textDim,
  };

  const STATE_LIVE = {
    chrono_slot: (sc) => ({
      text: `${sc.currentState.slot}`,
      tone: sc.currentState.slot !== sc.stateSnapshot.slot ? "changed" : "normal",
    }),
    chrono_latest_block_header: (sc) => ({ text: sc.currentState.latestBlockHashHex, tone: "normal" }),
    chrono_latest_finalized: (sc) => ({ text: `slot ${sc.currentState.latestFinalizedSlot}`, tone: "normal" }),
    chrono_latest_justified: (sc) => ({ text: `slot ${sc.currentState.latestJustifiedSlot}`, tone: "normal" }),
    validators: (sc) => ({ text: `[${sc.currentState.totalValidators}]`, tone: "dim" }),
    voting_justification_roots: (sc) =>
      sc.currentState.justifiedVotes > 0
        ? { text: `${sc.currentState.justifiedVotes} 票`, tone: "changed" }
        : null,
  };

  const BLOCK_LIVE = {
    header_slot: (sc) => ({ text: `${sc.blockData.slot}`, tone: "normal" }),
    header_proposer_index: (sc) => ({
      text: `${sc.blockData.proposerIndex}`,
      tone: sc.scenario.proposerValid ? "normal" : "invalid",
    }),
    header_parent_root: (sc) => ({
      text: sc.blockData.parentRoot,
      tone: sc.scenario.parentRootValid ? "normal" : "invalid",
    }),
    header_state_root: (sc) => ({
      text: sc.blockData.stateRoot,
      tone: sc.scenario.stateRootValid ? "normal" : "invalid",
    }),
    header_body_root: (sc) => ({ text: sc.blockData.bodyRoot, tone: "normal" }),
    body_attestations: (sc) => ({ text: `[${sc.attestations.length}]`, tone: "normal" }),
  };

  function liveValue(scene, side, key) {
    const map = side === "state" ? STATE_LIVE : BLOCK_LIVE;
    return map[key] ? map[key](scene) : null;
  }

  function isPhaseActive(scene, side, key) {
    if (scene.finalVerdict !== "pending") return false;
    const phase = PHASE_FIELDS[scene.currentPhaseIndex];
    return !!phase && phase[side].indexOf(key) !== -1;
  }

  /* ------------------------------------------------------------------ */
  /* Row + group rendering primitives                                    */
  /* ------------------------------------------------------------------ */
  function drawGroupHeader(ctx, group, fx, yc, fw, rowH) {
    draw.label(ctx, group.title, fx + 2, yc + 1, group.color, "bold 10px ui-monospace, monospace", "left");
    draw.line(ctx, fx + 2, yc + rowH / 2 - 1, fx + fw - 2, yc + rowH / 2 - 1, group.color + "44", 1, false);
  }

  function renderFieldRow(ctx, scene, side, key, fx, yc, fw, rowH) {
    const meta = FIELD_CATALOG[key];
    const highlighted = scene.hoveredFieldKey === key || scene.selectedFieldKey === key;
    const phaseActive = !highlighted && isPhaseActive(scene, side, key);

    scene.fieldHitBoxes.push({ key, x: fx, y: yc - rowH / 2, width: fw, height: rowH });

    if (highlighted || phaseActive) {
      ctx.save();
      draw.roundedRect(ctx, fx, yc - rowH / 2 + 1, fw, rowH - 2, 4);
      ctx.fillStyle = (highlighted ? colors.nodeActive : colors.nodeSource) + "26";
      ctx.fill();
      ctx.restore();
      if (phaseActive) {
        ctx.save();
        ctx.fillStyle = colors.nodeSource;
        ctx.fillRect(fx, yc - rowH / 2 + 2, 2.5, rowH - 4);
        ctx.restore();
      }
    }

    const indicator = meta.fixedSize ? "□" : "◇";
    draw.label(ctx, indicator, fx + 7, yc + 1, meta.fixedSize ? colors.nodeStroke : colors.ihave,
      "10px ui-monospace, monospace", "left");
    draw.label(ctx, meta.label, fx + 20, yc + 1, highlighted || phaseActive ? colors.text : colors.textDim,
      "10px ui-monospace, monospace", "left");

    const live = liveValue(scene, side, key);
    if (live) {
      draw.label(ctx, live.text, fx + fw - 6, yc + 1, TONE_COLORS[live.tone] || colors.text,
        "10px ui-monospace, monospace", "right");
    }
  }

  function renderAttestationRow(ctx, attestation, fx, yc, fw) {
    const color = attestation.status === "counted" ? colors.nodeHasMessage
      : attestation.status === "ignored" ? colors.nodeTarget
      : colors.textDim;
    const mark = attestation.status === "counted" ? "✓" : attestation.status === "ignored" ? "✗" : "·";
    draw.label(ctx, `att[${attestation.index}] src:${attestation.sourceSlot} → tgt:${attestation.targetSlot}`,
      fx + 22, yc + 1, color, "9px ui-monospace, monospace", "left");
    draw.label(ctx, `${attestation.voteCount}票 ${mark}`, fx + fw - 6, yc + 1, color,
      "9px ui-monospace, monospace", "right");
  }

  function panelFrame(ctx, x, y, w, h, title, titleColor) {
    ctx.save();
    draw.roundedRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = colors.panel;
    ctx.fill();
    ctx.strokeStyle = colors.nodeStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    draw.label(ctx, title, x + w / 2, y + 14, titleColor, "bold 11px ui-monospace, monospace");
  }

  /* ------------------------------------------------------------------ */
  /* Containers                                                          */
  /* ------------------------------------------------------------------ */
  function renderStateContainer(ctx, scene, x, y, w, h) {
    panelFrame(ctx, x, y, w, h, "状態コンテナ S_n", colors.accent);
    const fields = scene.stateFields;
    const groupCount = fields.filter((f) => f.groupBoundary).length;
    const rowH = Math.min(22, (h - 36) / (fields.length + groupCount));
    const fx = x + 10;
    const fw = w - 20;
    let curY = y + 30 + rowH / 2;
    let activeGroup = null;
    for (const entry of fields) {
      if (entry.groupBoundary && entry.groupBoundary !== activeGroup) {
        activeGroup = entry.groupBoundary;
        drawGroupHeader(ctx, SECTION_GROUPS[activeGroup], fx, curY, fw, rowH);
        curY += rowH;
      }
      renderFieldRow(ctx, scene, "state", entry.key, fx, curY, fw, rowH);
      curY += rowH;
    }
  }

  function renderBlockContainer(ctx, scene, x, y, w, h) {
    panelFrame(ctx, x, y, w, h, "ブロック B", colors.accent);
    const fields = scene.blockFields;
    const groupCount = fields.filter((f) => f.groupBoundary).length;
    const rowH = Math.min(22, (h - 52) / (fields.length + groupCount + scene.attestations.length));
    const fx = x + 10;
    const fw = w - 20;
    let curY = y + 30 + rowH / 2;
    let activeGroup = null;
    for (const entry of fields) {
      if (entry.groupBoundary && entry.groupBoundary !== activeGroup) {
        activeGroup = entry.groupBoundary;
        drawGroupHeader(ctx, SECTION_GROUPS[activeGroup], fx, curY, fw, rowH);
        curY += rowH;
      }
      renderFieldRow(ctx, scene, "block", entry.key, fx, curY, fw, rowH);
      curY += rowH;
      if (entry.key === "body_attestations") {
        for (const attestation of scene.attestations) {
          renderAttestationRow(ctx, attestation, fx, curY, fw);
          curY += rowH;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Hovered-field explanation (rendered into the center column)         */
  /* ------------------------------------------------------------------ */
  function drawWrappedText(ctx, text, startX, startY, maxLineWidth, lineHeight, maxLines, font) {
    ctx.save();
    ctx.fillStyle = colors.textDim;
    ctx.font = font;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let remaining = text;
    let lineY = startY;
    let lineCount = 0;
    while (remaining.length > 0 && lineCount < maxLines) {
      let fitLength = remaining.length;
      while (fitLength > 0 && ctx.measureText(remaining.substring(0, fitLength)).width > maxLineWidth) {
        fitLength--;
      }
      ctx.fillText(remaining.substring(0, fitLength), startX, lineY);
      remaining = remaining.substring(fitLength);
      lineY += lineHeight;
      lineCount++;
    }
    ctx.restore();
  }

  function renderFieldExplanation(ctx, scene, x, y, w, h) {
    const key = scene.hoveredFieldKey || scene.selectedFieldKey;
    const meta = FIELD_CATALOG[key];
    if (!meta) return;
    const group = SECTION_GROUPS[meta.sectionGroup];
    draw.label(ctx, meta.category, x + 12, y + 18, group ? group.color : colors.textDim,
      "bold 10px ui-monospace, monospace", "left");
    draw.label(ctx, meta.label, x + 12, y + 40, colors.text, "bold 14px ui-monospace, monospace", "left");
    const sizeLabel = meta.fixedSize ? "□ 固定サイズ" : "◇ 可変サイズ";
    draw.label(ctx, sizeLabel + (meta.size ? ` · ${meta.size}` : ""), x + w - 12, y + 40,
      meta.fixedSize ? colors.nodeStroke : colors.ihave, "10px ui-monospace, monospace", "right");
    draw.line(ctx, x + 12, y + 54, x + w - 12, y + 54, colors.grid, 1, false);
    drawWrappedText(ctx, meta.explanation, x + 12, y + 64, w - 24, 18, 8, "11px ui-monospace, monospace");
    draw.label(ctx, scene.selectedFieldKey ? "クリックで選択解除" : "クリックで固定", x + w / 2, y + h - 12,
      colors.textDim, "9px ui-monospace, monospace");
  }

  P2P.stateAnatomy = {
    FIELD_CATALOG,
    SECTION_GROUPS,
    buildStateFields,
    buildBlockFields,
    PHASE_FIELDS,
    renderStateContainer,
    renderBlockContainer,
    renderFieldExplanation,
  };
})();
