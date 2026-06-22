/*
 * sszmodel.js — shared SSZ model for the unified pipeline scene.
 *
 * One Validator container flows through every SSZ stage:
 *   §2.3 serialize   — fixed fields inline, the variable field as a 4-byte offset
 *                      pointer with its data appended in the variable part.
 *   §2.4 merkleize   — each field's hash_tree_root is a leaf of a depth-2 binary
 *                      tree; pair-hash bottom-up to the container hash_tree_root.
 *   §2.5 proof       — a field's generalized index (gindex = 2^depth + position)
 *                      and the sibling witnesses needed to recompute the root.
 *
 * Hashes are a deterministic 4-hex rolling polynomial (no real SHA-256 needed).
 */
"use strict";

(function registerSszModel() {
  const { util } = P2P;

  function hashLabel(labelString) {
    let acc = 0x811c9dc5;
    for (let i = 0; i < labelString.length; i++) {
      acc ^= labelString.charCodeAt(i);
      acc = Math.imul(acc, 0x01000193) >>> 0;
    }
    return util.toHexTag(acc & 0xffff, 4);
  }
  function hashPair(left, right) {
    return hashLabel(left + "|" + right);
  }

  // Validator container fields, in declaration order (positions 0..3 → gindex 4..7).
  // `signatures` is the one variable-length field (serialized as a 4-byte offset).
  const FIELDS = [
    { name: "id", type: "uint16", bytes: 2, fixed: true, value: "42", gindex: 4 },
    { name: "pubkey", type: "Bytes48", bytes: 48, fixed: true, value: "0xab12", gindex: 5 },
    { name: "balance", type: "uint64", bytes: 8, fixed: true, value: "32ETH", gindex: 6 },
    { name: "signatures", type: "List[Bytes4]", bytes: 4, fixed: false, value: "[…]", gindex: 7 },
  ];
  const FIXED_PART_BYTES = FIELDS.reduce((sum, f) => sum + f.bytes, 0); // 2+48+8+4 = 62
  const BYTES_PER_SIGNATURE = 4;

  function leafHash(field, signatureCount) {
    const value = field.fixed ? field.value : `${signatureCount}sig`;
    return hashLabel(field.name + "=" + value);
  }

  /** Container merkleization: 4 field-root leaves (g4..g7) → root (g1). */
  function buildTree(signatureCount) {
    const h = {};
    for (const field of FIELDS) h[field.gindex] = leafHash(field, signatureCount);
    h[2] = hashPair(h[4], h[5]);
    h[3] = hashPair(h[6], h[7]);
    h[1] = hashPair(h[2], h[3]);
    return h;
  }

  /** Fixed/variable byte layout for the serialization strip (§2.3). */
  function serializeLayout(signatureCount) {
    const variableBytes = signatureCount * BYTES_PER_SIGNATURE;
    return {
      fixedBytes: FIXED_PART_BYTES,
      offsetValue: FIXED_PART_BYTES, // offset points to the start of the variable part
      variableBytes,
      totalBytes: FIXED_PART_BYTES + variableBytes,
    };
  }

  /** Merkle proof for a leaf: sibling witnesses + recomputed nodes up to the root. */
  function proofPlan(targetGindex) {
    const witnesses = [];
    const computed = [targetGindex];
    let g = targetGindex;
    while (g > 1) {
      witnesses.push(g % 2 === 0 ? g + 1 : g - 1); // sibling = flip last bit
      g = Math.floor(g / 2);
      computed.push(g);
    }
    return { targetGindex, witnesses, computed };
  }

  P2P.sszModel = {
    FIELDS,
    FIXED_PART_BYTES,
    BYTES_PER_SIGNATURE,
    hashLabel,
    hashPair,
    leafHash,
    buildTree,
    serializeLayout,
    proofPlan,
  };
})();
