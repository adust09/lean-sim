/*
 * anatomy.js — Sections 4.1–4.2: Interactive state & block anatomy explorer.
 *
 * Shows a labeled diagram of:
 *   - The State Container with its 3 domain groups (Fig 4.1):
 *       Identity   — validator registry (pubkey, status, effective_balance)
 *       Chronology — slot, latest_block_header, checkpoints, history
 *       Active Voting — candidate roots, voter bitfields
 *   - The Block (Fig 4.2):
 *       Header (fixed) — 5 fields with sizes
 *       Body (variable) — list of Attestation[0..n]
 *   - Cryptographic commitment arrow: body → hash → body_root in header
 *   - state_root = HashTreeRoot(post-state) connection
 *
 * Hover/click a field or section to see its Japanese explanation.
 */
"use strict";

(function registerAnatomy() {
  const { draw, colors } = P2P;

  /* ------------------------------------------------------------------ */
  /* Field / section metadata                                            */
  /* ------------------------------------------------------------------ */
  const FIELD_CATALOG = {
    /* Config */
    config: {
      label: "config",
      sectionGroup: "config",
      fixedSize: true,
      category: "状態",
      explanation: "ネットワーク全体で共有される定数群（スロット時間、最大バリデータ数など）。ハードフォークで書き換えられる以外は不変。",
    },
    /* Identity */
    validator_pubkey: {
      label: "pubkey",
      sectionGroup: "identity",
      fixedSize: true,
      category: "状態 › Identity",
      explanation: "BLS12-381 公開鍵（48 bytes）。バリデータを一意に識別し、署名検証に使用する。",
    },
    validator_status: {
      label: "status",
      sectionGroup: "identity",
      fixedSize: true,
      category: "状態 › Identity",
      explanation: "Active / Exited / Slashed の3状態。ステータスによって投票権・引き出し条件が変わる。",
    },
    validator_effective_balance: {
      label: "effective_balance",
      sectionGroup: "identity",
      fixedSize: true,
      category: "状態 › Identity",
      explanation: "投票重み（ETH 単位）。スラッシングや引き出しで減少する。スーパーマジョリティの計算に使う。",
    },
    /* Chronology */
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
      explanation: "安全フロア。このチェックポイント以前のブロックは覆らない。Casper FFG の確定性。",
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
    /* Active Voting */
    voting_justification_roots: {
      label: "justification_roots",
      sectionGroup: "voting",
      fixedSize: false,
      category: "状態 › Active Voting",
      explanation: "票を集めている候補ブロック root の一覧。各 attestation の target がここに記録される。",
    },
    voting_validator_bitfields: {
      label: "validator_bitfields",
      sectionGroup: "voting",
      fixedSize: false,
      category: "状態 › Active Voting",
      explanation: "候補ごとの投票者ビットフィールド。誰が誰に投票したかを追跡し、二重投票を防ぐ。",
    },
    /* Header fields */
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
    /* Body fields */
    body_attestations: {
      label: "attestations[]",
      sectionGroup: "body",
      fixedSize: false,
      category: "ブロック › Body",
      explanation: "集約された投票リスト（可変長）。各 attestation に source・target チェックポイントと署名集約が含まれる。",
    },
  };

  /* Group-level metadata for colored section headers */
  const SECTION_GROUPS = {
    config: {
      title: "Configuration",
      color: colors.textDim,
      stateSection: true,
    },
    identity: {
      title: "Identity (Validator Registry)",
      color: colors.nodeSource,
      stateSection: true,
    },
    chronology: {
      title: "Chronology",
      color: colors.accent,
      stateSection: true,
    },
    voting: {
      title: "Active Voting",
      color: colors.ihave,
      stateSection: true,
    },
    header: {
      title: "Header (固定サイズ)",
      color: colors.graft,
      stateSection: false,
    },
    body: {
      title: "Body (可変サイズ)",
      color: colors.nodeHasMessage,
      stateSection: false,
    },
  };

  /* ------------------------------------------------------------------ */
  /* Layout helpers                                                      */
  /* ------------------------------------------------------------------ */
  function buildStateFields() {
    return [
      { key: "config",                         groupBoundary: "config" },
      { key: "validator_pubkey",               groupBoundary: "identity" },
      { key: "validator_status" },
      { key: "validator_effective_balance" },
      { key: "chrono_slot",                    groupBoundary: "chronology" },
      { key: "chrono_latest_block_header" },
      { key: "chrono_latest_finalized" },
      { key: "chrono_latest_justified" },
      { key: "chrono_historical_block_hashes" },
      { key: "chrono_justified_slots" },
      { key: "voting_justification_roots",     groupBoundary: "voting" },
      { key: "voting_validator_bitfields" },
    ];
  }

  function buildBlockFields() {
    return [
      { key: "header_slot",           groupBoundary: "header" },
      { key: "header_proposer_index" },
      { key: "header_parent_root" },
      { key: "header_state_root" },
      { key: "header_body_root" },
      { key: "body_attestations",     groupBoundary: "body" },
    ];
  }

  /* ------------------------------------------------------------------ */
  /* Scene                                                               */
  /* ------------------------------------------------------------------ */
  const scene = {
    id: "anatomy",
    title: "状態 & ブロック解剖",
    sectionRef: "4.1",
    descriptionHTML: `
      <p><b>状態 S (Fig 4.1)</b> は3ドメインに分かれます。<b>Identity</b>（バリデータ台帳：公開鍵・
      ステータス・有効残高）、<b>Chronology</b>（時刻・最新ヘッダ・justified/finalized チェック
      ポイント・履歴）、<b>Active Voting</b>（投票候補 root とビットフィールド）。</p>
      <p><b>ブロック B (Fig 4.2)</b> は固定サイズの<b>Header</b>（5フィールド、各 Uint64 か Bytes32）
      と可変サイズの<b>Body</b>（attestation リスト）で構成されます。</p>
      <p><b>body_root</b> はヘッダに含まれる暗号コミットメント：<code>body_root = hash(body)</code>。
      ヘッダを変えずにボディを改ざんすることも、ボディを変えずにヘッダを改ざんすることも不可能です。</p>
      <p><b>state_root</b> は Phase 4 で検証されます：<code>HashTreeRoot(S_{n+1})</code> がヘッダの
      申告値と一致しなければブロックは却下されます。</p>
      <p><b>操作:</b> フィールドや区画にホバーまたはクリックすると役割の説明が右側に表示されます。
      固定サイズ（□）と可変サイズ（◇）の違いにも注目してください。</p>`,

    /* ---------------------------------------------------------------- */
    /* Runtime state                                                     */
    /* ---------------------------------------------------------------- */
    width: 0,
    height: 0,
    selectedFieldKey: null,
    hoveredFieldKey: null,
    tooltipAlpha: 0,
    stateFields: [],
    blockFields: [],
    fieldHitBoxes: [],   // Array of {key, x, y, width, height}

    /* ---------------------------------------------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.stateFields = buildStateFields();
      this.blockFields = buildBlockFields();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* ---------------------------------------------------------------- */
    /* Update                                                            */
    /* ---------------------------------------------------------------- */
    update(realDt) {
      const targetAlpha = (this.hoveredFieldKey || this.selectedFieldKey) ? 1 : 0;
      this.tooltipAlpha = P2P.util.lerp(this.tooltipAlpha, targetAlpha, Math.min(1, realDt * 8));
    },

    /* ---------------------------------------------------------------- */
    /* Render                                                            */
    /* ---------------------------------------------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.fieldHitBoxes = [];

      const useWideLayout = this.width >= 900;
      if (useWideLayout) {
        this.renderWideLayout(ctx);
      } else {
        this.renderNarrowLayout(ctx);
      }

      this.renderTooltipPanel(ctx);
    },

    renderWideLayout(ctx) {
      /* Title row */
      draw.label(ctx, "状態コンテナ S", this.width * 0.22, 22,
        colors.text, "bold 13px ui-monospace, monospace");
      draw.label(ctx, "ブロック B", this.width * 0.62, 22,
        colors.text, "bold 13px ui-monospace, monospace");

      const statePanelX = 16;
      const statePanelWidth = Math.floor(this.width * 0.42);
      const blockPanelX = statePanelX + statePanelWidth + 24;
      const blockPanelWidth = Math.floor(this.width * 0.34);

      this.renderStateContainer(ctx, statePanelX, 38, statePanelWidth, this.height - 56);
      this.renderBlockContainer(ctx, blockPanelX, 38, blockPanelWidth, this.height - 56);
    },

    renderNarrowLayout(ctx) {
      const panelWidth = this.width - 32;
      const halfHeight = Math.floor(this.height / 2) - 24;
      draw.label(ctx, "状態コンテナ S", this.width / 2, 18,
        colors.text, "bold 13px ui-monospace, monospace");
      this.renderStateContainer(ctx, 16, 30, panelWidth, halfHeight);

      draw.label(ctx, "ブロック B", this.width / 2, halfHeight + 38,
        colors.text, "bold 13px ui-monospace, monospace");
      this.renderBlockContainer(ctx, 16, halfHeight + 50, panelWidth, halfHeight);
    },

    /* State container (3 domain groups stacked) */
    renderStateContainer(ctx, containerX, containerY, containerWidth, containerHeight) {
      ctx.save();
      draw.roundedRect(ctx, containerX, containerY, containerWidth, containerHeight, 10);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.nodeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      const rowHeight = 22;
      const domainPadding = 10;
      const fieldX = containerX + 12;
      const fieldWidth = containerWidth - 24;

      let currentGroupBoundary = null;
      let groupStartY = containerY + 8;
      let currentFieldY = containerY + 10;

      const groups = {};
      for (const fieldEntry of this.stateFields) {
        if (!groups[fieldEntry.groupBoundary || currentGroupBoundary]) {
          if (fieldEntry.groupBoundary) currentGroupBoundary = fieldEntry.groupBoundary;
        }
        const groupKey = fieldEntry.groupBoundary || currentGroupBoundary;
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(fieldEntry.key);
      }

      let fieldIndex = 0;
      let activeGroupKey = null;

      for (const fieldEntry of this.stateFields) {
        if (fieldEntry.groupBoundary && fieldEntry.groupBoundary !== activeGroupKey) {
          /* Close previous group box */
          if (activeGroupKey !== null) {
            const groupEndY = currentFieldY;
            ctx.save();
            draw.roundedRect(ctx, fieldX - 4, groupStartY, fieldWidth + 8, groupEndY - groupStartY + 4, 6);
            ctx.strokeStyle = SECTION_GROUPS[activeGroupKey].color + "66";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
          }
          activeGroupKey = fieldEntry.groupBoundary;
          groupStartY = currentFieldY;
          const groupMeta = SECTION_GROUPS[activeGroupKey];
          draw.label(ctx, groupMeta.title, fieldX, currentFieldY + 8,
            groupMeta.color, "bold 10px ui-monospace, monospace", "left");
          currentFieldY += rowHeight;
        }

        const fieldMeta = FIELD_CATALOG[fieldEntry.key];
        const isHovered = this.hoveredFieldKey === fieldEntry.key;
        const isSelected = this.selectedFieldKey === fieldEntry.key;
        const isHighlighted = isHovered || isSelected;

        const fieldY = currentFieldY;
        const hitBox = { key: fieldEntry.key, x: fieldX, y: fieldY - 8, width: fieldWidth, height: rowHeight };
        this.fieldHitBoxes.push(hitBox);

        if (isHighlighted) {
          ctx.save();
          draw.roundedRect(ctx, fieldX, fieldY - 8, fieldWidth, rowHeight, 4);
          ctx.fillStyle = colors.nodeActive + "22";
          ctx.fill();
          ctx.restore();
        }

        /* Size indicator: □ = fixed, ◇ = variable */
        const sizeIndicator = fieldMeta.fixedSize ? "□" : "◇";
        const sizeColor = fieldMeta.fixedSize ? colors.nodeStroke : colors.ihave;
        draw.label(ctx, sizeIndicator, fieldX + 6, fieldY + 2, sizeColor,
          "10px ui-monospace, monospace", "left");

        draw.label(ctx, fieldMeta.label, fieldX + 18, fieldY + 2,
          isHighlighted ? colors.text : colors.textDim, "10px ui-monospace, monospace", "left");

        fieldIndex++;
        currentFieldY += rowHeight;
      }

      /* Close last group box */
      if (activeGroupKey !== null) {
        ctx.save();
        draw.roundedRect(ctx, fieldX - 4, groupStartY, fieldWidth + 8, currentFieldY - groupStartY + 4, 6);
        ctx.strokeStyle = SECTION_GROUPS[activeGroupKey].color + "66";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    },

    /* Block container (header + body) */
    renderBlockContainer(ctx, containerX, containerY, containerWidth, containerHeight) {
      ctx.save();
      draw.roundedRect(ctx, containerX, containerY, containerWidth, containerHeight, 10);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.nodeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      const rowHeight = 22;
      const fieldX = containerX + 12;
      const fieldWidth = containerWidth - 24;

      let currentGroupKey = null;
      let groupStartY = containerY + 8;
      let currentFieldY = containerY + 10;

      for (const fieldEntry of this.blockFields) {
        if (fieldEntry.groupBoundary && fieldEntry.groupBoundary !== currentGroupKey) {
          if (currentGroupKey !== null) {
            const groupEndY = currentFieldY;
            ctx.save();
            draw.roundedRect(ctx, fieldX - 4, groupStartY, fieldWidth + 8, groupEndY - groupStartY + 4, 6);
            ctx.strokeStyle = SECTION_GROUPS[currentGroupKey].color + "66";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();

            /* body_root → hash arrow: from body group top-right to header_body_root */
            if (currentGroupKey === "body") {
              const arrowStartX = fieldX + fieldWidth - 4;
              const arrowStartY = groupStartY + 12;
              /* Find header_body_root position — it's always the 5th header field */
              const headerBodyRootY = containerY + 10 + 22 * 4 + rowHeight + 11;
              draw.arrow(ctx, arrowStartX, arrowStartY,
                arrowStartX + 10, headerBodyRootY, colors.nodeHasMessage, 1.4);
              draw.label(ctx, "hash(body)", arrowStartX + 16, (arrowStartY + headerBodyRootY) / 2,
                colors.nodeHasMessage, "9px ui-monospace, monospace", "left");
            }
          }
          currentGroupKey = fieldEntry.groupBoundary;
          groupStartY = currentFieldY;
          const groupMeta = SECTION_GROUPS[currentGroupKey];
          draw.label(ctx, groupMeta.title, fieldX, currentFieldY + 8,
            groupMeta.color, "bold 10px ui-monospace, monospace", "left");
          currentFieldY += rowHeight;
        }

        const fieldMeta = FIELD_CATALOG[fieldEntry.key];
        const isHovered = this.hoveredFieldKey === fieldEntry.key;
        const isSelected = this.selectedFieldKey === fieldEntry.key;
        const isHighlighted = isHovered || isSelected;

        const fieldY = currentFieldY;
        const hitBox = { key: fieldEntry.key, x: fieldX, y: fieldY - 8, width: fieldWidth, height: rowHeight };
        this.fieldHitBoxes.push(hitBox);

        if (isHighlighted) {
          ctx.save();
          draw.roundedRect(ctx, fieldX, fieldY - 8, fieldWidth, rowHeight, 4);
          ctx.fillStyle = colors.nodeActive + "22";
          ctx.fill();
          ctx.restore();
        }

        const sizeIndicator = fieldMeta.fixedSize ? "□" : "◇";
        const sizeColor = fieldMeta.fixedSize ? colors.nodeStroke : colors.ihave;
        draw.label(ctx, sizeIndicator, fieldX + 6, fieldY + 2, sizeColor,
          "10px ui-monospace, monospace", "left");

        const sizeAnnotation = fieldMeta.size ? ` (${fieldMeta.size})` : "";
        draw.label(ctx, fieldMeta.label + sizeAnnotation, fieldX + 18, fieldY + 2,
          isHighlighted ? colors.text : colors.textDim, "10px ui-monospace, monospace", "left");

        currentFieldY += rowHeight;
      }

      /* Close last group box */
      if (currentGroupKey !== null) {
        ctx.save();
        draw.roundedRect(ctx, fieldX - 4, groupStartY, fieldWidth + 8, currentFieldY - groupStartY + 4, 6);
        ctx.strokeStyle = SECTION_GROUPS[currentGroupKey].color + "66";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      /* state_root annotation at bottom */
      const noteY = containerY + containerHeight - 18;
      draw.label(ctx, "state_root = HashTreeRoot(S_{n+1})  [Phase 4 で検証]",
        containerX + containerWidth / 2, noteY, colors.nodeSource,
        "9px ui-monospace, monospace");
    },

    /* Tooltip / explanation panel */
    renderTooltipPanel(ctx) {
      if (this.tooltipAlpha < 0.02) return;

      const activeKey = this.hoveredFieldKey || this.selectedFieldKey;
      if (!activeKey) return;

      const fieldMeta = FIELD_CATALOG[activeKey];
      if (!fieldMeta) return;

      const useWideLayout = this.width >= 900;
      const tooltipX = useWideLayout ? Math.floor(this.width * 0.78) : 16;
      const tooltipY = useWideLayout ? this.height - 160 : this.height - 140;
      const tooltipWidth = useWideLayout ? this.width - tooltipX - 16 : this.width - 32;
      const tooltipHeight = useWideLayout ? 140 : 130;

      ctx.save();
      ctx.globalAlpha = this.tooltipAlpha;
      draw.roundedRect(ctx, tooltipX, tooltipY, tooltipWidth, tooltipHeight, 10);
      ctx.fillStyle = "#0a1525ee";
      ctx.fill();
      ctx.strokeStyle = colors.nodeActive;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = this.tooltipAlpha;

      const groupMeta = SECTION_GROUPS[fieldMeta.sectionGroup];
      draw.label(ctx, fieldMeta.category, tooltipX + 12, tooltipY + 14,
        groupMeta ? groupMeta.color : colors.textDim, "bold 10px ui-monospace, monospace", "left");

      draw.label(ctx, fieldMeta.label, tooltipX + 12, tooltipY + 30,
        colors.text, "bold 13px ui-monospace, monospace", "left");

      const sizeLabel = fieldMeta.fixedSize ? "□ 固定サイズ" : "◇ 可変サイズ";
      const sizeColor = fieldMeta.fixedSize ? colors.nodeStroke : colors.ihave;
      draw.label(ctx, sizeLabel, tooltipX + tooltipWidth - 12, tooltipY + 30,
        sizeColor, "10px ui-monospace, monospace", "right");

      /* Word-wrap explanation text */
      const maxLineWidth = tooltipWidth - 24;
      this.drawWrappedText(ctx, fieldMeta.explanation,
        tooltipX + 12, tooltipY + 50, maxLineWidth, 16, colors.textDim,
        "11px ui-monospace, monospace");

      ctx.restore();
    },

    /* Simple word-wrap renderer — splits Japanese text greedily to fit maxLineWidth */
    drawWrappedText(ctx, text, startX, startY, maxLineWidth, lineHeight, textColor, font) {
      ctx.save();
      ctx.fillStyle = textColor;
      ctx.font = font;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      const maxLines = 4;
      let lineCount = 0;
      let remaining = text;
      let lineY = startY;

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
    },

    /* ---------------------------------------------------------------- */
    /* Mouse handling                                                    */
    /* ---------------------------------------------------------------- */
    onMouse(type, mouseX, mouseY) {
      let foundKey = null;
      for (const hitBox of this.fieldHitBoxes) {
        if (mouseX >= hitBox.x && mouseX <= hitBox.x + hitBox.width &&
          mouseY >= hitBox.y && mouseY <= hitBox.y + hitBox.height) {
          foundKey = hitBox.key;
          break;
        }
      }

      if (type === "move") {
        this.hoveredFieldKey = foundKey;
      } else if (type === "click") {
        this.selectedFieldKey = foundKey === this.selectedFieldKey ? null : foundKey;
      }
    },

    /* ---------------------------------------------------------------- */
    /* Stats                                                             */
    /* ---------------------------------------------------------------- */
    getStats() {
      const activeKey = this.hoveredFieldKey || this.selectedFieldKey;
      if (!activeKey) {
        return [
          { label: "選択フィールド", value: "— (ホバーで選択)" },
          { label: "役割", value: "—" },
          { label: "サイズ", value: "—" },
          { label: "区分", value: "—" },
        ];
      }
      const fieldMeta = FIELD_CATALOG[activeKey];
      return [
        { label: "選択フィールド", value: fieldMeta.label },
        { label: "役割", value: fieldMeta.explanation.substring(0, 40) + "…" },
        { label: "サイズ", value: fieldMeta.fixedSize ? "固定" : "可変" },
        { label: "区分", value: fieldMeta.category },
      ];
    },

    /* ---------------------------------------------------------------- */
    /* Controls                                                          */
    /* ---------------------------------------------------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const sceneRef = this;

      const infoGroup = ui.group("操作ガイド");
      const infoText = document.createElement("div");
      infoText.style.cssText = "color:#8da2bd;font-size:11px;line-height:1.5;padding:4px 0;";
      infoText.textContent = "フィールドにホバーで説明表示。クリックで固定表示。もう一度クリックで解除。";
      infoGroup.appendChild(infoText);
      container.appendChild(infoGroup);

      const legendGroup = ui.group("凡例");
      const legendText = document.createElement("div");
      legendText.style.cssText = "color:#8da2bd;font-size:11px;line-height:1.8;padding:4px 0;";
      legendText.innerHTML = `
        <span style="color:#5a7299">□</span> 固定サイズフィールド<br>
        <span style="color:#a78bfa">◇</span> 可変サイズフィールド<br>
        <span style="color:#fbbf24">■</span> Identity ドメイン<br>
        <span style="color:#60a5fa">■</span> Chronology ドメイン<br>
        <span style="color:#a78bfa">■</span> Active Voting ドメイン
      `;
      legendGroup.appendChild(legendText);
      container.appendChild(legendGroup);

      const clearButton = ui.button("選択をクリア", () => {
        sceneRef.selectedFieldKey = null;
        sceneRef.hoveredFieldKey = null;
      });
      container.appendChild(clearButton);
    },
  };

  P2P.scenes.anatomy = scene;
})();
