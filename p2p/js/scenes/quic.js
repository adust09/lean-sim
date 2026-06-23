/*
 * quic.js — Section 5.3: The transport layer (QUIC).
 *
 * Two animated comparisons:
 *   - Head-of-line blocking (Figure 5.11): one lost packet stalls every
 *     multiplexed stream under TCP, but only the affected stream under QUIC.
 *   - Connection establishment latency (Figure 5.12): TCP+TLS (legacy contrast)
 *     vs QUIC 1-RTT — the transport Lean Consensus actually uses. 0-RTT is
 *     omitted: the leanSpec reference disables early data / session resumption
 *     (early_data_accepted=False), so 1-RTT is the canonical handshake.
 *
 * Press リプレイ to restart the animation; toggle パケットロス to remove A#3.
 */
"use strict";

(function registerQuic() {
  const { util, draw, colors } = P2P;

  const ONE_WAY = 1.0; // simulated seconds for a single trip (= 0.5 RTT).
  const LOST_RETRANSMIT_DELAY = 2.4; // detection timeout before resend.

  const scene = {
    id: "quic",
    title: "QUIC トランスポート",
    sectionRef: "5.3",
    descriptionHTML: `
      <p><b>QUIC は UDP 上の信頼性つきトランスポート。</b>TCP と同じ保証(順序・再送・輻輳制御)を
      ユーザ空間で提供しつつ、TCP の構造的な弱点を取り除く。</p>
      <p><b>① Head-of-Line ブロッキング:</b> TCP は接続全体が「1本の順序付きバイト列」。
      あるパケットが落ちると、後続が全ストリーム分まとめて止まる(配信待ち)。
      QUIC はストリームをトランスポートの第一級要素にし、損失を <i>そのストリームだけ</i> に隔離する。
      → 下のアニメで A#3 を落とすと、TCP は B も止まるが QUIC は B が止まらない。</p>
      <p><b>② 接続確立の RTT:</b> TCP+TLS1.3 はハンドシェイクが層状に積み重なり数 RTT かかる(比較用)。
      <b>Lean Consensus は QUIC をそのまま採用</b>し、TLS1.3 を統合した <b>1-RTT</b> でハンドシェイクを終える
      — これが本線の唯一のトランスポート。(QUIC 一般の 0-RTT=セッション再開は、leanSpec 参照実装では
      early data を無効化しており本線では使わない。)</p>
      <p>(QUIC はさらに Connection ID による経路移行、既定で認証・暗号化、という利点も持つ — 5.3.2)</p>
      <p><b>操作:</b> 上のボタンで2つの比較を切り替え。リプレイで再生。</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    view: "hol", // 'hol' | 'rtt'
    clock: 0,
    speed: 1,
    lossEnabled: true,
    holPackets: [],
    rttLanes: [],

    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.replay();
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    replay() {
      this.clock = 0;
      if (this.view === "hol") this.buildHol();
      else this.buildRtt();
    },

    /* ------------------------- HOL scenario ------------------------- */
    buildHol() {
      // Interleaved send schedule across two streams; A#3 is the lost one.
      const schedule = [
        ["A", 1, 0.0],
        ["B", 1, 0.3],
        ["A", 2, 0.6],
        ["B", 2, 0.9],
        ["A", 3, 1.2],
        ["B", 3, 1.5],
        ["A", 4, 1.8],
        ["B", 4, 2.1],
      ];
      const packets = [];
      let sendOrder = 0;
      for (const [stream, seq, sendTime] of schedule) {
        const lost = this.lossEnabled && stream === "A" && seq === 3;
        packets.push({
          stream,
          seq,
          sendTime,
          arriveTime: sendTime + ONE_WAY,
          lost,
          retransmitSendTime: lost ? sendTime + LOST_RETRANSMIT_DELAY : null,
          retransmitArriveTime: lost ? sendTime + LOST_RETRANSMIT_DELAY + ONE_WAY : null,
          sendOrder: sendOrder++,
        });
      }
      this.holPackets = packets;
    },

    /** Effective arrival time accounting for a possible retransmit. */
    effectiveArrive(packet) {
      if (!packet.lost) return packet.arriveTime;
      return packet.retransmitArriveTime;
    },

    /* TCP delivers in global send order; QUIC delivers per stream in seq. */
    computeHolDelivery() {
      const arrived = (packet) => this.clock >= this.effectiveArrive(packet);

      // QUIC: independent per-stream prefix delivery.
      const quicDelivered = new Set();
      for (const stream of ["A", "B"]) {
        const ordered = this.holPackets
          .filter((p) => p.stream === stream)
          .sort((a, b) => a.seq - b.seq);
        for (const packet of ordered) {
          if (arrived(packet)) quicDelivered.add(packet);
          else break;
        }
      }

      // TCP: single ordered byte stream -> prefix over global send order.
      const tcpDelivered = new Set();
      const bySendOrder = this.holPackets.slice().sort((a, b) => a.sendOrder - b.sendOrder);
      for (const packet of bySendOrder) {
        if (arrived(packet)) tcpDelivered.add(packet);
        else break;
      }
      return { quicDelivered, tcpDelivered };
    },

    /* ------------------------- RTT scenario ------------------------- */
    buildRtt() {
      // Each message: t in one-way units, dir 1 = client->server, -1 = server->client.
      // Lean Consensus uses QUIC (TLS 1.3 integrated) as its sole transport — a
      // 1-RTT handshake. TCP+TLS is shown only as the legacy contrast; 0-RTT is
      // omitted because the leanSpec reference disables early data / session
      // resumption (early_data_accepted=False) to avoid replay.
      this.rttLanes = [
        {
          title: "TCP + TLS 1.3",
          subtitle: "比較用 — Lean Consensus では不採用",
          color: colors.prune,
          adopted: false,
          messages: [
            { t: 0, dir: 1, label: "SYN" },
            { t: 1, dir: -1, label: "SYN-ACK" },
            { t: 2, dir: 1, label: "ACK" },
            { t: 2, dir: 1, label: "ClientHello" },
            { t: 3, dir: -1, label: "ServerHello" },
            { t: 4, dir: 1, label: "Finished" },
          ],
          firstData: 5,
          rtt: 3,
        },
        {
          title: "QUIC (1-RTT)",
          subtitle: "Lean Consensus の採用トランスポート",
          color: colors.graft,
          adopted: true,
          messages: [
            { t: 0, dir: 1, label: "Initial + ClientHello" },
            { t: 1, dir: -1, label: "ServerHello + Finished" },
            { t: 2, dir: 1, label: "Finished" },
          ],
          firstData: 2,
          rtt: 1,
        },
      ];
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      this.clock += realDt * this.speed;
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      if (this.view === "hol") this.renderHol(ctx);
      else this.renderRtt(ctx);
    },

    /* ---- HOL rendering ---- */
    renderHol(ctx) {
      const delivery = this.computeHolDelivery();
      const panelHeight = (this.height - 40) / 2;
      this.renderHolStack(ctx, "TCP + 多重化", 20, panelHeight, delivery.tcpDelivered, true);
      this.renderHolStack(ctx, "QUIC", 30 + panelHeight, panelHeight, delivery.quicDelivered, false);
    },

    renderHolStack(ctx, title, top, height, delivered, isTcp) {
      const left = 150;
      const right = this.width - 230;
      const rowA = top + height * 0.36;
      const rowB = top + height * 0.68;

      // Panel background.
      ctx.save();
      draw.roundedRect(ctx, 12, top, this.width - 24, height - 6, 10);
      ctx.fillStyle = colors.panel;
      ctx.fill();
      ctx.restore();

      draw.label(ctx, title, 24, top + 20, colors.text, "bold 14px ui-monospace, monospace", "left");
      draw.label(ctx, "送信", left - 6, top + 20, colors.textDim, "11px ui-monospace, monospace", "right");
      draw.label(ctx, "受信(アプリ配信)", right + 6, top + 20, colors.textDim, "11px ui-monospace, monospace", "left");

      // Lane baselines.
      for (const [y, name] of [
        [rowA, "Stream A"],
        [rowB, "Stream B"],
      ]) {
        draw.line(ctx, left, y, right, y, colors.grid, 1, false);
        draw.label(ctx, name, left - 10, y, colors.textDim, "11px ui-monospace, monospace", "right");
      }

      const deliveredCount = delivered.size;
      let blockedNote = "";
      for (const packet of this.holPackets) {
        const y = packet.stream === "A" ? rowA : rowB;
        this.renderHolPacket(ctx, packet, left, right, y, delivered, isTcp);
      }

      // Delivery counter and explanatory note.
      draw.label(
        ctx,
        `アプリ配信: ${deliveredCount} / ${this.holPackets.length}`,
        right + 6,
        top + height - 26,
        colors.text,
        "12px ui-monospace, monospace",
        "left",
      );
      if (isTcp && this.lossEnabled) {
        const tcpBlocked = this.holPackets.length - deliveredCount > 0 && this.clock > 2.5;
        blockedNote = tcpBlocked ? "← A#3 の損失で後続が全て待たされる (HOL)" : "";
      } else if (!isTcp && this.lossEnabled) {
        blockedNote = "← B は A#3 の損失に影響されない";
      }
      if (blockedNote) {
        draw.label(
          ctx,
          blockedNote,
          left,
          top + height - 26,
          isTcp ? colors.prune : colors.nodeHasMessage,
          "12px ui-monospace, monospace",
          "left",
        );
      }
    },

    renderHolPacket(ctx, packet, left, right, y, delivered, isTcp) {
      const isDelivered = delivered.has(packet);
      const color = packet.stream === "A" ? colors.accent : colors.nodeHasMessage;
      const boxColor = packet.lost ? colors.prune : color;

      // Original transmission travel.
      const travelFraction = util.clamp((this.clock - packet.sendTime) / ONE_WAY, 0, 1);
      const inFlight = this.clock >= packet.sendTime && this.clock < packet.arriveTime;
      const hasArrived = this.clock >= packet.arriveTime;

      if (packet.lost) {
        if (inFlight) {
          const x = util.lerp(left, right, travelFraction);
          this.drawPacketBox(ctx, x, y, packet, colors.prune, 0.9);
        } else if (hasArrived && this.clock < (packet.retransmitSendTime || Infinity)) {
          // Show the loss burst at the receiver edge.
          draw.label(ctx, "✗ lost", right - 8, y - 16, colors.prune, "12px ui-monospace, monospace", "right");
        }
        // Retransmitted copy.
        if (this.clock >= packet.retransmitSendTime) {
          const rf = util.clamp((this.clock - packet.retransmitSendTime) / ONE_WAY, 0, 1);
          if (rf < 1) {
            const x = util.lerp(left, right, rf);
            this.drawPacketBox(ctx, x, y, packet, colors.iwant, 0.95, true);
          }
        }
      } else if (inFlight) {
        const x = util.lerp(left, right, travelFraction);
        this.drawPacketBox(ctx, x, y, packet, boxColor, 0.95);
      }

      // At the receiver: delivered (solid) vs buffered-but-blocked (faded amber).
      if (hasArrived || (packet.lost && this.clock >= packet.retransmitArriveTime)) {
        const slotX = right + 24 + (packet.seq - 1) * 30;
        if (isDelivered) {
          this.drawPacketBox(ctx, slotX, y, packet, boxColor, 1);
        } else {
          // Arrived but stuck in the reorder buffer (TCP behind the loss).
          this.drawPacketBox(ctx, slotX, y, packet, colors.iwant, 0.4);
        }
      }
    },

    drawPacketBox(ctx, x, y, packet, color, alpha, dashed) {
      ctx.save();
      ctx.globalAlpha = alpha;
      draw.roundedRect(ctx, x - 12, y - 10, 24, 20, 4);
      ctx.fillStyle = color + "33";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.restore();
      draw.label(ctx, packet.stream + packet.seq, x, y, color, "11px ui-monospace, monospace");
    },

    /* ---- RTT rendering ---- */
    renderRtt(ctx) {
      const laneWidth = (this.width - 40) / this.rttLanes.length;
      this.rttLanes.forEach((lane, laneIndex) => {
        const x0 = 20 + laneIndex * laneWidth;
        this.renderRttLane(ctx, lane, x0, laneWidth);
      });
      draw.label(
        ctx,
        "縦軸 = 時間(下方向)。各矢印が 1 トリップ(0.5 RTT)。緑のラインが「最初のアプリデータ」。",
        this.width / 2,
        this.height - 16,
        colors.textDim,
        "12px ui-monospace, monospace",
      );
    },

    renderRttLane(ctx, lane, x0, laneWidth) {
      const clientX = x0 + laneWidth * 0.22;
      const serverX = x0 + laneWidth * 0.78;
      const top = 80;
      const unitHeight = (this.height - 160) / 6;

      // Panel + title. The adopted (QUIC) lane gets a highlighted border + ★ badge.
      ctx.save();
      draw.roundedRect(ctx, x0 + 6, 16, laneWidth - 12, this.height - 60, 10);
      ctx.fillStyle = lane.adopted ? "#10202b" : colors.panel;
      ctx.fill();
      if (lane.adopted) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = lane.color;
        ctx.stroke();
      }
      ctx.restore();
      const badge = lane.adopted ? "★ " : "";
      draw.label(ctx, badge + lane.title, x0 + laneWidth / 2, 34, lane.color, "bold 14px ui-monospace, monospace");
      draw.label(ctx, `handshake: ${lane.rtt}-RTT`, x0 + laneWidth / 2, 50, colors.textDim, "11px ui-monospace, monospace");
      draw.label(ctx, lane.subtitle, x0 + laneWidth / 2, 66, lane.adopted ? lane.color : colors.textDim, "11px ui-monospace, monospace");

      // Client / server vertical lines.
      draw.line(ctx, clientX, top, clientX, this.height - 50, colors.grid, 1.4, false);
      draw.line(ctx, serverX, top, serverX, this.height - 50, colors.grid, 1.4, false);
      draw.label(ctx, "Client", clientX, top - 8, colors.textDim, "11px ui-monospace, monospace");
      draw.label(ctx, "Server", serverX, top - 8, colors.textDim, "11px ui-monospace, monospace");

      // Messages, revealed progressively by the clock.
      for (const message of lane.messages) {
        const startTime = message.t;
        if (this.clock < startTime) continue;
        const fromX = message.dir === 1 ? clientX : serverX;
        const toX = message.dir === 1 ? serverX : clientX;
        const yStart = top + startTime * unitHeight;
        const yEnd = top + (startTime + 1) * unitHeight;
        const fraction = util.clamp(this.clock - startTime, 0, 1);
        const x = util.lerp(fromX, toX, fraction);
        const y = util.lerp(yStart, yEnd, fraction);
        draw.line(ctx, fromX, yStart, x, y, lane.color, 1.8, false);
        draw.disc(ctx, x, y, 3.5, lane.color, null);
        if (fraction > 0.15) {
          draw.label(ctx, message.label, (fromX + toX) / 2, yStart - 7, colors.textDim, "10px ui-monospace, monospace");
        }
      }

      // First application data marker.
      if (this.clock >= lane.firstData) {
        const y = top + lane.firstData * unitHeight;
        draw.line(ctx, x0 + 12, y, x0 + laneWidth - 12, y, colors.nodeHasMessage, 2, true);
        draw.label(ctx, "▼ 最初のアプリデータ", x0 + laneWidth / 2, y + 12, colors.nodeHasMessage, "11px ui-monospace, monospace");
      }
    },

    onMouse() {},

    /* ------------------------- stats ------------------------- */
    getStats() {
      if (this.view === "hol") {
        const delivery = this.computeHolDelivery();
        return [
          { label: "表示", value: "HOL ブロッキング" },
          { label: "経過 (one-way)", value: this.clock.toFixed(1) },
          { label: "TCP アプリ配信", value: `${delivery.tcpDelivered.size} / 8` },
          { label: "QUIC アプリ配信", value: `${delivery.quicDelivered.size} / 8` },
          { label: "パケットロス", value: this.lossEnabled ? "A#3 を損失" : "なし" },
        ];
      }
      return [
        { label: "表示", value: "ハンドシェイク RTT" },
        { label: "経過 (one-way)", value: this.clock.toFixed(1) },
        { label: "採用 (Lean Consensus)", value: "QUIC 1-RTT" },
        { label: "比較: TCP+TLS", value: "3-RTT" },
        { label: "0-RTT", value: "無効 (early data 不使用)" },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;
      const viewGroup = ui.group("比較を選択");
      const holButton = ui.button("① HOL ブロッキング", () => {
        this.view = "hol";
        this.replay();
      }, "primary");
      const rttButton = ui.button("② ハンドシェイク RTT", () => {
        this.view = "rtt";
        this.replay();
      });
      viewGroup.appendChild(holButton);
      viewGroup.appendChild(rttButton);
      container.appendChild(viewGroup);

      const actions = ui.group("再生");
      actions.appendChild(ui.button("リプレイ ↻", () => this.replay(), "primary"));
      actions.appendChild(
        ui.slider("再生速度 x", 0.25, 3, 0.25, this.speed, (value) => (this.speed = value)),
      );
      actions.appendChild(
        ui.toggle("パケットロスを発生 (A#3)", this.lossEnabled, (v) => {
          this.lossEnabled = v;
          if (this.view === "hol") this.replay();
        }),
      );
      container.appendChild(actions);
    },
  };

  P2P.scenes.quic = scene;
})();
