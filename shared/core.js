/*
 * core.js — shared utilities, math, colors, and drawing helpers.
 *
 * Loaded as a classic script (no ES modules) so the simulator runs directly
 * from a file:// URL without a build step or a local web server. Everything is
 * attached to the global `P2P` namespace; scene files extend `P2P.scenes`.
 */
"use strict";

const P2P = (window.P2P = window.P2P || { scenes: {} });

/* ------------------------------------------------------------------ */
/* Color palette (dark theme tuned for network graphs).               */
/* ------------------------------------------------------------------ */
P2P.colors = {
  background: "#0c1018",
  panel: "#141b27",
  grid: "#1c2636",
  node: "#3a4a63",
  nodeStroke: "#5a7299",
  nodeHasMessage: "#36d399",
  nodeSource: "#fbbf24",
  nodeTarget: "#f87171",
  nodeActive: "#60a5fa",
  nodeDead: "#3a2530",
  meshEdge: "#36d39955",
  peerEdge: "#2a3852",
  data: "#36d399",
  ihave: "#a78bfa",
  iwant: "#f59e0b",
  graft: "#22d3ee",
  prune: "#fb7185",
  text: "#e6edf6",
  textDim: "#8da2bd",
  accent: "#60a5fa",
};

/* ------------------------------------------------------------------ */
/* Small math / collection utilities.                                 */
/* ------------------------------------------------------------------ */
P2P.util = {
  clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  },

  lerp(start, end, fraction) {
    return start + (end - start) * fraction;
  },

  distance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /** Deterministic seeded RNG (mulberry32) so layouts are reproducible. */
  makeRng(seed) {
    let state = seed >>> 0;
    return function next() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  randomInt(rng, lowInclusive, highExclusive) {
    return lowInclusive + Math.floor(rng() * (highExclusive - lowInclusive));
  },

  pickRandom(rng, array) {
    return array[Math.floor(rng() * array.length)];
  },

  shuffleInPlace(rng, array) {
    for (let index = array.length - 1; index > 0; index--) {
      const swapWith = Math.floor(rng() * (index + 1));
      const temporary = array[index];
      array[index] = array[swapWith];
      array[swapWith] = temporary;
    }
    return array;
  },

  /** Number of leading zero bits of `value` within a `width`-bit field. */
  leadingZeroBits(value, width) {
    for (let position = width - 1; position >= 0; position--) {
      if ((value >> position) & 1) return width - 1 - position;
    }
    return width;
  },

  /** Render an integer node id as a fixed-width binary string. */
  toBinary(value, width) {
    let bits = "";
    for (let position = width - 1; position >= 0; position--) {
      bits += (value >> position) & 1;
    }
    return bits;
  },

  /** Render an integer as a short hex tag, e.g. 0x4f. */
  toHexTag(value, hexDigits) {
    return "0x" + value.toString(16).padStart(hexDigits, "0");
  },
};

/* ------------------------------------------------------------------ */
/* Canvas drawing helpers shared across scenes.                       */
/* ------------------------------------------------------------------ */
P2P.draw = {
  clear(ctx, width, height) {
    ctx.fillStyle = P2P.colors.background;
    ctx.fillRect(0, 0, width, height);
  },

  roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  },

  line(ctx, ax, ay, bx, by, color, lineWidth, dashed) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth || 1;
    if (dashed) ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  },

  arrow(ctx, ax, ay, bx, by, color, lineWidth) {
    const angle = Math.atan2(by - ay, bx - ax);
    const headLength = 9;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth || 1.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(
      bx - headLength * Math.cos(angle - Math.PI / 7),
      by - headLength * Math.sin(angle - Math.PI / 7),
    );
    ctx.lineTo(
      bx - headLength * Math.cos(angle + Math.PI / 7),
      by - headLength * Math.sin(angle + Math.PI / 7),
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  disc(ctx, x, y, radius, fill, stroke, strokeWidth) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = strokeWidth || 1.5;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  },

  /** A soft glow ring used to highlight active nodes. */
  glow(ctx, x, y, radius, color) {
    ctx.save();
    const gradient = ctx.createRadialGradient(x, y, radius * 0.4, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  label(ctx, text, x, y, color, font, align) {
    ctx.save();
    ctx.fillStyle = color || P2P.colors.text;
    ctx.font = font || "12px ui-monospace, monospace";
    ctx.textAlign = align || "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  },
};

/* ------------------------------------------------------------------ */
/* DOM control factory shared by scene control panels.                */
/* ------------------------------------------------------------------ */
P2P.ui = {
  button(label, onClick, variant) {
    const element = document.createElement("button");
    element.className = "ctl-button" + (variant ? " " + variant : "");
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  },

  toggle(label, initialValue, onChange) {
    const wrapper = document.createElement("label");
    wrapper.className = "ctl-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = initialValue;
    input.addEventListener("change", () => onChange(input.checked));
    const span = document.createElement("span");
    span.textContent = label;
    wrapper.appendChild(input);
    wrapper.appendChild(span);
    return wrapper;
  },

  /** A labelled range slider with a live value read-out. */
  slider(label, min, max, step, value, onInput) {
    const wrapper = document.createElement("div");
    wrapper.className = "ctl-slider";
    const head = document.createElement("div");
    head.className = "ctl-slider-head";
    const name = document.createElement("span");
    name.textContent = label;
    const readout = document.createElement("span");
    readout.className = "ctl-slider-value";
    readout.textContent = value;
    head.appendChild(name);
    head.appendChild(readout);
    const input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener("input", () => {
      readout.textContent = input.value;
      onInput(parseFloat(input.value));
    });
    wrapper.appendChild(head);
    wrapper.appendChild(input);
    return wrapper;
  },

  /** A titled group of related controls. */
  group(title) {
    const section = document.createElement("div");
    section.className = "ctl-group";
    if (title) {
      const heading = document.createElement("div");
      heading.className = "ctl-group-title";
      heading.textContent = title;
      section.appendChild(heading);
    }
    return section;
  },
};

/* ------------------------------------------------------------------ */
/* Easing curves for animated message particles.                      */
/* ------------------------------------------------------------------ */
P2P.ease = {
  inOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  outCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  },
};
