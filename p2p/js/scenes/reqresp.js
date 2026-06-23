/*
 * reqresp.js — Section 5.5: The request-response domain.
 *
 * A sequence diagram between a Requester and a Responder showing:
 *   - The mandatory Status handshake (Figure 5.21): fork-digest gate, then a
 *     head comparison that triggers a BeaconBlocksByRange sync.
 *   - The stream lifecycle (Figure 5.19): open + protocol negotiation, request
 *     payload, asymmetric half-closure (EOF), processing, response chunks,
 *     and full close.
 *   - Chain reconstruction: empty slots are omitted by the responder, so the
 *     requester must relink blocks by parent_root.
 */
"use strict";

(function registerReqResp() {
  const { util, draw, colors } = P2P;

  const LOCAL_HEAD = 1000;
  const FORK_DIGEST = "0x9b3a";
  const CHUNK_INTERVAL = 0.7;
  const PROCESSING_START = 2.8;
  const CHUNK_START = 3.6;

  const scene = {
    id: "reqresp",
    title: "Request-Response",
    sectionRef: "5.5",
    descriptionHTML: `
      <p><b>Gossip がブロードキャストなのに対し、Req/Resp は 1対1 の直接対話。</b>
      同期で履歴を取り寄せたり、取りこぼした特定ブロックをピンポイントで要求する。</p>
      <p><b>① Status ハンドシェイク (5.5.4):</b> 接続直後に必ず交換。
      <code>Fork Digest</code> が不一致なら別ネットワークとみなして即切断(ゲート)。
      一致すれば <code>head</code> を比較し、相手が進んでいれば
      <code>BeaconBlocksByRange</code> で差分を要求。</p>
      <p><b>② ストリームの一生 (5.5.2):</b> 1リクエスト=1ストリーム(使い捨て)。
      要求を書いたら即 <b>write 側を閉じて EOF</b>(非対称クローズ=「以上、どうぞ」)。
      応答側は処理してチャンクを返し、最後にストリームを閉じる。</p>
      <p><b>③ 空きスロットと再構築 (5.5.4):</b> 提案者が不在のスロットはブロックが無い。
      応答側はそれを<b>省略</b>するので、要求側は連続を仮定できず、
      各ブロックの <code>parent_root</code> が直前のハッシュと繋がるか検証して連結する。</p>
      <p><b>各チャンクのワイヤ形式 (5.5.3):</b>
      <code>[status 1B][varint 長さ][Snappy(SSZ)]</code>。
      長さを先に宣言させ、10 MiB 超なら復号前に切断(解凍爆弾対策)。</p>
      <p><b>操作:</b> 「次へ」で1段ずつ、または「自動再生」。「ヘッド差」と「空きスロット」を変更可。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    clock: 0,
    speed: 1,
    autoPlay: true,
    headGap: 6,
    emptySlots: true,
    messages: [],
    blocks: [],
    endTime: 0,

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.build();
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    /* ------------------------- scenario ------------------------- */
    build() {
      this.clock = 0;
      const remoteHead = LOCAL_HEAD + this.headGap;
      const firstSlot = LOCAL_HEAD + 1;

      // Which slots actually carry a block (some are empty -> omitted).
      const emptySlotOffset = this.emptySlots && this.headGap >= 3 ? 2 : -1; // 3rd slot empty
      const blocks = [];
      let previousRoot = util.toHexTag(LOCAL_HEAD, 4);
      for (let offset = 0; offset < this.headGap; offset++) {
        const slot = firstSlot + offset;
        if (offset === emptySlotOffset) {
          blocks.push({ slot, empty: true });
          continue;
        }
        const root = util.toHexTag(0xb000 + slot, 4);
        blocks.push({ slot, empty: false, root, parentRoot: previousRoot });
        previousRoot = root;
      }
      this.blocks = blocks;

      // Sequence-diagram messages on a shared time axis (one-way trip = 1 unit).
      const messages = [
        { t: 0, dir: 1, kind: "msg", label: `Status (fork=${FORK_DIGEST}, head=${LOCAL_HEAD})` },
        { t: 0.6, dir: -1, kind: "msg", label: `Status (fork=${FORK_DIGEST}, head=${remoteHead})` },
        { t: 1.1, kind: "note", label: `Fork Digest 一致 ✓ — head ${remoteHead} > ${LOCAL_HEAD}` },
        { t: 1.5, dir: 1, kind: "msg", label: "Open stream + protocol 交渉" },
        { t: 2.1, dir: 1, kind: "msg", label: `Request: BeaconBlocksByRange [${firstSlot}..${remoteHead}]` },
        { t: 2.6, kind: "halfclose", label: "write 側を閉じる → EOF (half-closed)" },
        { t: PROCESSING_START, kind: "processing", label: "Responder: DB lookup（空きスロットは省略）" },
      ];
      const presentBlocks = blocks.filter((block) => !block.empty);
      presentBlocks.forEach((block, chunkIndex) => {
        messages.push({
          t: CHUNK_START + chunkIndex * CHUNK_INTERVAL,
          dir: -1,
          kind: "chunk",
          chunkIndex,
          block,
          label: `chunk: block slot ${block.slot}`,
        });
      });
      const closeTime = CHUNK_START + presentBlocks.length * CHUNK_INTERVAL + 0.3;
      messages.push({ t: closeTime, dir: -1, kind: "note", label: "Close stream (fully closed)" });
      this.messages = messages;
      this.endTime = closeTime + 1.2;
    },

    advanceToNext() {
      // Jump the clock to just past the next not-yet-revealed message.
      for (const message of this.messages) {
        const reveal = message.t + (message.kind === "processing" ? 0.0 : 1.0);
        if (this.clock < reveal - 0.001) {
          this.clock = reveal;
          return;
        }
      }
      this.clock = this.endTime;
    },

    chunksArrived() {
      return this.messages.filter(
        (m) => m.kind === "chunk" && this.clock >= m.t + 1.0,
      ).length;
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      if (this.autoPlay && this.clock < this.endTime) {
        this.clock = Math.min(this.endTime, this.clock + realDt * this.speed);
      }
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderSequence(ctx);
      this.renderChainStrip(ctx);
      this.renderWireFormat(ctx);
    },

    renderSequence(ctx) {
      const requesterX = this.width * 0.26;
      const responderX = this.width * 0.74;
      const top = 54;
      const unit = 30;
      const bottomLimit = this.height - 200;

      // Lifelines.
      draw.line(ctx, requesterX, top, requesterX, bottomLimit, colors.grid, 1.6, false);
      draw.line(ctx, responderX, top, responderX, bottomLimit, colors.grid, 1.6, false);
      draw.label(ctx, "Requester", requesterX, top - 16, colors.nodeSource, "bold 13px ui-monospace, monospace");
      draw.label(ctx, "Responder", responderX, top - 16, colors.accent, "bold 13px ui-monospace, monospace");

      let halfClosed = false;
      for (const message of this.messages) {
        const y = top + Math.min(message.t, (bottomLimit - top) / unit) * unit;
        if (message.kind === "note") {
          if (this.clock >= message.t) {
            draw.label(ctx, message.label, this.width / 2, y, colors.textDim, "11px ui-monospace, monospace");
          }
        } else if (message.kind === "halfclose") {
          if (this.clock >= message.t) {
            halfClosed = true;
            draw.label(ctx, "⊣ EOF", requesterX, y, colors.iwant, "12px ui-monospace, monospace");
            draw.label(ctx, message.label, requesterX + 16, y, colors.iwant, "11px ui-monospace, monospace", "left");
          }
        } else if (message.kind === "processing") {
          if (this.clock >= message.t && this.clock < CHUNK_START) {
            const pulse = 0.5 + 0.5 * Math.sin(this.clock * 6);
            ctx.save();
            ctx.globalAlpha = 0.4 + pulse * 0.5;
            draw.roundedRect(ctx, responderX - 70, y - 12, 140, 24, 6);
            ctx.fillStyle = colors.accent + "44";
            ctx.fill();
            ctx.restore();
            draw.label(ctx, "processing…", responderX, y, colors.accent, "11px ui-monospace, monospace");
          }
        } else {
          // Animated arrow (msg / chunk).
          if (this.clock < message.t) continue;
          const fromX = message.dir === 1 ? requesterX : responderX;
          const toX = message.dir === 1 ? responderX : requesterX;
          const fraction = util.clamp(this.clock - message.t, 0, 1);
          const x = util.lerp(fromX, toX, fraction);
          const color = message.kind === "chunk" ? colors.nodeHasMessage : message.dir === 1 ? colors.nodeSource : colors.accent;
          draw.arrow(ctx, fromX, y, x, y, color, 1.8);
          if (fraction > 0.2) {
            const labelX = (fromX + toX) / 2;
            draw.label(ctx, message.label, labelX, y - 9, colors.text, "11px ui-monospace, monospace");
          }
        }
      }
      if (halfClosed && this.clock < CHUNK_START) {
        draw.label(ctx, "状態: half-closed (応答待ち)", this.width / 2, bottomLimit + 4, colors.iwant, "11px ui-monospace, monospace");
      }
    },

    /* Reconstructed chain at the bottom, filled as chunks arrive. */
    renderChainStrip(ctx) {
      const top = this.height - 150;
      draw.label(ctx, "受信側のチェーン再構築 (parent_root で連結)", 20, top - 8, colors.textDim, "12px ui-monospace, monospace", "left");
      const boxWidth = 92;
      const gap = 18;
      const totalWidth = this.blocks.length * (boxWidth + gap);
      const startX = Math.max(20, (this.width - totalWidth) / 2);
      const y = top + 26;
      const arrived = this.chunksArrived();
      let presentSeen = 0;
      let previousBoxCenter = null;

      this.blocks.forEach((block) => {
        const x = startX + this.blocks.indexOf(block) * (boxWidth + gap);
        if (block.empty) {
          ctx.save();
          ctx.setLineDash([4, 4]);
          draw.roundedRect(ctx, x, y, boxWidth, 52, 6);
          ctx.strokeStyle = colors.textDim;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();
          draw.label(ctx, `slot ${block.slot}`, x + boxWidth / 2, y + 18, colors.textDim, "11px ui-monospace, monospace");
          draw.label(ctx, "empty (省略)", x + boxWidth / 2, y + 36, colors.textDim, "10px ui-monospace, monospace");
          return;
        }
        const isArrived = presentSeen < arrived;
        presentSeen++;
        const fill = isArrived ? colors.nodeHasMessage : colors.node;
        ctx.save();
        ctx.globalAlpha = isArrived ? 1 : 0.35;
        draw.roundedRect(ctx, x, y, boxWidth, 52, 6);
        ctx.fillStyle = "#15202f";
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = fill;
        ctx.stroke();
        ctx.restore();
        draw.label(ctx, `slot ${block.slot}`, x + boxWidth / 2, y + 14, colors.text, "11px ui-monospace, monospace");
        draw.label(ctx, `root ${block.root}`, x + boxWidth / 2, y + 30, isArrived ? colors.nodeHasMessage : colors.textDim, "10px ui-monospace, monospace");
        draw.label(ctx, `parent ${block.parentRoot}`, x + boxWidth / 2, y + 44, colors.textDim, "9px ui-monospace, monospace");

        // Link to the previous present block via parent_root.
        if (previousBoxCenter !== null && isArrived) {
          draw.arrow(ctx, x - 2, y + 26, previousBoxCenter + 2, y + 26, colors.nodeHasMessage + "aa", 1.4);
        }
        previousBoxCenter = x + boxWidth;
      });
    },

    renderWireFormat(ctx) {
      const x = this.width - 280;
      const y = this.height - 64;
      ctx.save();
      draw.roundedRect(ctx, x, y - 18, 264, 56, 8);
      ctx.fillStyle = "#0e1420dd";
      ctx.fill();
      ctx.restore();
      draw.label(ctx, "chunk wire 形式", x + 10, y - 4, colors.textDim, "10px ui-monospace, monospace", "left");
      const segments = [
        ["status 1B", colors.nodeHasMessage],
        ["varint len", colors.accent],
        ["Snappy(SSZ)", colors.ihave],
      ];
      let sx = x + 10;
      for (const [text, color] of segments) {
        const widthBox = ctx.measureText(text).width + 16;
        draw.roundedRect(ctx, sx, y + 6, widthBox, 18, 4);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        draw.label(ctx, text, sx + widthBox / 2, y + 15, color, "9px ui-monospace, monospace");
        sx += widthBox + 6;
      }
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    getStats() {
      const presentCount = this.blocks.filter((b) => !b.empty).length;
      const emptyCount = this.blocks.length - presentCount;
      return [
        { label: "経過 (one-way)", value: this.clock.toFixed(1) },
        { label: "head 差", value: `${this.headGap} スロット` },
        { label: "受信チャンク", value: `${this.chunksArrived()} / ${presentCount}` },
        { label: "空きスロット(省略)", value: emptyCount },
        { label: "状態", value: this.clock >= this.endTime ? "完了 (closed)" : "進行中" },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const actions = ui.group("再生");
      actions.appendChild(ui.button("次へ ▶", () => {
        this.autoPlay = false;
        autoToggle.querySelector("input").checked = false;
        this.advanceToNext();
      }, "primary"));
      actions.appendChild(ui.button("リプレイ ↻", () => this.build()));
      const autoToggle = ui.toggle("自動再生", this.autoPlay, (v) => (this.autoPlay = v));
      actions.appendChild(autoToggle);
      actions.appendChild(ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (v) => (this.speed = v)));
      container.appendChild(actions);

      const params = ui.group("シナリオ");
      params.appendChild(
        ui.slider("ヘッド差 (要求ブロック数)", 3, 10, 1, this.headGap, (value) => {
          this.headGap = value;
          this.build();
        }),
      );
      params.appendChild(
        ui.toggle("空きスロットを含める", this.emptySlots, (v) => {
          this.emptySlots = v;
          this.build();
        }),
      );
      container.appendChild(params);
    },
  };

  P2P.scenes.reqresp = scene;
})();
