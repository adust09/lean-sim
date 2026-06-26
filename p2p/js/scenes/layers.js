/*
 * layers.js — Section 5.1.3: committee / subnet / topic / peer の層分離.
 *
 * 認識しづらい「なぜ 64 subnet で 1M validator を捌けるのか」「なぜ 50〜100 ピア
 * しか持たないのに committee 全体と同期できるのか」を、4つの別レイヤーとして
 * 縦に積んで分離表示する:
 *   ① committee（論理グループ）  — 誰が一緒に投票するか（1委員会 ≈488）
 *   ② subnet = topic（購読チャネル）— subnet N ≡ topic "attestation_N"
 *   ③ topic chips（購読中の topic） — block / aggregation + 必要な subnet 数本
 *   ④ peer（物理接続）            — 固定の 50〜100 スロット
 *
 * 核心の気づき: 各 topic の mesh(≈8) は ④ の同じ物理ピア集合の *部分集合* を
 * 選び直すだけ。topic を増やしても物理接続(④)は増えず、mesh の延べ参加だけが
 * 増える。subnet topic を購読 / 解除して、④ のピア数が一定のまま ③ の mesh が
 * 増減する様子を確かめる。topic chip を選ぶと、その mesh がどの物理ピアを使うか、
 * そして vote がホップ転送で committee 全体へ届く様子が見える。
 */
"use strict";

(function registerLayers() {
  const { util, draw, colors, ease } = P2P;

  const MARGIN = 40;
  const SLOTS_PER_EPOCH = 32;
  const ATTESTATION_SUBNET_COUNT = 64;
  const SUBNETS_PER_NODE = 2; // backbone subscriptions (mainnet default).
  const MESH_DEGREE = 8; // gossipsub D.
  const FORK_DIGEST = "0x6a9c";

  // Topic colors keyed by role (mirrored in the 解説 color legend).
  const C_BLOCK = "#60a5fa";
  const C_AGG = "#fbbf24";
  const C_DUTY = "#36d399";
  const C_BACKBONE = "#a78bfa";
  const C_IDLE = "#3a4a63";

  const scene = {
    id: "layers",
    title: "レイヤー分離",
    sectionRef: "5.1",
    descriptionHTML: `
      <p><b>混同しやすい4つの「つながり」は別レイヤー。</b> 上から論理→物理へ積んで分離する。</p>
      <ul>
        <li><b>① committee</b>: 一緒に投票する論理グループ。1M validator なら 1スロット
        64委員会・各 <b>≈488</b>。</li>
        <li><b>② subnet = topic</b>: 票を流す gossipsub チャネル。<code>subnet N</code> は
        topic 文字列 <code>attestation_N</code> <i>そのもの</i>（比喩でなく文字どおり）。
        attestation subnet は <b>64本</b>。</li>
        <li><b>③ 購読 topic</b>: 常時購読の <code>block</code>/<code>aggregation</code> +
        必要な subnet 数本（義務 + バックボーン <code>SUBNETS_PER_NODE=2</code>）。64本全ては購読しない。</li>
        <li><b>④ peer（物理）</b>: 直接 P2P 接続。<b>50〜100 の固定スロット</b>。希少資源。</li>
      </ul>
      <p><b>核心:</b> 各 topic の mesh(≈8) は ④ の同じ物理ピアの<u>部分集合を選び直すだけ</u>。
      topic を増やしても ④ は増えず、増えるのは帯域(mesh 延べ参加)。委員会488人と直接接続は不要 ——
      topic を購読し、mesh を <b>ホップ転送</b>すれば票は全員に届く。</p>
      <p><b>64本で 1M を捌ける理由 = 時間スライス:</b> 各バリデータは1エポック(32スロット)に1回だけ
      義務。瞬間は各 subnet ≈488(委員会1個)、エポック累計で ≈15,625 = 1M/64。「1M/64」は
      <i>累計</i>であって同時数ではない。</p>
      <p><b>操作:</b></p>
      <ul>
        <li>② の subnet バーをクリック → 購読 / 解除。④ の物理ピア数は一定、③ の mesh だけ増減。</li>
        <li>③ の topic chip をクリック → その mesh が使う物理ピアを ④ で強調。</li>
        <li>「vote を発行」→ 選択 topic で you→peer→peer のホップ転送が委員会全体へ広がる。</li>
        <li>slot スライダ → committee↔subnet の対応がローテーション（時間スライス）。</li>
      </ul>
      <p><b>色凡例:</b><br>
      <span style="color:${C_BLOCK}">●</span> block (全員購読) &nbsp;
      <span style="color:${C_AGG}">●</span> aggregation (全員購読) &nbsp;
      <span style="color:${C_DUTY}">●</span> attestation: 義務 subnet &nbsp;
      <span style="color:${C_BACKBONE}">●</span> attestation: バックボーン &nbsp;
      <span style="color:${C_IDLE}">●</span> 非購読 subnet</p>`,

    /* ------------------------- state ------------------------- */
    width: 0,
    height: 0,
    rng: null,
    seed: 1,
    simTime: 0,

    topics: [], // ordered: block, aggregation, then 64 attestation subnets.
    peers: [], // fixed physical peer pool { nx, ny }.
    particles: [],

    // tunables (driven by controls)
    physicalPeerCount: 60,
    totalValidators: 1_000_000,
    slot: 0,

    selectedTopicKey: "att_5",
    hoverSubnetId: -1,

    bands: null,

    /* ------------------------- lifecycle ------------------------- */
    init(env) {
      this.width = env.width;
      this.height = env.height;
      this.build();
      this.computeLayout();
    },

    resize(width, height) {
      this.width = width;
      this.height = height;
      this.computeLayout();
    },

    /* ------------------------- construction ------------------------- */
    build() {
      this.rng = util.makeRng(this.seed * 2654435761);
      this.simTime = 0;
      this.particles = [];

      // Physical peer pool — a fixed cloud, independent of topic count.
      this.peers = [];
      for (let i = 0; i < this.physicalPeerCount; i++) {
        this.peers.push({ index: i, nx: this.rng(), ny: this.rng() });
      }

      // Topics: two global + 64 attestation subnets.
      this.topics = [
        this.makeTopic("block", "block", "BLOCK", C_BLOCK, true, "global"),
        this.makeTopic("aggregation", "aggregation", "AGG", C_AGG, true, "global"),
      ];
      const duty = 5; // short-term: this epoch's attestation duty subnet.
      const backbone = this.pickBackbone(duty);
      for (let id = 0; id < ATTESTATION_SUBNET_COUNT; id++) {
        const reason = id === duty ? "duty" : backbone.includes(id) ? "backbone" : null;
        const topic = this.makeTopic(
          `att_${id}`,
          `attestation_${id}`,
          "ATT",
          reason === "backbone" ? C_BACKBONE : reason === "duty" ? C_DUTY : C_IDLE,
          reason !== null,
          reason || "idle",
        );
        topic.subnetId = id;
        this.topics.push(topic);
      }
      for (const topic of this.topics) this.assignMesh(topic);
    },

    makeTopic(key, name, kind, color, subscribed, reason) {
      return { key, name, kind, color, subscribed, reason, subnetId: -1, mesh: [] };
    },

    /** node_id-based long-term backbone subscriptions (SUBNETS_PER_NODE). */
    pickBackbone(exclude) {
      const picks = [];
      while (picks.length < SUBNETS_PER_NODE) {
        const id = util.randomInt(this.rng, 0, ATTESTATION_SUBNET_COUNT);
        if (id !== exclude && !picks.includes(id)) picks.push(id);
      }
      return picks;
    },

    /** A topic's mesh is D peers chosen from the SAME shared physical pool. */
    assignMesh(topic) {
      if (!topic.subscribed) {
        topic.mesh = [];
        return;
      }
      const pool = util.shuffleInPlace(this.rng, this.peers.map((p) => p.index));
      topic.mesh = pool.slice(0, Math.min(MESH_DEGREE, pool.length));
    },

    subscribedTopics() {
      return this.topics.filter((t) => t.subscribed);
    },

    attestationTopics() {
      return this.topics.filter((t) => t.kind === "ATT");
    },

    selectedTopic() {
      return this.topics.find((t) => t.key === this.selectedTopicKey) || this.topics[0];
    },

    /* ------------------------- layout ------------------------- */
    computeLayout() {
      const top = MARGIN;
      const bottom = this.height - MARGIN;
      const h = bottom - top;
      // Four bands: ribbon (committee map), subnet strip, topic chips, peer pool.
      this.bands = {
        committee: { y: top, h: h * 0.16 },
        subnet: { y: top + h * 0.2, h: h * 0.16 },
        chips: { y: top + h * 0.42, h: h * 0.12 },
        peers: { y: top + h * 0.58, h: h * 0.42 },
      };
    },

    /* ------------------------- derived validator math ------------------------- */
    committeeMath() {
      const total = this.totalValidators;
      const dutiesPerSlot = Math.floor(total / SLOTS_PER_EPOCH);
      const committeesPerSlot = Math.max(
        1,
        Math.min(ATTESTATION_SUBNET_COUNT, Math.floor(dutiesPerSlot / 128)),
      );
      const committeeSize = Math.round(dutiesPerSlot / committeesPerSlot);
      const perSubnetEpoch = Math.round(total / ATTESTATION_SUBNET_COUNT);
      return { committeesPerSlot, committeeSize, perSubnetEpoch };
    },

    /** Illustrative per-slot rotation of committee index onto a subnet. */
    committeeForSubnet(subnetId) {
      return (subnetId + this.slot) % ATTESTATION_SUBNET_COUNT;
    },

    /* ------------------------- geometry helpers ------------------------- */
    peerX(peer) {
      const x0 = MARGIN + 90; // leave room for the "あなた" node on the left.
      const x1 = this.width - MARGIN - 10;
      return util.lerp(x0, x1, peer.nx);
    },
    peerY(peer) {
      const b = this.bands.peers;
      return util.lerp(b.y + 30, b.y + b.h - 14, peer.ny);
    },
    youX() {
      return MARGIN + 34;
    },
    youY() {
      const b = this.bands.peers;
      return b.y + b.h / 2;
    },
    subnetRect(id) {
      const b = this.bands.subnet;
      const usable = this.width - 2 * MARGIN;
      const gap = 2;
      const w = (usable - gap * (ATTESTATION_SUBNET_COUNT - 1)) / ATTESTATION_SUBNET_COUNT;
      return { x: MARGIN + id * (w + gap), y: b.y + 22, w, h: b.h - 30 };
    },

    /* ------------------------- vote propagation ------------------------- */
    publishVote() {
      const topic = this.selectedTopic();
      if (!topic.subscribed || !topic.mesh.length) return;
      this.particles = [];
      const reached = new Set();
      // Hop 1: you -> your mesh peers (direct).
      for (const peerIndex of topic.mesh) {
        this.spawnHop(this.youX(), this.youY(), peerIndex, topic.color, 0);
        reached.add(peerIndex);
      }
      // Hops 2-3: each informed peer forwards onward to a few pool peers,
      // illustrating hop-by-hop flooding reaching beyond the direct mesh.
      let frontier = [...topic.mesh];
      for (let hop = 1; hop <= 2 && reached.size < this.peers.length; hop++) {
        const next = [];
        for (const fromIndex of frontier) {
          const candidates = util
            .shuffleInPlace(this.rng, this.peers.map((p) => p.index))
            .filter((i) => i !== fromIndex && !reached.has(i))
            .slice(0, 2);
          for (const toIndex of candidates) {
            const from = this.peers[fromIndex];
            this.spawnHop(this.peerX(from), this.peerY(from), toIndex, topic.color, hop);
            reached.add(toIndex);
            next.push(toIndex);
          }
        }
        frontier = next;
      }
    },

    spawnHop(fromX, fromY, toIndex, color, hop) {
      const to = this.peers[toIndex];
      this.particles.push({
        fromX,
        fromY,
        toIndex,
        color,
        delay: hop * 0.32,
        t: -hop * 0.32,
        duration: 0.34,
      });
    },

    /* ------------------------- update ------------------------- */
    update(realDt) {
      this.simTime += realDt;
      const survivors = [];
      for (const p of this.particles) {
        p.t += realDt / p.duration;
        if (p.t < 1) survivors.push(p);
      }
      this.particles = survivors;
    },

    /* ------------------------- rendering ------------------------- */
    render(ctx) {
      draw.clear(ctx, this.width, this.height);
      this.renderCommitteeBand(ctx);
      this.renderSubnetBand(ctx);
      this.renderChipBand(ctx);
      this.renderPeerBand(ctx);
      this.renderParticles(ctx);
    },

    bandTitle(ctx, text, y) {
      draw.label(ctx, text, MARGIN, y, colors.textDim, "11px ui-monospace, monospace", "left");
    },

    renderCommitteeBand(ctx) {
      const b = this.bands.committee;
      this.bandTitle(ctx, "① committee（論理グループ）— 誰が一緒に投票するか", b.y + 8);
      const topic = this.selectedTopic();
      const math = this.committeeMath();
      const cx = MARGIN + 8;
      const cy = b.y + 26;
      const subnetId = topic.kind === "ATT" ? topic.subnetId : -1;
      const committee = subnetId >= 0 ? this.committeeForSubnet(subnetId) : -1;

      // The selected subnet's committee tile, then the identity arrows.
      if (subnetId >= 0) {
        draw.roundedRect(ctx, cx, cy, 132, b.h - 34, 8);
        ctx.fillStyle = "#16202f";
        ctx.fill();
        ctx.strokeStyle = topic.color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        draw.label(ctx, `Committee ${committee}`, cx + 66, cy + 16, colors.text, "12px ui-monospace, monospace");
        draw.label(ctx, `≈${math.committeeSize} validators`, cx + 66, cy + 34, colors.textDim, "11px ui-monospace, monospace");
        const arrowY = cy + (b.h - 34) / 2;
        draw.arrow(ctx, cx + 140, arrowY, cx + 188, arrowY, colors.textDim, 1.4);
        draw.label(ctx, `compute_subnet → subnet ${subnetId} ≡ topic "${topic.name}"`, cx + 196, arrowY, colors.text, "12px ui-monospace, monospace", "left");
        draw.label(ctx, `${this.totalValidators.toLocaleString()} validator / 1スロット ${math.committeesPerSlot}委員会・各≈${math.committeeSize}（瞬間） — 64 subnet で捌けるのは時間スライス`, cx, b.y + b.h - 2, colors.textDim, "10px ui-monospace, monospace", "left");
      } else {
        draw.label(ctx, `${topic.name} は全ノード購読のグローバル topic（特定 committee に紐付かない）`, cx, cy + 20, colors.text, "12px ui-monospace, monospace", "left");
      }
    },

    renderSubnetBand(ctx) {
      const b = this.bands.subnet;
      this.bandTitle(ctx, `② subnet = topic（attestation_N）— ${ATTESTATION_SUBNET_COUNT}本。クリックで購読/解除`, b.y + 8);
      for (let id = 0; id < ATTESTATION_SUBNET_COUNT; id++) {
        const topic = this.topics.find((t) => t.subnetId === id);
        const r = this.subnetRect(id);
        const selected = this.selectedTopicKey === topic.key;
        const hovered = this.hoverSubnetId === id;
        draw.roundedRect(ctx, r.x, r.y, r.w, r.h, 2);
        ctx.fillStyle = topic.subscribed ? topic.color : C_IDLE;
        ctx.globalAlpha = topic.subscribed ? 0.9 : 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (selected || hovered) {
          ctx.strokeStyle = selected ? colors.text : colors.textDim;
          ctx.lineWidth = 1.6;
          draw.roundedRect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 3);
          ctx.stroke();
        }
        if (id % 8 === 0) {
          draw.label(ctx, String(id), r.x, b.y + b.h - 2, colors.textDim, "9px ui-monospace, monospace", "left");
        }
      }
    },

    renderChipBand(ctx) {
      const b = this.bands.chips;
      const subs = this.subscribedTopics();
      this.bandTitle(ctx, `③ 購読中の topic（${subs.length}本）— chip をクリックで mesh を強調`, b.y + 8);
      let x = MARGIN;
      const y = b.y + 24;
      ctx.font = "11px ui-monospace, monospace";
      for (const topic of subs) {
        const label = topic.kind === "ATT" ? topic.name : `${topic.name} ★`;
        const w = ctx.measureText(label).width + 22;
        const selected = topic.key === this.selectedTopicKey;
        topic._chip = { x, y, w, h: 22 };
        draw.roundedRect(ctx, x, y, w, 22, 6);
        ctx.fillStyle = selected ? topic.color : "#16202f";
        ctx.globalAlpha = selected ? 0.85 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = topic.color;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        draw.label(ctx, label, x + w / 2, y + 11, selected ? "#0c1018" : colors.text, "11px ui-monospace, monospace");
        x += w + 8;
        if (x > this.width - MARGIN - 120) break;
      }
    },

    renderPeerBand(ctx) {
      const b = this.bands.peers;
      this.bandTitle(ctx, `④ peer（物理接続）— 固定 ${this.physicalPeerCount} スロット。mesh は同じプールの部分集合`, b.y + 8);
      const topic = this.selectedTopic();
      const meshSet = new Set(topic.mesh);

      // Selected topic's mesh edges: you -> the chosen physical peers.
      if (topic.subscribed) {
        for (const peerIndex of topic.mesh) {
          const peer = this.peers[peerIndex];
          draw.line(ctx, this.youX(), this.youY(), this.peerX(peer), this.peerY(peer), topic.color, 1.8, false);
        }
      }

      // Physical peers. Highlight those in the selected mesh.
      for (const peer of this.peers) {
        const inMesh = meshSet.has(peer.index);
        const x = this.peerX(peer);
        const y = this.peerY(peer);
        if (inMesh) draw.glow(ctx, x, y, 14, topic.color);
        draw.disc(ctx, x, y, inMesh ? 6 : 4, inMesh ? topic.color : colors.node, colors.nodeStroke, 1);
      }

      // The "you" node.
      const yx = this.youX();
      const yy = this.youY();
      draw.disc(ctx, yx, yy, 12, colors.accent, colors.text, 1.6);
      draw.label(ctx, "あなた", yx, yy + 24, colors.text, "11px ui-monospace, monospace");
    },

    renderParticles(ctx) {
      for (const p of this.particles) {
        if (p.t < 0) continue;
        const to = this.peers[p.toIndex];
        const eased = ease.outCubic(util.clamp(p.t, 0, 1));
        const x = util.lerp(p.fromX, this.peerX(to), eased);
        const y = util.lerp(p.fromY, this.peerY(to), eased);
        draw.disc(ctx, x, y, 4, p.color, null);
        draw.glow(ctx, x, y, 10, p.color);
      }
    },

    /* ------------------------- interaction ------------------------- */
    onMouse(type, x, y) {
      const subnetId = this.subnetAt(x, y);
      if (type === "move") {
        this.hoverSubnetId = subnetId;
        return;
      }
      if (type !== "click") return;
      if (subnetId >= 0) {
        this.toggleSubnet(subnetId);
        return;
      }
      const chipKey = this.chipAt(x, y);
      if (chipKey) this.selectedTopicKey = chipKey;
    },

    subnetAt(x, y) {
      const b = this.bands.subnet;
      if (y < b.y || y > b.y + b.h) return -1;
      for (let id = 0; id < ATTESTATION_SUBNET_COUNT; id++) {
        const r = this.subnetRect(id);
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return id;
      }
      return -1;
    },

    chipAt(x, y) {
      for (const topic of this.subscribedTopics()) {
        const c = topic._chip;
        if (c && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return topic.key;
      }
      return null;
    },

    toggleSubnet(subnetId) {
      const topic = this.topics.find((t) => t.subnetId === subnetId);
      topic.subscribed = !topic.subscribed;
      topic.color = topic.subscribed ? (topic.reason === "backbone" ? C_BACKBONE : C_DUTY) : C_IDLE;
      this.assignMesh(topic);
      if (topic.subscribed) this.selectedTopicKey = topic.key;
      else if (this.selectedTopicKey === topic.key) this.selectedTopicKey = "block";
    },

    /* ------------------------- stats ------------------------- */
    getStats() {
      const subs = this.subscribedTopics();
      const attSubs = subs.filter((t) => t.kind === "ATT").length;
      const meshTotal = subs.reduce((sum, t) => sum + t.mesh.length, 0);
      const math = this.committeeMath();
      const topic = this.selectedTopic();
      return [
        { label: "物理ピア数（固定）", value: this.physicalPeerCount },
        { label: "購読 topic 数", value: `${subs.length}（subnet ${attSubs} + global 2）` },
        { label: "mesh 延べ参加（≈8×topic）", value: meshTotal },
        { label: "選択 topic", value: topic.name },
        { label: "選択 topic の topic_id", value: `…/${FORK_DIGEST}/${topic.name}/ssz_snappy` },
        { label: "subnet 本数", value: ATTESTATION_SUBNET_COUNT },
        { label: "瞬間 / subnet（委員会1個）", value: `≈${math.committeeSize}` },
        { label: "エポック累計 / subnet", value: `≈${math.perSubnetEpoch.toLocaleString()} = 総数/64` },
      ];
    },

    /* ------------------------- controls ------------------------- */
    buildControls(container) {
      const ui = P2P.ui;

      const actions = ui.group("操作");
      actions.appendChild(
        ui.button("vote を発行（選択 topic）", () => this.publishVote(), "primary"),
      );
      actions.appendChild(
        ui.button("subnet をランダム購読", () => {
          const idle = this.attestationTopics().filter((t) => !t.subscribed);
          if (idle.length) this.toggleSubnet(util.pickRandom(this.rng, idle).subnetId);
        }),
      );
      actions.appendChild(
        ui.button("subnet を全解除（義務+backbone以外）", () => {
          for (const t of this.attestationTopics()) {
            if (t.subscribed && t.reason === "idle") this.toggleSubnet(t.subnetId);
          }
        }),
      );
      actions.appendChild(
        ui.button("再構築（新しいピア配置）", () => {
          this.seed++;
          this.build();
        }),
      );
      container.appendChild(actions);

      const params = ui.group("パラメータ");
      params.appendChild(
        ui.slider("物理ピア数", 50, 100, 5, this.physicalPeerCount, (value) => {
          this.physicalPeerCount = value;
          this.build();
        }),
      );
      params.appendChild(
        ui.slider("slot（エポック内 0–31）", 0, SLOTS_PER_EPOCH - 1, 1, this.slot, (value) => {
          this.slot = value;
        }),
      );
      params.appendChild(
        ui.slider("バリデータ総数（万）", 10, 200, 10, this.totalValidators / 10000, (value) => {
          this.totalValidators = value * 10000;
        }),
      );
      container.appendChild(params);
    },
  };

  P2P.scenes.layers = scene;
})();
