/*
 * sszmodel.js — SSZ model for the unified pipeline, with selectable containers.
 *
 * Presets cover both the PDF's teaching examples and the real leanSpec
 * implementation types (src/lean_spec/spec/forks/lstar/containers):
 *   PDF      — ValidatorRecord (§2.3, hypothetical, shows offsets),
 *              Validator (§2.5, Ethereum: pubkey/withdrawal/balance/slashed).
 *   leanSpec — Checkpoint, Validator, AttestationData (nested), BlockHeader.
 *
 * Each container flows through serialize (§2.3) → merkleize (§2.4) → proof
 * (§2.5). Field kinds: "fixed" (inline), "variable" (List/Bitlist → 4-byte
 * offset + data in the variable part), "nested" (a fixed-size sub-container
 * whose hash_tree_root becomes the leaf). The leanSpec reference
 * (crypto/merkleization.py) merkleizes with SHA-256 over 32-byte chunks; this
 * visualization uses a deterministic 4-hex rolling polynomial as a stand-in.
 */
"use strict";

(function registerSszModel() {
  const { util } = P2P;

  function hashLabel(s) {
    let acc = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { acc ^= s.charCodeAt(i); acc = Math.imul(acc, 0x01000193) >>> 0; }
    return util.toHexTag(acc & 0xffff, 4);
  }
  function hashPair(l, r) { return hashLabel(l + "|" + r); }
  const ZERO_HASH = hashLabel("zero");

  // f(name, type, bytes, kind, value, elem) — kind: "fixed" | "variable" | "nested".
  const f = (name, type, bytes, kind, value, elem) => ({ name, type, bytes, kind, value, elem });

  const PRESETS = {
    validatorRecord: {
      label: "ValidatorRecord (PDF §2.3 仮想)", group: "PDF 教材例",
      fields: [
        f("id", "uint16", 2, "fixed", "42"),
        f("signatures", "List[Bytes4]", 4, "variable", "[…]", 4),
        f("pubkey", "Bytes48", 48, "fixed", "0xab12"),
      ],
    },
    ethValidator: {
      label: "Validator (PDF §2.5 Ethereum)", group: "PDF 教材例",
      fields: [
        f("pubkey", "Bytes48", 48, "fixed", "0xab12"),
        f("withdrawal_credentials", "Bytes32", 32, "fixed", "0xcc00"),
        f("effective_balance", "uint64", 8, "fixed", "32ETH"),
        f("slashed", "boolean", 1, "fixed", "false"),
      ],
    },
    checkpoint: {
      label: "Checkpoint (leanSpec)", group: "leanSpec 実装",
      fields: [
        f("root", "Bytes32", 32, "fixed", "0x9f"),
        f("slot", "Slot=uint64", 8, "fixed", "7"),
      ],
    },
    leanValidator: {
      label: "Validator (leanSpec)", group: "leanSpec 実装",
      fields: [
        f("attestation_public_key", "Bytes52", 52, "fixed", "0xa1"),
        f("proposal_public_key", "Bytes52", 52, "fixed", "0xb2"),
        f("index", "ValidatorIndex", 8, "fixed", "3"),
      ],
    },
    attestationData: {
      label: "AttestationData (leanSpec)", group: "leanSpec 実装",
      fields: [
        f("slot", "Slot", 8, "fixed", "7"),
        f("head", "Checkpoint", 40, "nested", "htr"),
        f("target", "Checkpoint", 40, "nested", "htr"),
        f("source", "Checkpoint", 40, "nested", "htr"),
      ],
    },
    blockHeader: {
      label: "BlockHeader (leanSpec)", group: "leanSpec 実装",
      fields: [
        f("slot", "Slot", 8, "fixed", "7"),
        f("proposer_index", "ValidatorIndex", 8, "fixed", "3"),
        f("parent_root", "Bytes32", 32, "fixed", "0x11"),
        f("state_root", "Bytes32", 32, "fixed", "0x22"),
        f("body_root", "Bytes32", 32, "fixed", "0x33"),
      ],
    },
  };

  function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
  function leafCount(preset) { return Math.max(1, nextPow2(preset.fields.length)); }
  function treeDepth(preset) { return Math.round(Math.log2(leafCount(preset))); }
  /** gindex of field at `position` (leaves start at 2^depth = leafCount). */
  function leafGindex(preset, position) { return leafCount(preset) + position; }

  function leafHash(field, listLength) {
    if (field.kind === "variable") return hashLabel(field.name + ":list" + listLength);
    if (field.kind === "nested") return hashLabel(field.name + ":htr");
    return hashLabel(field.name + "=" + field.value);
  }

  /** Container merkleization: field roots as leaves (+ zero padding) → root g1. */
  function buildTree(preset, listLength) {
    const leaves = leafCount(preset);
    const depth = treeDepth(preset);
    const h = {};
    for (let i = 0; i < leaves; i++) {
      h[leaves + i] = i < preset.fields.length ? leafHash(preset.fields[i], listLength) : ZERO_HASH;
    }
    for (let level = depth - 1; level >= 0; level--) {
      for (let p = 0; p < Math.pow(2, level); p++) {
        const g = Math.pow(2, level) + p;
        h[g] = hashPair(h[2 * g], h[2 * g + 1]);
      }
    }
    return { hashes: h, depth, leaves };
  }

  /** Fixed/variable byte layout for the serialize strip (§2.3). */
  function serializeLayout(preset, listLength) {
    let fixedBytes = 0;
    for (const field of preset.fields) fixedBytes += field.kind === "variable" ? 4 : field.bytes;
    const segs = [];
    const varParts = [];
    let cursor = fixedBytes;
    for (const field of preset.fields) {
      if (field.kind === "variable") {
        segs.push({ field, kind: "offset", bytes: 4, offsetValue: cursor });
        const dataBytes = listLength * (field.elem || 4);
        varParts.push({ field, bytes: dataBytes });
        cursor += dataBytes;
      } else {
        segs.push({ field, kind: field.kind, bytes: field.bytes });
      }
    }
    const variableBytes = varParts.reduce((s, p) => s + p.bytes, 0);
    return { fixedBytes, variableBytes, totalBytes: fixedBytes + variableBytes, segs, varParts };
  }

  /** Merkle proof for a leaf: sibling witnesses + recomputed nodes up to root. */
  function proofPlan(targetGindex) {
    const witnesses = [];
    const computed = [targetGindex];
    let g = targetGindex;
    while (g > 1) {
      witnesses.push(g % 2 === 0 ? g + 1 : g - 1);
      g = Math.floor(g / 2);
      computed.push(g);
    }
    return { targetGindex, witnesses, computed };
  }

  P2P.sszModel = {
    PRESETS,
    hashLabel,
    hashPair,
    ZERO_HASH,
    nextPow2,
    leafCount,
    treeDepth,
    leafGindex,
    leafHash,
    buildTree,
    serializeLayout,
    proofPlan,
  };
})();
