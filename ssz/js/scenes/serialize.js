/*
 * serialize.js — Section 2.3: SSZ serialization mechanics and offsets.
 *
 * Visualizes the fixed/variable split layout using a ValidatorRecord example:
 *   - id: uint16 (2 bytes, fixed)
 *   - signatures: List (variable length, replaced by 4-byte offset pointer)
 *   - pubkey: bytes48 (48 bytes, fixed)
 *
 * Fixed part = 54 bytes. The offset pointer value = 54 (points to variable part start).
 * Key insight: pubkey stays at a FIXED byte position regardless of list length
 * because the list is represented by a fixed 4-byte offset in the fixed part.
 *
 * Also demonstrates:
 *   - Little-endian byte encoding of uint16 and uint32
 *   - Bitlist sentinel bit mechanics (§2.3.2)
 *   - Invalid serialization cases (§2.3.3)
 */
"use strict";

(function registerSerialize() {
  const { draw, colors } = P2P;

  const BYTES_PER_SIGNATURE = 4;
  const FIXED_PART_BYTES = 54; // id(2) + offset(4) + pubkey(48)
  const ID_HEX_BYTES = [0x2a, 0x00];
  const OFFSET_VALUE = 54;

  // The 5 data bits shown in the Bitlist example.
  const BITLIST_EXAMPLE_DATA_BITS = [1, 0, 1, 0, 1];

  // Invalid serialization modes (§2.3.3).
  const INVALID_MODES = ["なし (正常)", "オフセット範囲外", "ヒープ間のギャップ", "末尾の余分バイト"];

  const scene = {
    id: "serialize",
    title: "シリアライズ",
    sectionRef: "2.3",
    descriptionHTML: `
      <p><b>SSZ の固定／可変分割レイアウト (§2.3)</b></p>
      <p>固定サイズのフィールドはそのままインライン格納。
      可変長フィールドは実データを末尾の<b>可変部</b>に置き、
      固定部には 4 バイトの<b>オフセット</b>ポインタだけを残す。</p>
      <p>例: <code>ValidatorRecord { id: uint16, signatures: List, pubkey: bytes48 }</code><br>
      固定部 = id(2B) + offset(4B) + pubkey(48B) = <b>54 バイト</b><br>
      offset の値 = 54 → 可変部の先頭アドレスを指す。</p>
      <p><b>ポイント:</b> リストの長さが変わっても pubkey の位置は常に固定 (byte 6〜53)。
      可変部が増減するのは offset が指す先だけ。</p>
      <p><b>リトルエンディアン:</b> 整数は最下位バイトから先に並ぶ。
      id=42 → <code>0x2a 0x00</code>、offset=54 → <code>0x36 0x00 0x00 0x00</code>。</p>
      <p><b>Bitlist センチネルビット (§2.3.2):</b>
      データビットの後に <code>1</code> を付加してバイト列に詰める。
      デシリアライザは最上位の 1 を見つけてリスト長を復元する。</p>`,

    /* ----------------------- state ----------------------- */
    width: 0,
    height: 0,
    signatureCount: 2,
    showLittleEndian: false,
    invalidModeIndex: 0,

    init(env) {
      this.width = env.width;
      this.height = env.height;
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
    },

    update(_realDt) {},

    /* ----------------------- derived values ----------------------- */
    variablePartBytes() {
      return this.signatureCount * BYTES_PER_SIGNATURE;
    },

    totalBytes() {
      return FIXED_PART_BYTES + this.variablePartBytes();
    },

    offsetBytes() {
      // In the invalid "offset out of bounds" case, make the offset obviously wrong.
      if (this.invalidModeIndex === 1) return [0xff, 0xff, 0x00, 0x00];
      return [
        OFFSET_VALUE & 0xff,
        (OFFSET_VALUE >> 8) & 0xff,
        (OFFSET_VALUE >> 16) & 0xff,
        (OFFSET_VALUE >> 24) & 0xff,
      ];
    },

    /* ----------------------- rendering ----------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderByteStrip(ctx);
      this.renderBitlistPanel(ctx);
      this.renderInvalidBanner(ctx);
    },

    renderByteStrip(ctx) {
      const stripTop = this.height * 0.17;
      const stripHeight = 44;
      const availableWidth = this.width - 40;
      const totalBytesCount = this.totalBytes();

      // Compute a pixel scale: how wide is each byte box?
      // Fixed part is 54 bytes, variable part is signatureCount * 4 bytes.
      // We draw boxes proportionally but clamp minimum box width to 8px.
      const rawScale = availableWidth / Math.max(totalBytesCount, 10);
      const byteBoxWidth = Math.max(8, Math.min(28, rawScale));

      const fixedPixelWidth = FIXED_PART_BYTES * byteBoxWidth;
      const variablePixelWidth = this.variablePartBytes() * byteBoxWidth;
      const startX = (this.width - fixedPixelWidth - variablePixelWidth) / 2;
      const variableStartX = startX + fixedPixelWidth;

      // --- Draw section labels ---
      draw.label(
        ctx,
        `固定部 (Fixed Part) — ${FIXED_PART_BYTES} バイト`,
        startX + fixedPixelWidth / 2,
        stripTop - 24,
        colors.accent,
        "bold 12px ui-monospace, monospace",
      );
      if (this.variablePartBytes() > 0) {
        draw.label(
          ctx,
          `可変部 (Variable Part) — ${this.variablePartBytes()} バイト`,
          variableStartX + variablePixelWidth / 2,
          stripTop - 24,
          colors.nodeHasMessage,
          "bold 12px ui-monospace, monospace",
        );
      }

      // Draw separator line between fixed and variable parts.
      const separatorX = variableStartX;
      draw.line(ctx, separatorX, stripTop - 14, separatorX, stripTop + stripHeight + 14, colors.textDim, 1.5, true);

      // --- Draw the three field segments ---
      this.drawFieldSegment(ctx, startX, stripTop, byteBoxWidth * 2, stripHeight,
        "id", "uint16", 2, colors.nodeSource, colors.nodeSource + "33",
        this.showLittleEndian ? ID_HEX_BYTES : null);

      const offsetStartX = startX + byteBoxWidth * 2;
      const offsetBytes = this.offsetBytes();
      const offsetColor = this.invalidModeIndex === 1 ? colors.nodeTarget : colors.accent;
      this.drawFieldSegment(ctx, offsetStartX, stripTop, byteBoxWidth * 4, stripHeight,
        "offset", "uint32", 4, offsetColor, offsetColor + "33",
        this.showLittleEndian ? offsetBytes : null);

      const pubkeyStartX = offsetStartX + byteBoxWidth * 4;
      this.drawFieldSegment(ctx, pubkeyStartX, stripTop, byteBoxWidth * 48, stripHeight,
        "pubkey", "bytes48", 48, colors.ihave, colors.ihave + "33",
        null);

      // Variable part: signature bytes.
      if (this.variablePartBytes() > 0) {
        const signatureColor =
          this.invalidModeIndex === 2 ? colors.nodeTarget :
          this.invalidModeIndex === 3 ? colors.nodeTarget :
          colors.nodeHasMessage;

        this.drawFieldSegment(ctx, variableStartX, stripTop, variablePixelWidth, stripHeight,
          "signatures",
          `List[bytes4 × ${this.signatureCount}]`,
          this.variablePartBytes(),
          signatureColor, signatureColor + "22",
          null);
      }

      // --- Offset arrow from offset box to variable part start ---
      const offsetBoxCenterX = offsetStartX + byteBoxWidth * 2;
      const arrowFromY = stripTop + stripHeight + 8;
      const arrowTargetX = variableStartX;

      if (this.variablePartBytes() > 0 || this.invalidModeIndex === 1) {
        ctx.save();
        ctx.strokeStyle = colors.accent + "cc";
        ctx.fillStyle = colors.accent + "cc";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(offsetBoxCenterX, arrowFromY);
        ctx.lineTo(offsetBoxCenterX, arrowFromY + 22);
        ctx.lineTo(arrowTargetX, arrowFromY + 22);
        ctx.stroke();
        ctx.setLineDash([]);
        // Arrowhead pointing up into the variable region.
        ctx.beginPath();
        ctx.moveTo(arrowTargetX, arrowFromY + 22);
        ctx.lineTo(arrowTargetX - 6, arrowFromY + 30);
        ctx.lineTo(arrowTargetX + 6, arrowFromY + 30);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        draw.label(
          ctx,
          `offset = ${OFFSET_VALUE} → ここへジャンプ`,
          (offsetBoxCenterX + arrowTargetX) / 2,
          arrowFromY + 22,
          colors.accent,
          "11px ui-monospace, monospace",
        );
      }

      // --- Total length label ---
      draw.label(
        ctx,
        `合計 ${this.totalBytes()} バイト`,
        this.width / 2,
        stripTop + stripHeight + 56,
        colors.text,
        "13px ui-monospace, monospace",
      );

      // --- Little-endian byte hex display ---
      if (this.showLittleEndian) {
        const hexY = stripTop + stripHeight + 80;
        draw.label(ctx, "id = 42:", startX, hexY, colors.nodeSource, "11px ui-monospace, monospace", "left");
        draw.label(ctx, "0x2a 0x00", startX + 56, hexY, colors.nodeSource + "cc", "11px ui-monospace, monospace", "left");
        draw.label(ctx, "offset = 54:", startX, hexY + 18, colors.accent, "11px ui-monospace, monospace", "left");
        draw.label(
          ctx,
          this.invalidModeIndex === 1 ? "0xff 0xff 0x00 0x00  ← 範囲外！" : "0x36 0x00 0x00 0x00",
          startX + 88,
          hexY + 18,
          this.invalidModeIndex === 1 ? colors.nodeTarget : colors.accent + "cc",
          "11px ui-monospace, monospace",
          "left",
        );
      }
    },

    drawFieldSegment(ctx, x, y, pixelWidth, height, fieldName, typeName, byteCount, borderColor, fillColor, hexBytes) {
      const labelInside = pixelWidth > 30;
      ctx.save();
      draw.roundedRect(ctx, x, y, pixelWidth, height, 5);
      ctx.fillStyle = fillColor || colors.panel;
      ctx.fill();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();

      if (labelInside) {
        draw.label(ctx, fieldName, x + pixelWidth / 2, y + 13, colors.text, "bold 11px ui-monospace, monospace");
        draw.label(ctx, typeName, x + pixelWidth / 2, y + 28, colors.textDim, "9px ui-monospace, monospace");
      } else {
        // Draw label above the box when it is too narrow.
        draw.label(ctx, fieldName, x + pixelWidth / 2, y - 8, borderColor, "10px ui-monospace, monospace");
      }

      // Byte count annotation below field.
      if (pixelWidth > 16) {
        draw.label(
          ctx,
          byteCount + "B",
          x + pixelWidth / 2,
          y + height + 10,
          colors.textDim,
          "9px ui-monospace, monospace",
        );
      }

      // Hex bytes overlay (little-endian mode).
      if (hexBytes && pixelWidth > 40) {
        const hexString = hexBytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(" ");
        draw.label(ctx, hexString, x + pixelWidth / 2, y + height - 8, borderColor, "9px ui-monospace, monospace");
      }
    },

    renderBitlistPanel(ctx) {
      const panelX = 20;
      const panelY = this.height * 0.61;
      const panelWidth = Math.min(480, this.width - 40);
      const panelHeight = 110;

      ctx.save();
      draw.roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 8);
      ctx.fillStyle = "#0e1420dd";
      ctx.fill();
      ctx.restore();

      draw.label(
        ctx,
        "Bitlist センチネルビット (§2.3.2)",
        panelX + panelWidth / 2,
        panelY + 16,
        colors.textDim,
        "bold 12px ui-monospace, monospace",
      );

      const dataBits = BITLIST_EXAMPLE_DATA_BITS;
      const allBits = [...dataBits, 1]; // append sentinel 1
      const bitCellWidth = 22;
      const bitCellHeight = 26;
      const bitsRowY = panelY + 40;
      const startBitX = panelX + 16;

      for (let bitIndex = 0; bitIndex < allBits.length; bitIndex++) {
        const bitValue = allBits[bitIndex];
        const isSentinel = bitIndex === dataBits.length;
        const bitX = startBitX + bitIndex * (bitCellWidth + 4);
        const bitColor = isSentinel ? colors.nodeHasMessage : colors.accent;

        ctx.save();
        draw.roundedRect(ctx, bitX, bitsRowY - bitCellHeight / 2, bitCellWidth, bitCellHeight, 4);
        ctx.fillStyle = bitColor + "22";
        ctx.fill();
        ctx.strokeStyle = bitColor;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();

        draw.label(ctx, String(bitValue), bitX + bitCellWidth / 2, bitsRowY, bitColor, "bold 13px ui-monospace, monospace");
        draw.label(
          ctx,
          isSentinel ? "⬆ sentinel" : `b${bitIndex}`,
          bitX + bitCellWidth / 2,
          bitsRowY + 18,
          isSentinel ? colors.nodeHasMessage : colors.textDim,
          "9px ui-monospace, monospace",
        );
      }

      // Show packed byte.
      const packedBit = [...allBits].reverse();
      while (packedBit.length < 8) packedBit.push(0);
      const packedByte = packedBit.reduce((acc, bit, i) => acc | (bit << i), 0);
      const packedBitsLabel = startBitX + allBits.length * (bitCellWidth + 4) + 12;

      draw.label(ctx, "→", packedBitsLabel, bitsRowY, colors.textDim, "14px ui-monospace, monospace");
      draw.label(
        ctx,
        `byte = 0x${packedByte.toString(16).padStart(2, "0")}`,
        packedBitsLabel + 20,
        bitsRowY,
        colors.nodeHasMessage,
        "12px ui-monospace, monospace",
        "left",
      );

      draw.label(
        ctx,
        "デシリアライズ: 最上位の 1 (sentinel) を探す → それより下がデータ長",
        panelX + panelWidth / 2,
        panelY + panelHeight - 10,
        colors.textDim,
        "10px ui-monospace, monospace",
      );
    },

    renderInvalidBanner(ctx) {
      if (this.invalidModeIndex === 0) return;
      const bannerY = this.height * 0.86;
      const modeName = INVALID_MODES[this.invalidModeIndex];
      ctx.save();
      draw.roundedRect(ctx, 20, bannerY, this.width - 40, 36, 8);
      ctx.fillStyle = colors.nodeTarget + "22";
      ctx.fill();
      ctx.strokeStyle = colors.nodeTarget;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      draw.label(
        ctx,
        `不正な直列化 (§2.3.3): ${modeName}`,
        this.width / 2,
        bannerY + 18,
        colors.nodeTarget,
        "bold 12px ui-monospace, monospace",
      );
    },

    onMouse() {},

    /* ----------------------- stats ----------------------- */
    getStats() {
      return [
        { label: "シグネチャ数", value: this.signatureCount },
        { label: "固定部", value: `${FIXED_PART_BYTES} バイト` },
        { label: "可変部", value: `${this.variablePartBytes()} バイト` },
        { label: "合計", value: `${this.totalBytes()} バイト` },
        { label: "offset 値", value: `${OFFSET_VALUE} (0x${OFFSET_VALUE.toString(16)})` },
        { label: "不正モード", value: INVALID_MODES[this.invalidModeIndex] },
      ];
    },

    /* ----------------------- controls ----------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const fieldGroup = ui.group("ValidatorRecord フィールド");
      fieldGroup.appendChild(
        ui.slider("シグネチャ数 (可変部)", 0, 6, 1, this.signatureCount, (newCount) => {
          this.signatureCount = newCount;
        }),
      );
      container.appendChild(fieldGroup);

      const displayGroup = ui.group("表示オプション");
      displayGroup.appendChild(
        ui.toggle("リトルエンディアン表示", this.showLittleEndian, (checked) => {
          this.showLittleEndian = checked;
        }),
      );
      container.appendChild(displayGroup);

      const invalidGroup = ui.group("不正な直列化 (§2.3.3)");
      const invalidLabel = document.createElement("div");
      invalidLabel.style.cssText = "font-size:11px;color:#8da2bd;margin-bottom:6px;";
      invalidLabel.textContent = INVALID_MODES[this.invalidModeIndex];

      const cycleButton = ui.button("次の不正ケース →", () => {
        this.invalidModeIndex = (this.invalidModeIndex + 1) % INVALID_MODES.length;
        invalidLabel.textContent = INVALID_MODES[this.invalidModeIndex];
      });
      invalidGroup.appendChild(invalidLabel);
      invalidGroup.appendChild(cycleButton);
      container.appendChild(invalidGroup);
    },
  };

  P2P.scenes.serialize = scene;
})();
