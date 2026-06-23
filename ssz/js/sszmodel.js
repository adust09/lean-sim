/*
 * sszmodel.js — SSZ model for the unified pipeline, with selectable containers.
 *
 * Presets cover both the PDF's teaching examples and the real leanSpec
 * implementation types (src/lean_spec/spec/forks/lstar/containers):
 *   PDF      — ValidatorRecord (ssz/container.py, hypothetical, shows offsets),
 *              Validator (crypto/merkleization.py, Ethereum: pubkey/withdrawal/balance/slashed).
 *   leanSpec — Checkpoint, Validator, AttestationData (nested), BlockHeader.
 *
 * Each container flows through serialize (ssz/container.py) → merkleize (crypto/merkleization.py) → proof
 * (crypto/merkleization.py). Field kinds: "fixed" (inline), "variable" (List/Bitlist → 4-byte
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

  // f(name, type, bytes, kind, value, elem, limit) — kind: "fixed" | "variable" | "nested".
  // `limit` is a List/Bitlist capacity (max elements); it fixes the internal tree height.
  const f = (name, type, bytes, kind, value, elem, limit) => ({ name, type, bytes, kind, value, elem, limit });

  const PRESETS = {
    validatorRecord: {
      label: "ValidatorRecord (PDF ssz/container.py 仮想)", group: "PDF 教材例",
      fields: [
        f("id", "uint16", 2, "fixed", "42"),
        f("signatures", "List[Bytes4, 8]", 4, "variable", "[…]", 4, 8),
        f("pubkey", "Bytes48", 48, "fixed", "0xab12"),
      ],
    },
    ethValidator: {
      label: "Validator (PDF crypto/merkleization.py Ethereum)", group: "PDF 教材例",
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
    // A List/Bitlist field's container leaf is its own hash_tree_root: the root of a
    // capacity(LIMIT)-sized chunk subtree, with the length mixed in (mix_in_length).
    if (field.kind === "variable") return buildListSubtree(field, listLength).htr;
    if (field.kind === "nested") return hashLabel(field.name + ":htr");
    return hashLabel(field.name + "=" + field.value);
  }

  /** Leaf capacity (next power of two of LIMIT) — fixes the list's internal tree height. */
  function listLeafCapacity(field) { return Math.max(1, nextPow2(field.limit || 1)); }

  /**
   * Build a List/Bitlist field's internal merkle subtree (crypto/merkleization.py):
   * the first `length` element chunks are real, the rest are zero subtrees, padded to
   * the LIMIT-derived capacity (so the height is fixed by the capacity, not the length).
   * The capacity-tree root is combined with the length via mix_in_length → the field's htr.
   */
  function buildListSubtree(field, listLength) {
    const capacity = listLeafCapacity(field);
    const depth = Math.round(Math.log2(capacity));
    const length = Math.min(listLength, field.limit || listLength);
    const h = {};
    for (let i = 0; i < capacity; i++) {
      h[capacity + i] = i < length ? hashLabel(field.name + "[" + i + "]") : ZERO_HASH;
    }
    for (let level = depth - 1; level >= 0; level--) {
      for (let p = 0; p < Math.pow(2, level); p++) {
        const g = Math.pow(2, level) + p;
        h[g] = hashPair(h[2 * g], h[2 * g + 1]);
      }
    }
    const chunkRoot = h[1];
    const htr = hashPair(chunkRoot, "len=" + length); // mix_in_length(root, length)
    return { hashes: h, depth, capacity, length, chunkRoot, htr };
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

  /** Fixed/variable byte layout for the serialize strip (ssz/container.py). */
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
    listLeafCapacity,
    buildListSubtree,
    serializeLayout,
    proofPlan,
  };
})();
