/*
 * pipeline.js — Sections 4.1–4.3: State transition over the full anatomy.
 *
 * Integrates the former "anatomy" explorer (§4.1–4.2) into the 4-phase
 * transition pipeline (§4.3): the State container and the Block are drawn as
 * their full field structure (the anatomy), and the pipeline animates a block
 * being validated through the 4 phases on top of it.
 *
 *   Phase 1: Time Synchronization — advance state slot to match block slot
 *   Phase 2: Header Validation — proposer / parent_root / slot checks
 *   Phase 3: Consensus Execution — attestation voting, weighting, justify
 *   Phase 4: Integrity Verification — HashTreeRoot vs block.header.state_root
 *
 * Each phase highlights the fields it reads/writes (amber). Hover/click any
 * field to read its role in the center panel; with nothing hovered the center
 * shows the live step-by-step execution log.
 */
"use strict";

(function registerPipeline() {
  const { util, draw, colors } = P2P;

  const SCENARIOS = {
    normal: {
      label: "正常",
      proposerValid: true,
      parentRootValid: true,
      stateRootValid: true,
      invalidAttestationCount: 0,
    },
    badProposer: {
      label: "不正な proposer",
      proposerValid: false,
      parentRootValid: true,
      stateRootValid: true,
      invalidAttestationCount: 0,
    },
    badParentRoot: {
      label: "parent_root 不一致",
      proposerValid: true,
      parentRootValid: false,
      stateRootValid: true,
      invalidAttestationCount: 0,
    },
    badStateRoot: {
      label: "state_root 不一致",
      proposerValid: true,
      parentRootValid: true,
      stateRootValid: false,
      invalidAttestationCount: 0,
    },
    invalidVotes: {
      label: "一部の票が無効 (source 未 justified)",
      proposerValid: true,
      parentRootValid: true,
      stateRootValid: true,
      invalidAttestationCount: 2,
    },
  };

  const PHASE_LABELS = [
    { number: 1, title: "時刻同期", sectionRef: "§4.3.1" },
    { number: 2, title: "ヘッダ検証", sectionRef: "§4.3.2" },
    { number: 3, title: "ペイロード実行", sectionRef: "§4.3.3" },
    { number: 4, title: "state root 検証", sectionRef: "§4.3.4" },
  ];

  const TICK_DURATION = 0.6; // seconds per animation step
  const END_HOLD_DURATION = 2.0; // seconds to hold the verdict before looping

  const scene = {
    id: "pipeline",
    title: "状態遷移パイプライン",
    sectionRef: "4.1–4.3",
    descriptionHTML: `
      <p><b>状態遷移関数 S<sub>n+1</sub> = Υ(S<sub>n</sub>, B)</b> を、状態とブロックの
      <b>完全な構造（解剖）</b>の上で実行する統合ビューです。上部が各フェーズの処理（実行ログ）、
      下部が状態コンテナ（左）とブロック（右）。各フェーズは自分が読み書きするフィールドを
      <b>橙色でハイライト</b>します。</p>
      <p><b>① 時刻同期 (§4.3.1):</b> state.slot をブロックのスロットまで進める
      （chrono.slot / historical_block_hashes を更新）。</p>
      <p><b>② ヘッダ検証 (§4.3.2):</b> proposer_index・parent_root（state の
      latest_block_header と照合）・slot の3検査。いずれか失敗で即却下。</p>
      <p><b>③ ペイロード実行 (§4.3.3):</b> body.attestations を順に処理。source が
      justified 済みなら票を計上、2/3 超（3·票 ≥ 2·N、重みはバリデータ数で等価）で
      target を justified に昇格。無効票はソフトフェイル（スキップ）。</p>
      <p><b>④ integrity 検証 (§4.3.4):</b> HashTreeRoot(S<sub>n+1</sub>) と
      block.header.state_root を照合。一致で受理、嘘なら却下。</p>
      <p><b>操作:</b> フィールドに<b>ホバー/クリック</b>すると役割の解説が中央に出ます
      （□=固定サイズ / ◇=可変サイズ）。「次のフェーズ ▶」「自動再生」で実行、
      「シナリオ」で故障注入を切り替え。</p>`,

    width: 0,
    height: 0,
    clock: 0,
    speed: 1,
    autoPlay: true,
    endHoldClock: 0,
    emptySlotCount: 2,
    scenarioKey: "normal",

    /* Derived scenario state — rebuilt by build() */
    scenario: null,
    stateSnapshot: null,
    currentState: null,
    blockData: null,
    attestations: [],
    phaseSteps: [],
    animationClock: 0,
    currentPhaseIndex: 0,
    currentStepIndex: 0,
    phaseResults: [],
    finalVerdict: "pending",

    /* Anatomy field structure + interaction */
    stateFields: [],
    blockFields: [],
    fieldHitBoxes: [],
    hoveredFieldKey: null,
    selectedFieldKey: null,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.stateFields = P2P.stateAnatomy.buildStateFields();
      this.blockFields = P2P.stateAnatomy.buildBlockFields();
      this.build();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* Scenario construction                                             */
    build() {
      this.clock = 0;
      this.animationClock = 0;
      this.endHoldClock = 0;
      this.currentPhaseIndex = 0;
      this.currentStepIndex = 0;
      this.phaseResults = ["pending", "pending", "pending", "pending"];
      this.finalVerdict = "pending";
      this.scenario = SCENARIOS[this.scenarioKey];

      const stateSlot = 10;
      const totalValidators = 32;
      this.stateSnapshot = {
        slot: stateSlot,
        latestBlockHashHex: "0xa1b2",
        latestJustifiedSlot: 8,
        latestFinalizedSlot: 6,
        totalValidators,
        justifiedVotes: 0,
      };
      this.currentState = { ...this.stateSnapshot };

      const blockSlot = stateSlot + this.emptySlotCount;
      // Proposer is deterministic: block.slot % num_validators (state_transition.py).
      const correctProposerIndex = blockSlot % totalValidators;
      const correctParentRoot = "0xa1b2";
      const correctStateRoot = "0xc3d4";

      this.blockData = {
        slot: blockSlot,
        proposerIndex: this.scenario.proposerValid ? correctProposerIndex : 99,
        parentRoot: this.scenario.parentRootValid ? correctParentRoot : "0xdead",
        stateRoot: this.scenario.stateRootValid ? correctStateRoot : "0xffff",
        bodyRoot: "0xe5f6",
        correctProposerIndex,
        correctParentRoot,
        correctStateRoot,
      };

      // Each aggregated attestation covers a disjoint set of validators voting
      // for the target; 4 aggregates x 8 = the full 32-validator registry.
      const perAttestationVotes = 8;
      const totalAttestationCount = 4;
      this.attestations = [];
      for (let attestationIndex = 0; attestationIndex < totalAttestationCount; attestationIndex++) {
        const isInvalid = attestationIndex < this.scenario.invalidAttestationCount;
        this.attestations.push({
          index: attestationIndex,
          sourceSlot: isInvalid ? 3 : 8,
          targetSlot: blockSlot,
          voteCount: perAttestationVotes,
          sourceJustified: !isInvalid,
          status: "pending",
        });
      }
      this.phaseSteps = this.buildPhaseSteps();
    },

    buildPhaseSteps() {
      const { emptySlotCount, stateSnapshot, blockData, attestations } = this;
      const totalValidators = stateSnapshot.totalValidators;
      const superMajorityThreshold = Math.ceil((totalValidators * 2) / 3);

      return [
        ...Array.from({ length: emptySlotCount }, (_, slotOffset) => ({
          phase: 0,
          kind: "slot-advance",
          slotNumber: stateSnapshot.slot + slotOffset + 1,
          description: `空スロット ${stateSnapshot.slot + slotOffset + 1}: state root を凍結 → slot++`,
        })),
        {
          phase: 0,
          kind: "phase-result",
          result: "pass",
          description: `時刻同期完了: state.slot = ${blockData.slot}`,
        },
        {
          phase: 1,
          kind: "header-check",
          passed: this.scenario.proposerValid,
          description: this.scenario.proposerValid
            ? `proposer_index ${blockData.proposerIndex} == block.slot % N (${blockData.correctProposerIndex}) ✓`
            : `proposer_index ${blockData.proposerIndex} ≠ block.slot % N (${blockData.correctProposerIndex}) ✗ → 却下`,
        },
        {
          phase: 1,
          kind: "header-check",
          passed: this.scenario.parentRootValid,
          description: this.scenario.parentRootValid
            ? `block.parent_root ${blockData.parentRoot} == state.latestBlockHash ${blockData.correctParentRoot} ✓`
            : `block.parent_root ${blockData.parentRoot} ≠ state.latestBlockHash ${blockData.correctParentRoot} ✗ → 却下`,
        },
        {
          phase: 1,
          kind: "header-check",
          passed: true,
          description: `block.slot ${blockData.slot} > parent.slot (${stateSnapshot.slot}) ✓`,
        },
        {
          phase: 1,
          kind: "phase-result",
          result: this.scenario.proposerValid && this.scenario.parentRootValid ? "pass" : "fail",
          description: this.scenario.proposerValid && this.scenario.parentRootValid
            ? "ヘッダ検証 OK"
            : "ヘッダ検証 失敗 — ブロック却下",
        },
        ...attestations.map((attestation, attestationIndex) => ({
          phase: 2,
          kind: "attestation",
          attestationIndex,
          description: attestation.sourceJustified
            ? `attestation[${attestationIndex}]: source slot ${attestation.sourceSlot} は justified ✓ → +${attestation.voteCount} 票`
            : `attestation[${attestationIndex}]: source slot ${attestation.sourceSlot} は未 justified ✗ → スキップ(ソフトフェイル)`,
        })),
        {
          phase: 2,
          kind: "phase-result",
          result: "pass",
          description: (() => {
            const validVotes = attestations
              .filter((a) => a.sourceJustified)
              .reduce((sum, a) => sum + a.voteCount, 0);
            const ratio = ((validVotes / totalValidators) * 100).toFixed(1);
            const justified = 3 * validVotes >= 2 * totalValidators;
            return `有効投票 ${validVotes} / ${totalValidators} validators (${ratio}%) — ` +
              (justified ? `2/3 超 → justified ✓` : `2/3 未満 — 正当化なし`);
          })(),
        },
        {
          phase: 3,
          kind: "state-root-check",
          passed: this.scenario.stateRootValid,
          description: this.scenario.stateRootValid
            ? `HashTreeRoot(S_{n+1}) = ${blockData.correctStateRoot} == block.header.state_root ✓`
            : `HashTreeRoot(S_{n+1}) = ${blockData.correctStateRoot} ≠ block.header.state_root ${blockData.stateRoot} ✗ → 却下`,
        },
        {
          phase: 3,
          kind: "phase-result",
          result: this.scenario.stateRootValid ? "pass" : "fail",
          description: this.scenario.stateRootValid ? "ブロック受理 ✓" : "ブロック却下 ✗",
        },
      ];
    },

    /* Step advancement                                                  */
    advanceStep() {
      if (this.finalVerdict !== "pending") return;
      const steps = this.phaseSteps;
      if (this.currentStepIndex >= steps.length) return;

      this.applyStep(steps[this.currentStepIndex]);
      this.currentStepIndex++;

      if (this.currentStepIndex < steps.length) {
        const nextStep = steps[this.currentStepIndex];
        if (nextStep.phase > this.currentPhaseIndex) this.currentPhaseIndex = nextStep.phase;
      }
    },

    applyStep(step) {
      if (step.kind === "slot-advance") {
        this.currentState = { ...this.currentState, slot: step.slotNumber };
      } else if (step.kind === "phase-result") {
        const phaseIndex = step.phase;
        this.phaseResults[phaseIndex] = step.result;
        if (step.result === "fail") {
          this.finalVerdict = "reject";
          for (let index = phaseIndex + 1; index < 4; index++) this.phaseResults[index] = "skipped";
          this.currentStepIndex = this.phaseSteps.length;
        } else if (phaseIndex === 3 && step.result === "pass") {
          this.finalVerdict = "accept";
        }
      } else if (step.kind === "attestation") {
        const attestation = this.attestations[step.attestationIndex];
        if (attestation.sourceJustified) {
          attestation.status = "counted";
          const previousVotes = this.currentState.justifiedVotes || 0;
          this.currentState = {
            ...this.currentState,
            justifiedVotes: previousVotes + attestation.voteCount,
          };
        } else {
          attestation.status = "ignored";
        }
      }
    },

    /* Update loop                                                       */
    update(realDt) {
      const cappedDt = Math.min(0.05, realDt);
      if (!this.autoPlay) return;

      const isFinished =
        this.finalVerdict !== "pending" && this.currentStepIndex >= this.phaseSteps.length;
      if (isFinished) {
        this.endHoldClock += cappedDt * this.speed;
        if (this.endHoldClock >= END_HOLD_DURATION) this.build();
        return;
      }

      this.animationClock += cappedDt * this.speed;
      const stepDuration = TICK_DURATION / this.speed;
      if (this.animationClock >= stepDuration) {
        this.animationClock -= stepDuration;
        this.advanceStep();
      }
    },

    /* Rendering                                                         */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.fieldHitBoxes = [];
      const layout = this.computeLayout();
      this.renderPhaseTracker(ctx);
      this.renderTopPanel(ctx, layout);
      P2P.stateAnatomy.renderStateContainer(
        ctx, this, layout.stateColumnX, layout.bottomY, layout.stateColumnWidth, layout.bottomHeight);
      P2P.stateAnatomy.renderBlockContainer(
        ctx, this, layout.blockColumnX, layout.bottomY, layout.blockColumnWidth, layout.bottomHeight);
    },

    /*
     * Vertical split: phase processing on top (tracker + execution log over the
     * full width), the state container and block side-by-side underneath.
     */
    computeLayout() {
      const outerMargin = 16;
      const columnGap = 14;
      const topPanelY = 50;
      const topPanelHeight = Math.max(150, Math.min(204, Math.floor(this.height * 0.30)));
      const bottomY = topPanelY + topPanelHeight + 12;
      const bottomHeight = Math.max(200, this.height - bottomY - 16);

      const usableWidth = this.width - outerMargin * 2;
      const stateColumnWidth = Math.floor((usableWidth - columnGap) * 0.52);
      const blockColumnWidth = usableWidth - columnGap - stateColumnWidth;

      return {
        topPanelX: outerMargin,
        topPanelY,
        topPanelWidth: usableWidth,
        topPanelHeight,
        bottomY,
        bottomHeight,
        stateColumnX: outerMargin,
        stateColumnWidth,
        blockColumnX: outerMargin + stateColumnWidth + columnGap,
        blockColumnWidth,
      };
    },

    /* Phase tracker bar at the top */
    renderPhaseTracker(ctx) {
      const trackerY = 26;
      const trackerWidth = this.width - 40;
      const phaseWidth = trackerWidth / 4;
      const startX = 20;

      for (let phaseIndex = 0; phaseIndex < 4; phaseIndex++) {
        const phaseX = startX + phaseIndex * phaseWidth;
        const result = this.phaseResults[phaseIndex];
        const isCurrent = phaseIndex === this.currentPhaseIndex && this.finalVerdict === "pending";
        let backgroundColor = colors.panel;
        let borderColor = colors.nodeStroke;
        let textColor = colors.textDim;
        if (result === "pass") {
          backgroundColor = "#1a3a2a";
          borderColor = colors.nodeHasMessage;
          textColor = colors.nodeHasMessage;
        } else if (result === "fail") {
          backgroundColor = "#3a1a1a";
          borderColor = colors.nodeTarget;
          textColor = colors.nodeTarget;
        } else if (result === "skipped") {
          borderColor = colors.grid;
          textColor = colors.grid;
        } else if (isCurrent) {
          backgroundColor = "#1a2a3a";
          borderColor = colors.nodeActive;
          textColor = colors.text;
        }
        ctx.save();
        draw.roundedRect(ctx, phaseX + 4, trackerY - 16, phaseWidth - 8, 32, 6);
        ctx.fillStyle = backgroundColor;
        ctx.fill();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = isCurrent ? 2 : 1;
        ctx.stroke();
        ctx.restore();

        const phaseLabel = PHASE_LABELS[phaseIndex];
        const statusIcon = result === "pass" ? " ✓" : result === "fail" ? " ✗" : isCurrent ? " ●" : "";
        draw.label(ctx, `${phaseLabel.number}. ${phaseLabel.title}${statusIcon}`,
          phaseX + phaseWidth / 2, trackerY - 5, textColor, "bold 11px ui-monospace, monospace");
        draw.label(ctx, phaseLabel.sectionRef,
          phaseX + phaseWidth / 2, trackerY + 8, colors.textDim, "9px ui-monospace, monospace");
      }
    },

    /* Top panel: hovered field explanation, else the live phase processing. */
    renderTopPanel(ctx, layout) {
      const x = layout.topPanelX;
      const y = layout.topPanelY;
      const w = layout.topPanelWidth;
      const h = layout.topPanelHeight;

      ctx.save();
      draw.roundedRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = "#0e1420";
      ctx.fill();
      ctx.strokeStyle = this.hoveredFieldKey || this.selectedFieldKey ? colors.nodeActive : colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      if (this.hoveredFieldKey || this.selectedFieldKey) {
        P2P.stateAnatomy.renderFieldExplanation(ctx, this, x, y, w, h);
        return;
      }
      this.renderPhaseLog(ctx, x, y, w, h);
      if (this.finalVerdict !== "pending") this.renderVerdictBadge(ctx, x, y, w, h);
    },

    renderPhaseLog(ctx, x, y, w, h) {
      const phaseLabel = PHASE_LABELS[this.currentPhaseIndex];
      draw.label(ctx, `フェーズ ${phaseLabel.number}: ${phaseLabel.title}`,
        x + w / 2, y + 16, colors.text, "bold 12px ui-monospace, monospace");

      const completedSteps = this.phaseSteps.slice(0, this.currentStepIndex);
      const stepsInCurrentPhase = completedSteps.filter((s) => s.phase === this.currentPhaseIndex);
      const showWeightBar = this.currentPhaseIndex === 2 && this.finalVerdict === "pending";
      const reserveBottom = showWeightBar ? 48 : 14;
      const maxVisible = Math.max(2, Math.floor((h - 38 - reserveBottom) / 20));
      const visibleSteps = stepsInCurrentPhase.slice(-maxVisible);

      let stepY = y + 38;
      for (const step of visibleSteps) {
        const stepColor = step.kind === "phase-result"
          ? (step.result === "pass" ? colors.nodeHasMessage : step.result === "fail" ? colors.nodeTarget : colors.textDim)
          : step.kind === "attestation"
            ? (this.attestations[step.attestationIndex] &&
              this.attestations[step.attestationIndex].status === "counted"
              ? colors.nodeHasMessage : colors.nodeTarget)
            : step.kind === "header-check"
              ? (step.passed ? colors.nodeHasMessage : colors.nodeTarget)
              : colors.text;
        const displayText = this.truncateToWidth(ctx, step.description, w - 24, "11px ui-monospace, monospace");
        draw.label(ctx, displayText, x + 12, stepY, stepColor, "11px ui-monospace, monospace", "left");
        stepY += 20;
      }

      if (showWeightBar) {
        this.renderWeightBar(ctx, x, y + h - 40, w);
      }
      if (this.autoPlay && this.finalVerdict === "pending" && stepsInCurrentPhase.length === 0) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
        ctx.save();
        ctx.globalAlpha = 0.4 + pulse * 0.4;
        draw.label(ctx, "実行待機中…", x + w / 2, y + 46, colors.textDim, "11px ui-monospace, monospace");
        ctx.restore();
      }
    },

    truncateToWidth(ctx, text, maxWidth, font) {
      ctx.save();
      ctx.font = font;
      if (ctx.measureText(text).width <= maxWidth) {
        ctx.restore();
        return text;
      }
      let truncated = text;
      while (truncated.length > 1 && ctx.measureText(truncated + "…").width > maxWidth) {
        truncated = truncated.slice(0, -1);
      }
      ctx.restore();
      return truncated + "…";
    },

    /* Attestation weight bar in phase 3 */
    renderWeightBar(ctx, originX, originY, containerWidth) {
      const barX = originX + 12;
      const barWidth = containerWidth - 24;
      const barHeight = 14;

      const totalValidators = this.currentState.totalValidators;
      const justifiedVotes = this.currentState.justifiedVotes || 0;
      const superMajorityThreshold = Math.ceil((totalValidators * 2) / 3);
      const fillFraction = Math.min(1, justifiedVotes / totalValidators);
      const thresholdFraction = superMajorityThreshold / totalValidators;

      ctx.save();
      draw.roundedRect(ctx, barX, originY, barWidth, barHeight, 4);
      ctx.fillStyle = colors.grid;
      ctx.fill();
      if (fillFraction > 0) {
        draw.roundedRect(ctx, barX, originY, barWidth * fillFraction, barHeight, 4);
        ctx.fillStyle = 3 * justifiedVotes >= 2 * totalValidators ? colors.nodeHasMessage : colors.nodeActive;
        ctx.fill();
      }
      const thresholdX = barX + barWidth * thresholdFraction;
      ctx.restore();
      draw.line(ctx, thresholdX, originY - 4, thresholdX, originY + barHeight + 4, colors.nodeSource, 1.5, true);
      draw.label(ctx, "2/3", thresholdX, originY - 12, colors.nodeSource, "9px ui-monospace, monospace");
      const percentage = ((justifiedVotes / totalValidators) * 100).toFixed(1);
      draw.label(ctx, `有効投票: ${justifiedVotes} / ${totalValidators} validators (${percentage}%)`,
        originX + containerWidth / 2, originY + barHeight + 14, colors.text, "10px ui-monospace, monospace");
    },

    /* Final verdict badge, anchored to the bottom-right of the top panel */
    renderVerdictBadge(ctx, panelX, panelY, panelWidth, panelHeight) {
      const isAccepted = this.finalVerdict === "accept";
      const verdictText = isAccepted ? "✓ ブロック受理" : "✗ ブロック却下";
      const verdictColor = isAccepted ? colors.nodeHasMessage : colors.nodeTarget;
      const boxWidth = 220;
      const boxHeight = 34;
      const boxX = panelX + panelWidth - boxWidth - 14;
      const boxY = panelY + panelHeight - boxHeight - 12;
      ctx.save();
      draw.roundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
      ctx.fillStyle = isAccepted ? "#0d2e1a" : "#2e0d0d";
      ctx.fill();
      ctx.strokeStyle = verdictColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, verdictText, boxX + boxWidth / 2, boxY + boxHeight / 2, verdictColor,
        "bold 15px ui-monospace, monospace");
    },

    /* Mouse handling — field hover/select over the anatomy panels */
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

    /* Stats                                                             */
    getStats() {
      const activeKey = this.hoveredFieldKey || this.selectedFieldKey;
      if (activeKey) {
        const meta = P2P.stateAnatomy.FIELD_CATALOG[activeKey];
        return [
          { label: "選択フィールド", value: meta.label },
          { label: "区分", value: meta.category },
          { label: "サイズ", value: meta.fixedSize ? "□ 固定" : "◇ 可変" },
          { label: "現在フェーズ", value: `${PHASE_LABELS[this.currentPhaseIndex].number}. ${PHASE_LABELS[this.currentPhaseIndex].title}` },
        ];
      }
      const justifiedVotes = this.currentState.justifiedVotes || 0;
      const totalValidators = this.currentState.totalValidators;
      const percentage = ((justifiedVotes / totalValidators) * 100).toFixed(1);
      const superMajorityThreshold = Math.ceil((totalValidators * 2) / 3);
      const vsThreshold = `${percentage}% / ${((superMajorityThreshold / totalValidators) * 100).toFixed(0)}%`;
      const phaseLabel = PHASE_LABELS[this.currentPhaseIndex];
      const verdictLabel = this.finalVerdict === "accept" ? "受理 ✓"
        : this.finalVerdict === "reject" ? "却下 ✗" : "進行中";
      return [
        { label: "現在フェーズ", value: `${phaseLabel.number}. ${phaseLabel.title}` },
        { label: "state.slot", value: `${this.currentState.slot}` },
        { label: "block.slot", value: `${this.blockData ? this.blockData.slot : "-"}` },
        { label: "justified (slot)", value: `${this.currentState.latestJustifiedSlot}` },
        { label: "finalized (slot)", value: `${this.currentState.latestFinalizedSlot}` },
        { label: "得票/総バリデータ", value: vsThreshold },
        { label: "判定", value: verdictLabel },
      ];
    },

    /* Controls                                                          */
    buildControls(container) {
      const ui = P2P.ui;
      const sceneRef = this;

      const playbackGroup = ui.group("再生");
      playbackGroup.appendChild(ui.button("次のフェーズ ▶", () => {
        sceneRef.autoPlay = false;
        autoToggleInput.checked = false;
        sceneRef.advanceStep();
      }, "primary"));
      playbackGroup.appendChild(ui.button("リプレイ ↻", () => sceneRef.build()));
      const autoToggleWrapper = ui.toggle("自動再生", sceneRef.autoPlay, (checked) => {
        sceneRef.autoPlay = checked;
      });
      playbackGroup.appendChild(autoToggleWrapper);
      const autoToggleInput = autoToggleWrapper.querySelector("input");
      playbackGroup.appendChild(
        ui.slider("再生速度 x", 0.25, 3, 0.25, sceneRef.speed, (value) => {
          sceneRef.speed = value;
        })
      );
      container.appendChild(playbackGroup);

      const scenarioGroup = ui.group("シナリオ (故障注入)");
      const scenarioSelect = document.createElement("select");
      scenarioSelect.style.cssText =
        "width:100%;margin:4px 0 6px;padding:4px 6px;background:#1c2636;color:#e6edf6;" +
        "border:1px solid #3a4a63;border-radius:4px;font:11px ui-monospace,monospace;";
      for (const [scenarioKey, scenarioData] of Object.entries(SCENARIOS)) {
        const option = document.createElement("option");
        option.value = scenarioKey;
        option.textContent = scenarioData.label;
        option.selected = scenarioKey === sceneRef.scenarioKey;
        scenarioSelect.appendChild(option);
      }
      scenarioSelect.addEventListener("change", () => {
        sceneRef.scenarioKey = scenarioSelect.value;
        sceneRef.build();
      });
      scenarioGroup.appendChild(scenarioSelect);
      scenarioGroup.appendChild(
        ui.slider("空スロット数 (block.slot − state.slot)", 0, 5, 1, sceneRef.emptySlotCount, (value) => {
          sceneRef.emptySlotCount = Math.round(value);
          sceneRef.build();
        })
      );
      container.appendChild(scenarioGroup);

      const exploreGroup = ui.group("構造を見る");
      const infoText = document.createElement("div");
      infoText.style.cssText = "color:#8da2bd;font-size:11px;line-height:1.5;padding:2px 0 6px;";
      infoText.textContent =
        "状態/ブロックのフィールドにホバーで解説を中央に表示。クリックで固定。各フェーズが触るフィールドは橙色でハイライトされます。";
      exploreGroup.appendChild(infoText);
      exploreGroup.appendChild(ui.button("選択をクリア", () => {
        sceneRef.selectedFieldKey = null;
        sceneRef.hoveredFieldKey = null;
      }));
      container.appendChild(exploreGroup);
    },
  };

  P2P.scenes.pipeline = scene;
})();
