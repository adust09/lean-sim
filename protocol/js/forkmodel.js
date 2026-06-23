/*
 * forkmodel.js — reusable fork-tree + LMD-GHOST model for the capstone scene.
 *
 * Extracted so the beacon scene can simulate fork scenarios (§6.3) without the
 * scene file exceeding the 800-line limit. Holds the block TREE, GHOST head
 * selection, justification/finalization on the tree, reorg detection, scenario
 * transitions, and the bottom-of-screen tree rendering. The beacon scene drives
 * it: it decides when blocks are proposed/voted, and reads head/canonical here.
 */
"use strict";

(function registerForkModel() {
  const { util, draw, colors } = P2P;

  // The fork model is parameter-driven: the scene sets boolean flags
  // (equivocate, partitioned, attacking) via toggles rather than picking a named
  // scenario, so each fork phenomenon can be turned on/off live.

  /** Create a fork model seeded with a genesis block (justified + finalized). */
  P2P.createForkModel = function createForkModel(validatorCount) {
    const genesis = {
      id: 0, slot: 0, parent: null, children: [], lane: 0, weight: validatorCount,
      root: util.toHexTag(0xa11ce, 4), justified: true, finalized: true, proposerGroup: -1,
    };
    const model = {
      validatorCount,
      blocks: [genesis],
      genesis,
      nextLane: 0,
      latestJustified: genesis,
      latestFinalized: genesis,
      headBlock: genesis,
      canonical: new Set([genesis]),
      reorgCount: 0,
      reorgDepth: 0,
      equivocate: false, // when true, each proposer publishes two competing blocks
      partitioned: false,
      attacking: false,
      publicTip: null,
      hiddenTip: null,
      groupTip: {},
      competing: null,

      threshold() {
        return Math.ceil((2 * this.validatorCount) / 3);
      },

      /** Append a child block; a second child opens a new lane (a visible fork). */
      createBlock(parent, proposerGroup, slot) {
        const lane = parent.children.length === 0 ? parent.lane : this.nextLane + 1;
        if (parent.children.length > 0) this.nextLane += 1;
        const rootValue = (slot * 2654435761) ^ (parent.id * 40503) ^ (proposerGroup * 7);
        const block = {
          id: this.blocks.length, slot, parent, children: [], lane, weight: 0,
          root: util.toHexTag(rootValue & 0xffff, 4), justified: false, finalized: false, proposerGroup,
        };
        parent.children.push(block);
        this.blocks.push(block);
        return block;
      },

      subtreeWeight(block, memo) {
        if (block.hidden) return 0; // a withheld branch is invisible to GHOST until revealed
        if (memo.has(block)) return memo.get(block);
        let total = block.weight;
        for (const child of block.children) total += this.subtreeWeight(child, memo);
        memo.set(block, total);
        return total;
      },

      /** LMD-GHOST: from the finalized root, descend into the heaviest subtree. */
      recomputeHead() {
        const memo = new Map();
        let node = this.latestFinalized;
        while (node.children.length > 0) {
          let best = null;
          let bestWeight = -1;
          for (const child of node.children) {
            const weight = this.subtreeWeight(child, memo);
            if (weight > bestWeight || (weight === bestWeight && best && child.slot < best.slot)) {
              bestWeight = weight;
              best = child;
            }
          }
          node = best;
        }
        this.headBlock = node;
        this.canonical = new Set();
        for (let walk = node; walk; walk = walk.parent) this.canonical.add(walk);
      },

      ancestorOf(maybeAncestor, block) {
        for (let walk = block; walk; walk = walk.parent) if (walk === maybeAncestor) return true;
        return false;
      },

      /** Justify a target block (state axis); finalize the prior justified ancestor. */
      justify(target) {
        if (target.justified) return;
        target.justified = true;
        const previousJustified = this.latestJustified;
        this.latestJustified = target;
        if (previousJustified && previousJustified.justified && this.ancestorOf(previousJustified, target) && previousJustified.slot < target.slot) {
          this.latestFinalized = previousJustified;
          for (let walk = previousJustified; walk; walk = walk.parent) walk.finalized = true;
        }
      },

      detectReorg(previousHead) {
        if (previousHead === this.headBlock) return;
        if (!this.canonical.has(previousHead) && !this.ancestorOf(previousHead, this.headBlock)) {
          this.reorgCount += 1;
          // depth = blocks orphaned from the old head back to its common ancestor with the new head.
          let depth = 0;
          for (let walk = previousHead; walk && !this.ancestorOf(walk, this.headBlock); walk = walk.parent) depth += 1;
          this.reorgDepth = Math.max(this.reorgDepth, depth);
        }
      },

      orphanedCount() {
        return this.blocks.filter(
          (b) => b !== this.genesis && !b.hidden && !this.canonical.has(b) && b.slot <= this.headBlock.slot,
        ).length;
      },

      tips() {
        return this.blocks.filter((b) => b.children.length === 0);
      },

      /* ------------------------- fork engine (§6.3) ------------------------- */
      /** Create this slot's block(s). Returns [{block, group}]; sets competing for forks. */
      proposeSlot(slot) {
        this.competing = null;
        // Network partition: each group extends its own branch.
        if (this.partitioned) {
          const a = this.createBlock(this.groupTip[0], 0, slot);
          const b = this.createBlock(this.groupTip[1], 1, slot);
          this.groupTip[0] = a;
          this.groupTip[1] = b;
          return [{ block: a, group: 0 }, { block: b, group: 1 }];
        }
        // Withholding attack: honest minority builds in public, attacker majority hidden.
        if (this.attacking) {
          const pub = this.createBlock(this.publicTip, 1, slot); // honest minority, public
          const hid = this.createBlock(this.hiddenTip, 0, slot); // attacker majority, withheld
          hid.hidden = true;
          this.publicTip = pub;
          this.hiddenTip = hid;
          this.competing = [hid, pub]; // group 0 → hidden, group 1 → public (see voteTargetFor)
          return [{ block: pub, group: 1 }, { block: hid, group: 0 }];
        }
        const head = this.headBlock;
        // Equivocation: the proposer publishes two competing blocks on the same parent.
        if (this.equivocate) {
          const a = this.createBlock(head, 0, slot);
          const b = this.createBlock(head, 1, slot);
          this.competing = [a, b];
          return [{ block: a, group: 0 }, { block: b, group: 1 }];
        }
        return [{ block: this.createBlock(head, 0, slot), group: 0 }];
      },

      /** Which block a validator of `group` votes for this slot. */
      voteTargetFor(group) {
        if (this.partitioned) return this.groupTip[group];
        if (this.competing) return group === 0 ? this.competing[0] : this.competing[1];
        return this.headBlock;
      },

      /** Toggle a network partition; on heal GHOST resolves to the heaviest branch. */
      setPartition(on) {
        if (on && !this.partitioned) {
          this.partitioned = true;
          this.groupTip = { 0: this.headBlock, 1: this.headBlock };
        } else if (!on && this.partitioned) {
          this.partitioned = false;
        }
      },

      /** Begin withholding: the attacker majority forks a private branch from head. */
      startWithhold() {
        if (this.attacking) return;
        this.attacking = true;
        this.publicTip = this.headBlock;
        this.hiddenTip = this.headBlock;
      },

      /** Reveal the withheld branch; its banked votes now win GHOST → deep reorg. */
      revealWithhold() {
        if (!this.attacking) return;
        this.attacking = false;
        const previousHead = this.headBlock;
        for (const block of this.blocks) if (block.hidden) block.hidden = false; // reveal
        this.recomputeHead();
        this.detectReorg(previousHead);
      },

      /* ------------------------- tree rendering ------------------------- */
      visibleMinSlot() {
        return Math.max(this.latestFinalized.slot, this.headBlock.slot - 8);
      },

      blockX(block, box) {
        const minSlot = this.visibleMinSlot();
        const span = Math.max(1, this.headBlock.slot - minSlot + 1);
        const columnWidth = (box.width - 90) / span;
        return box.x + (block.slot - minSlot) * columnWidth + 36;
      },

      blockY(block, box) {
        const laneCount = Math.max(1, this.nextLane + 1);
        return box.y + (laneCount === 1 ? box.height / 2 : (block.lane / Math.max(1, laneCount - 1)) * box.height);
      },

      /** Draw the fork tree inside the given box; highlights canonical chain + head. */
      renderTree(ctx, box) {
        const minSlot = this.visibleMinSlot();
        const memo = new Map();
        for (const block of this.blocks) {
          if (block.slot < minSlot || !block.parent || block.parent.slot < minSlot) continue;
          const onCanonical = this.canonical.has(block) && this.canonical.has(block.parent);
          const edgeColor = block.hidden ? colors.ihave + "88" : onCanonical ? colors.nodeHasMessage + "cc" : colors.peerEdge;
          draw.line(ctx, this.blockX(block.parent, box) + 15, this.blockY(block.parent, box), this.blockX(block, box) - 15, this.blockY(block, box),
            edgeColor, onCanonical ? 2 : 1.2, block.hidden || !onCanonical);
        }
        for (const block of this.blocks) {
          if (block.slot < minSlot) continue;
          this.renderBlock(ctx, block, box, memo);
        }
      },

      renderBlock(ctx, block, box, memo) {
        const x = this.blockX(block, box);
        const y = this.blockY(block, box);
        const hidden = !!block.hidden;
        const orphaned = !hidden && !this.canonical.has(block) && block.slot <= this.headBlock.slot;
        let stroke = colors.nodeStroke;
        if (hidden) stroke = colors.ihave;
        else if (block.finalized) stroke = colors.nodeHasMessage;
        else if (block.justified) stroke = colors.graft;
        else if (block === this.headBlock) stroke = colors.nodeSource;
        else if (orphaned) stroke = colors.prune;
        ctx.save();
        ctx.globalAlpha = hidden ? 0.65 : orphaned ? 0.5 : 1;
        draw.roundedRect(ctx, x - 29, y - 16, 58, 32, 6);
        ctx.fillStyle = hidden ? "#1b1830" : "#15202f";
        ctx.fill();
        ctx.lineWidth = block === this.headBlock ? 2.4 : 1.6;
        ctx.strokeStyle = stroke;
        if (hidden) ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
        const dim = hidden || orphaned;
        const label = block.slot === 0 ? "gen" : `s${block.slot}`;
        draw.label(ctx, `${label} ${block.root}`, x, y - 5, dim ? colors.textDim : colors.text, "9px ui-monospace, monospace");
        const weightTag = hidden ? `秘匿·v${block.weight}` : `Σ${this.subtreeWeight(block, memo)}·v${block.weight}`;
        draw.label(ctx, weightTag, x, y + 7, hidden ? colors.ihave : orphaned ? colors.textDim : colors.accent, "9px ui-monospace, monospace");
        if (block === this.headBlock) draw.label(ctx, "◀head", x + 33, y, colors.nodeSource, "9px ui-monospace, monospace", "left");
      },
    };
    return model;
  };
})();
