/*
 * pipeline.js — Section 4.3: The State Transition Function (4-phase pipeline).
 *
 * Shows an incoming block being validated through the 4 phases:
 *   Phase 1: Time Synchronization — advance state slot to match block slot
 *   Phase 2: Header Validation — proposer / parent_root / slot checks
 *   Phase 3: Consensus Execution — attestation voting, weighting, justify, finalize
 *   Phase 4: Integrity Verification — HashTreeRoot vs block.header.state_root
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
    title: "遷移パイプライン",
    sectionRef: "4.3",
    descriptionHTML: `
      <p><b>状態遷移関数 S<sub>n+1</sub> = Υ(S<sub>n</sub>, B)</b> は4フェーズの検証パイプラインです。
      いずれかのフェーズが失敗するとブロックは<b>即時却下</b>され、状態は変更されません。</p>
      <p><b>① 時刻同期 (§4.3.1):</b> state.slot をブロックのスロットまで進める。
      スキップされた空スロットは1つずつ処理し、各スロットの state root を履歴に積む。</p>
      <p><b>② ヘッダ検証 (§4.3.2):</b> (a) proposer_index が正しいか、
      (b) block.parent_root が直前ブロックのハッシュと一致するか、
      (c) block.slot &gt; parent.slot か、の3検査。</p>
      <p><b>③ ペイロード実行 (§4.3.3):</b> 各 attestation を順番に処理。
      source が justified 済みで target が正当なスロットなら票として計上。
      全体の 2/3 超で target を justified に、justified チェーンが連続すれば finalized に昇格。
      無効票はソフトフェイル(スキップ)でブロック全体は却下されない。</p>
      <p><b>④ integrity 検証 (§4.3.4):</b> HashTreeRoot(S<sub>n+1</sub>) を計算し、
      block.header.state_root と一致すれば受理。提案者が誤ったルートを申告した場合は却下。</p>
      <p><b>操作:</b>「次のフェーズ ▶」で1段ずつ進める。「自動再生」で連続実行。
      「シナリオ」で故障注入パターンを切り替えて各フェーズの棄却を確認できます。</p>`,

    width: 0,
    height: 0,
    clock: 0,
    speed: 1,
    autoPlay: true,
    endHoldClock: 0,      // time spent holding the final verdict before looping
    emptySlotCount: 2,    // block.slot − state.slot
    scenarioKey: "normal",

    /* Derived scenario state — rebuilt by build() */
    scenario: null,
    stateSnapshot: null,   // initial state
    currentState: null,    // state as phases run
    blockData: null,
    attestations: [],
    phaseSteps: [],        // Array of step descriptors for each phase
    animationClock: 0,     // phase-local sub-clock
    currentPhaseIndex: 0,  // 0-based index into PHASE_LABELS
    currentStepIndex: 0,   // step within current phase
    phaseResults: [],      // "pending"|"pass"|"fail" per phase
    finalVerdict: "pending", // "accept"|"reject"|"pending"
    hoveredAttestationIndex: -1,

    init(env) {
      this.width = env.width;
      this.height = env.height;
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
      this.hoveredAttestationIndex = -1;
      this.scenario = SCENARIOS[this.scenarioKey];

      /* Initial state, plus a working copy that mutates as phases run */
      const stateSlot = 10;
      const totalActiveStake = 3200;  // ETH (32 × 100 validators)
      this.stateSnapshot = {
        slot: stateSlot,
        latestBlockHashHex: "0xa1b2",
        latestJustifiedSlot: 8,
        latestFinalizedSlot: 6,
        totalActiveStake,
        justifiedWeight: 0,
      };
      this.currentState = { ...this.stateSnapshot };

      /* Block data */
      const blockSlot = stateSlot + this.emptySlotCount;
      const correctProposerIndex = 42;
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
      /* Attestations in the body */
      const validAttestationWeight = 1200;    // ETH
      const invalidAttestationWeight = 300;   // ETH per invalid attestation
      const totalAttestationCount = 4;
      this.attestations = [];
      for (let attestationIndex = 0; attestationIndex < totalAttestationCount; attestationIndex++) {
        const isInvalid = attestationIndex < this.scenario.invalidAttestationCount;
        this.attestations.push({
          index: attestationIndex,
          sourceSlot: isInvalid ? 3 : 8,   // 3 = not yet justified, 8 = justified
          targetSlot: blockSlot,
          validatorWeight: isInvalid ? invalidAttestationWeight : validAttestationWeight,
          sourceJustified: !isInvalid,
          status: "pending",  // "pending"|"counted"|"ignored"
        });
      }
      this.phaseSteps = this.buildPhaseSteps();
    },

    buildPhaseSteps() {
      const { emptySlotCount, stateSnapshot, blockData, attestations } = this;
      const totalActiveStake = stateSnapshot.totalActiveStake;
      const superMajorityThreshold = Math.ceil(totalActiveStake * 2 / 3);

      return [
        /* Phase 1: Time Synchronization */
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
        /* Phase 2: Header Validation — 3 checks */
        {
          phase: 1,
          kind: "header-check",
          passed: this.scenario.proposerValid,
          description: this.scenario.proposerValid
            ? `proposer_index ${blockData.proposerIndex} == expected ${blockData.correctProposerIndex} ✓`
            : `proposer_index ${blockData.proposerIndex} ≠ expected ${blockData.correctProposerIndex} ✗ → 却下`,
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
        /* Phase 3: Consensus Execution — per attestation */
        ...attestations.map((attestation, attestationIndex) => ({
          phase: 2,
          kind: "attestation",
          attestationIndex,
          description: attestation.sourceJustified
            ? `attestation[${attestationIndex}]: source slot ${attestation.sourceSlot} は justified ✓ → 重み +${attestation.validatorWeight} ETH`
            : `attestation[${attestationIndex}]: source slot ${attestation.sourceSlot} は未 justified ✗ → スキップ(ソフトフェイル)`,
        })),
        {
          phase: 2,
          kind: "phase-result",
          result: "pass",
          description: (() => {
            const validWeight = attestations
              .filter(a => a.sourceJustified)
              .reduce((sum, a) => sum + a.validatorWeight, 0);
            const ratio = (validWeight / totalActiveStake * 100).toFixed(1);
            const justified = validWeight >= superMajorityThreshold;
            return `有効投票 ${validWeight} / ${totalActiveStake} ETH (${ratio}%) — ` +
              (justified ? `2/3 超 → justified ✓` : `2/3 未満 — 正当化なし`);
          })(),
        },
        /* Phase 4: Integrity Verification */
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

    /* Determine if a phase has failed based on scenario                */
    phaseShouldFail(phaseIndex) {
      if (phaseIndex === 1) {
        return !this.scenario.proposerValid || !this.scenario.parentRootValid;
      }
      if (phaseIndex === 3) {
        return !this.scenario.stateRootValid;
      }
      return false;
    },

    /* Advance to the next step                                         */
    advanceStep() {
      if (this.finalVerdict !== "pending") return;

      const steps = this.phaseSteps;
      if (this.currentStepIndex >= steps.length) return;

      const step = steps[this.currentStepIndex];
      this.applyStep(step);
      this.currentStepIndex++;

      // Check if we moved to a new phase
      if (this.currentStepIndex < steps.length) {
        const nextStep = steps[this.currentStepIndex];
        if (nextStep.phase > this.currentPhaseIndex) {
          this.currentPhaseIndex = nextStep.phase;
        }
      }
    },

    applyStep(step) {
      if (step.kind === "slot-advance") {
        this.currentState = {
          ...this.currentState,
          slot: step.slotNumber,
        };
      } else if (step.kind === "phase-result") {
        const phaseIndex = step.phase;
        this.phaseResults[phaseIndex] = step.result;
        if (step.result === "fail") {
          this.finalVerdict = "reject";
          // Mark remaining phases as skipped
          for (let index = phaseIndex + 1; index < 4; index++) {
            this.phaseResults[index] = "skipped";
          }
          this.currentStepIndex = this.phaseSteps.length; // skip rest
        } else if (phaseIndex === 3 && step.result === "pass") {
          this.finalVerdict = "accept";
        }
      } else if (step.kind === "attestation") {
        const attestation = this.attestations[step.attestationIndex];
        if (attestation.sourceJustified) {
          attestation.status = "counted";
          // Accumulate weight
          const previousWeight = this.currentState.justifiedWeight || 0;
          this.currentState = {
            ...this.currentState,
            justifiedWeight: previousWeight + attestation.validatorWeight,
          };
        } else {
          attestation.status = "ignored";
        }
      }
      // header-check and state-root-check steps mutate no state; they are
      // purely informational and rendered from their own descriptions.
    },

    /* Update loop                                                       */
    update(realDt) {
      const cappedDt = Math.min(0.05, realDt);
      if (!this.autoPlay) return;

      // Once the verdict is in, hold it briefly so it is readable, then loop
      // back to the start so the motion keeps playing without user input.
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
      const layout = this.computeLayout();
      this.renderPhaseTracker(ctx);
      this.renderStatePanel(ctx, layout);
      this.renderPhaseDetail(ctx, layout);
      this.renderBlockPanel(ctx, layout);
      this.renderVerdict(ctx);
    },

    /*
     * Three non-overlapping columns (state | phase detail | block), sharing a
     * fixed gutter and clamped so the block column always fits the longest
     * header label ("proposer_index:") plus its right-aligned value.
     */
    computeLayout() {
      const outerMargin = 16;
      const columnGap = 16;
      const panelTop = 60;
      const usableWidth = this.width - outerMargin * 2 - columnGap * 2;

      // Preferred widths: block column fits "proposer_index:" plus its value.
      // If the preferred minimums do not fit, fall back to a proportional split
      // so the three columns still tile the width without overlapping.
      const minimumTotal = 248 + 190 + 220;
      let blockColumnWidth;
      let stateColumnWidth;
      let detailColumnWidth;
      if (usableWidth >= minimumTotal) {
        blockColumnWidth = Math.max(248, Math.floor(usableWidth * 0.30));
        stateColumnWidth = Math.max(190, Math.floor(usableWidth * 0.27));
        detailColumnWidth = usableWidth - blockColumnWidth - stateColumnWidth;
      } else {
        blockColumnWidth = Math.floor(usableWidth * 0.34);
        stateColumnWidth = Math.floor(usableWidth * 0.28);
        detailColumnWidth = usableWidth - blockColumnWidth - stateColumnWidth;
      }

      const stateColumnX = outerMargin;
      const detailColumnX = stateColumnX + stateColumnWidth + columnGap;
      const blockColumnX = detailColumnX + detailColumnWidth + columnGap;

      return {
        panelTop,
        stateColumnX,
        stateColumnWidth,
        detailColumnX,
        detailColumnWidth,
        blockColumnX,
        blockColumnWidth,
      };
    },

    /* Phase tracker bar at the top */
    renderPhaseTracker(ctx) {
      const trackerY = 28;
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
          backgroundColor = colors.panel;
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

    /* State panel (left side) */
    renderStatePanel(ctx, layout) {
      const panelX = layout.stateColumnX;
      const panelY = layout.panelTop;
      const panelWidth = layout.stateColumnWidth;
      const panelHeight = 200;
      const labelPadding = 8;

      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.nodeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, "現在の状態 S_n", panelX + panelWidth / 2, panelY + 14,
        colors.accent, "bold 11px ui-monospace, monospace");
      const state = this.currentState;
      const fields = [
        ["slot", `${state.slot}`],
        ["latestBlockHash", state.latestBlockHashHex],
        ["latestJustified", `slot ${state.latestJustifiedSlot}`],
        ["latestFinalized", `slot ${state.latestFinalizedSlot}`],
        ["totalActiveStake", `${state.totalActiveStake} ETH`],
      ];
      if (state.justifiedWeight > 0) {
        const percentage = (state.justifiedWeight / state.totalActiveStake * 100).toFixed(1);
        fields.push(["justifiedWeight", `${state.justifiedWeight} ETH (${percentage}%)`]);
      }

      let fieldY = panelY + 34;
      for (const [fieldName, fieldValue] of fields) {
        const slotChanged = fieldName === "slot" && state.slot !== this.stateSnapshot.slot;
        const weightChanged = fieldName === "justifiedWeight" && state.justifiedWeight > 0;
        const labelColor = (slotChanged || weightChanged) ? colors.nodeSource : colors.textDim;
        const valueColor = (slotChanged || weightChanged) ? colors.text : colors.textDim;

        draw.label(ctx, fieldName + ":", panelX + labelPadding, fieldY, labelColor, "10px ui-monospace, monospace", "left");
        draw.label(ctx, fieldValue, panelX + panelWidth - labelPadding, fieldY, valueColor, "10px ui-monospace, monospace", "right");
        fieldY += 18;
      }
    },

    /* Block anatomy panel (right side) */
    renderBlockPanel(ctx, layout) {
      const panelX = layout.blockColumnX;
      const panelWidth = layout.blockColumnWidth;
      const panelY = layout.panelTop;
      const headerHeight = 130;
      const labelPadding = 8;

      /* Header box (fixed size) */
      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, headerHeight, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.nodeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      draw.label(ctx, "Block.Header (固定サイズ)", panelX + panelWidth / 2, panelY + 12,
        colors.accent, "bold 11px ui-monospace, monospace");
      const block = this.blockData;
      const headerFields = [
        ["slot", `${block.slot}`],
        ["proposer_index", `${block.proposerIndex}${!this.scenario.proposerValid ? " ← 不正" : ""}`],
        ["parent_root", `${block.parentRoot}${!this.scenario.parentRootValid ? " ← 不一致" : ""}`],
        ["state_root", `${block.stateRoot}${!this.scenario.stateRootValid ? " ← 不一致" : ""}`],
        ["body_root", `${block.bodyRoot}`],
      ];

      let headerFieldY = panelY + 28;
      for (const [fieldName, fieldValue] of headerFields) {
        const isInvalid = (fieldName === "proposer_index" && !this.scenario.proposerValid) ||
          (fieldName === "parent_root" && !this.scenario.parentRootValid) ||
          (fieldName === "state_root" && !this.scenario.stateRootValid);
        const labelColor = isInvalid ? colors.nodeTarget : colors.textDim;
        const valueColor = isInvalid ? colors.nodeTarget : colors.text;

        draw.label(ctx, fieldName + ":", panelX + labelPadding, headerFieldY, labelColor, "10px ui-monospace, monospace", "left");
        draw.label(ctx, fieldValue, panelX + panelWidth - labelPadding, headerFieldY, valueColor, "10px ui-monospace, monospace", "right");
        headerFieldY += 18;
      }
      /* Body box (variable) */
      const bodyY = panelY + headerHeight + 8;
      const attestationRowHeight = 20;
      const bodyHeight = 28 + this.attestations.length * attestationRowHeight;
      ctx.save();
      draw.roundedRect(ctx, panelX, bodyY, panelWidth, bodyHeight, 8);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.strokeStyle = colors.ihave + "99";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, "Block.Body (可変サイズ)", panelX + panelWidth / 2, bodyY + 12,
        colors.ihave, "bold 11px ui-monospace, monospace");
      let attestationY = bodyY + 28;
      for (const attestation of this.attestations) {
        const statusColor = attestation.status === "counted" ? colors.nodeHasMessage
          : attestation.status === "ignored" ? colors.nodeTarget
          : colors.textDim;
        const attestationText = `att[${attestation.index}] src:${attestation.sourceSlot} tgt:${attestation.targetSlot} w:${attestation.validatorWeight}`;
        const statusText = attestation.status === "counted" ? " ✓"
          : attestation.status === "ignored" ? " ✗"
          : "";

        draw.label(ctx, attestationText + statusText, panelX + labelPadding, attestationY,
          statusColor, "9px ui-monospace, monospace", "left");
        attestationY += attestationRowHeight;
      }
    },

    /* Truncate text with an ellipsis so it fits within maxWidth pixels. */
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

    /* Current phase detail / animation area (center) */
    renderPhaseDetail(ctx, layout) {
      const detailX = layout.detailColumnX;
      const detailWidth = layout.detailColumnWidth;
      const detailY = layout.panelTop;
      const detailHeight = 260;

      ctx.save();
      draw.roundedRect(ctx, detailX, detailY, detailWidth, detailHeight, 8);
      ctx.fillStyle = "#0e1420";
      ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      const centerX = detailX + detailWidth / 2;
      const phaseLabel = PHASE_LABELS[this.currentPhaseIndex];
      draw.label(ctx, `フェーズ ${phaseLabel.number}: ${phaseLabel.title}`,
        centerX, detailY + 18, colors.text, "bold 12px ui-monospace, monospace");
      /* Show completed steps */
      const completedSteps = this.phaseSteps.slice(0, this.currentStepIndex);
      const stepsInCurrentPhase = completedSteps.filter(s => s.phase === this.currentPhaseIndex);

      let stepY = detailY + 40;
      const maxVisibleSteps = 9;
      const visibleSteps = stepsInCurrentPhase.slice(-maxVisibleSteps);

      for (const step of visibleSteps) {
        const stepColor = step.kind === "phase-result"
          ? (step.result === "pass" ? colors.nodeHasMessage : step.result === "fail" ? colors.nodeTarget : colors.textDim)
          : step.kind === "attestation"
            ? (step.attestationIndex < this.attestations.length &&
              this.attestations[step.attestationIndex].status === "counted"
              ? colors.nodeHasMessage
              : colors.nodeTarget)
            : step.kind === "header-check"
              ? (step.passed ? colors.nodeHasMessage : colors.nodeTarget)
              : colors.text;

        const displayText = this.truncateToWidth(
          ctx, step.description, detailWidth - 20, "10px ui-monospace, monospace");
        draw.label(ctx, displayText, detailX + 10, stepY, stepColor,
          "10px ui-monospace, monospace", "left");
        stepY += 22;
      }

      /* Weight bar for phase 3 */
      if (this.currentPhaseIndex === 2) {
        this.renderWeightBar(ctx, detailX, detailY + detailHeight - 60, detailWidth);
      }

      /* Pulsing "pending" indicator when autoPlay is on */
      if (this.autoPlay && this.finalVerdict === "pending" && stepsInCurrentPhase.length === 0) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
        ctx.save();
        ctx.globalAlpha = 0.4 + pulse * 0.4;
        draw.label(ctx, "実行待機中…", centerX, detailY + 60, colors.textDim,
          "11px ui-monospace, monospace");
        ctx.restore();
      }
    },

    /* Attestation weight bar in phase 3 */
    renderWeightBar(ctx, originX, originY, containerWidth) {
      const barX = originX + 12;
      const barWidth = containerWidth - 24;
      const barHeight = 14;

      const totalActiveStake = this.currentState.totalActiveStake;
      const justifiedWeight = this.currentState.justifiedWeight || 0;
      const superMajorityThreshold = Math.ceil(totalActiveStake * 2 / 3);
      const fillFraction = Math.min(1, justifiedWeight / totalActiveStake);
      const thresholdFraction = superMajorityThreshold / totalActiveStake;

      /* Background bar, then the filled portion */
      ctx.save();
      draw.roundedRect(ctx, barX, originY, barWidth, barHeight, 4);
      ctx.fillStyle = colors.grid;
      ctx.fill();
      if (fillFraction > 0) {
        draw.roundedRect(ctx, barX, originY, barWidth * fillFraction, barHeight, 4);
        ctx.fillStyle = fillFraction >= thresholdFraction ? colors.nodeHasMessage : colors.nodeActive;
        ctx.fill();
      }
      /* 2/3 threshold marker */
      const thresholdX = barX + barWidth * thresholdFraction;
      ctx.restore();
      draw.line(ctx, thresholdX, originY - 4, thresholdX, originY + barHeight + 4,
        colors.nodeSource, 1.5, true);
      draw.label(ctx, "2/3", thresholdX, originY - 12, colors.nodeSource,
        "9px ui-monospace, monospace");
      const percentage = (justifiedWeight / totalActiveStake * 100).toFixed(1);
      draw.label(ctx, `有効投票: ${justifiedWeight} / ${totalActiveStake} ETH (${percentage}%)`,
        originX + containerWidth / 2, originY + barHeight + 14, colors.text,
        "10px ui-monospace, monospace");
    },

    /* Final verdict overlay */
    renderVerdict(ctx) {
      if (this.finalVerdict === "pending") return;
      const isAccepted = this.finalVerdict === "accept";
      const verdictText = isAccepted ? "✓ ブロック受理" : "✗ ブロック却下";
      const verdictColor = isAccepted ? colors.nodeHasMessage : colors.nodeTarget;
      const verdictBg = isAccepted ? "#0d2e1a" : "#2e0d0d";
      const boxWidth = 240;
      const boxHeight = 44;
      const boxX = (this.width - boxWidth) / 2;
      const boxY = this.height - 80;
      ctx.save();
      draw.roundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
      ctx.fillStyle = verdictBg;
      ctx.fill();
      ctx.strokeStyle = verdictColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, verdictText, this.width / 2, boxY + boxHeight / 2,
        verdictColor, "bold 16px ui-monospace, monospace");
    },

    /* Mouse handling                                                    */
    onMouse(type, mouseX, mouseY) {
      // Hover detection over attestation rows in block body panel
      const layout = this.computeLayout();
      const panelX = layout.blockColumnX;
      const panelWidth = layout.blockColumnWidth;
      const bodyY = layout.panelTop + 130 + 8;
      const attestationRowHeight = 20;
      const attestationStartY = bodyY + 28;

      let hoveredIndex = -1;
      for (let attestationIndex = 0; attestationIndex < this.attestations.length; attestationIndex++) {
        const rowTop = attestationStartY + attestationIndex * attestationRowHeight - 8;
        if (mouseX >= panelX && mouseX <= panelX + panelWidth &&
          mouseY >= rowTop && mouseY <= rowTop + attestationRowHeight) {
          hoveredIndex = attestationIndex;
          break;
        }
      }
      this.hoveredAttestationIndex = hoveredIndex;
    },

    /* Stats                                                             */
    getStats() {
      const justifiedWeight = this.currentState.justifiedWeight || 0;
      const totalActiveStake = this.currentState.totalActiveStake;
      const percentage = (justifiedWeight / totalActiveStake * 100).toFixed(1);
      const superMajorityThreshold = Math.ceil(totalActiveStake * 2 / 3);
      const vsThreshold = `${percentage}% / ${(superMajorityThreshold / totalActiveStake * 100).toFixed(0)}%`;
      const phaseLabel = PHASE_LABELS[this.currentPhaseIndex];
      const verdictLabel = this.finalVerdict === "accept" ? "受理 ✓"
        : this.finalVerdict === "reject" ? "却下 ✗"
        : "進行中";
      return [
        { label: "現在フェーズ", value: `${phaseLabel.number}. ${phaseLabel.title}` },
        { label: "state.slot", value: `${this.currentState.slot}` },
        { label: "block.slot", value: `${this.blockData ? this.blockData.slot : "-"}` },
        { label: "justified (slot)", value: `${this.currentState.latestJustifiedSlot}` },
        { label: "finalized (slot)", value: `${this.currentState.latestFinalizedSlot}` },
        { label: "投票重み/総ステーク", value: vsThreshold },
        { label: "判定", value: verdictLabel },
      ];
    },

    /* Controls                                                          */
    buildControls(container) {
      const ui = P2P.ui;
      const sceneRef = this;

      /* Playback group */
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

      /* Scenario group */
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
    },
  };

  P2P.scenes.pipeline = scene;
})();
