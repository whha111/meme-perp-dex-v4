/**
 * Merkle Tree Module for Mode 2 (Off-chain Execution + On-chain Attestation)
 *
 * Purpose:
 * - Generate Merkle trees from user equity states
 * - Create proofs for withdrawal verification
 * - Verify proofs before on-chain withdrawal
 *
 * Architecture:
 * 1. User equities are stored as leaves: keccak256(abi.encode(user, equity))
 * 2. Tree is built bottom-up using keccak256(left || right) with sorted pairs
 * 3. Root is submitted on-chain periodically (hourly snapshots)
 * 4. Users request withdrawal with Merkle proof + platform signature
 */

import { keccak256, encodePacked, type Address, type Hex } from "viem";

/**
 * User equity state (leaf data)
 */
export interface UserEquity {
  user: Address;
  equity: bigint; // 1e18 precision (WETH)
}

/**
 * Merkle proof for a single user
 */
export interface MerkleProof {
  user: Address;
  equity: bigint;
  proof: Hex[];
  leaf: Hex;
  root: Hex;
}

/**
 * Snapshot state containing the full Merkle tree
 */
export interface SnapshotState {
  snapshotId: number;
  timestamp: number;
  root: Hex;
  leaves: Hex[];
  equities: UserEquity[];
}

/**
 * Calculate leaf hash from user equity
 * Must match Solidity: keccak256(abi.encodePacked(user, equity))
 */
export function calculateLeaf(user: Address, equity: bigint): Hex {
  // Use encodePacked to match Solidity's abi.encodePacked
  // user: 20 bytes (address), equity: 32 bytes (uint256)
  return keccak256(
    encodePacked(
      ["address", "uint256"],
      [user, equity]
    )
  );
}

/**
 * Calculate parent hash from two children
 * Sort children to ensure consistent ordering (important for proof verification)
 */
function hashPair(left: Hex, right: Hex): Hex {
  // Sort to ensure consistent ordering regardless of insertion order
  const [first, second] = left < right ? [left, right] : [right, left];
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32"],
      [first as `0x${string}`, second as `0x${string}`]
    )
  );
}

/**
 * Build Merkle tree from leaves
 * Returns all layers including leaves (index 0) and root (last index)
 */
export function buildMerkleTree(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) {
    return [[keccak256(encodePacked(["string"], ["empty"]))]];
  }

  // Sort leaves for consistent ordering
  const sortedLeaves = [...leaves].sort();
  const layers: Hex[][] = [sortedLeaves];

  let currentLayer = sortedLeaves;

  while (currentLayer.length > 1) {
    const nextLayer: Hex[] = [];

    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        // Pair exists
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
      } else {
        // Odd element - promote to next layer (hash with itself)
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i]));
      }
    }

    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return layers;
}

/**
 * Get Merkle root from tree
 */
export function getMerkleRoot(tree: Hex[][]): Hex {
  return tree[tree.length - 1][0];
}

/**
 * Generate Merkle proof for a specific leaf
 */
export function generateProof(tree: Hex[][], leafIndex: number): Hex[] {
  const proof: Hex[] = [];
  let index = leafIndex;

  for (let layer = 0; layer < tree.length - 1; layer++) {
    const currentLayer = tree[layer];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < currentLayer.length) {
      proof.push(currentLayer[siblingIndex]);
    } else {
      // No sibling (odd number of nodes) - use same node
      proof.push(currentLayer[index]);
    }

    // Move to parent index
    index = Math.floor(index / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof
 */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computedHash = leaf;

  for (const sibling of proof) {
    computedHash = hashPair(computedHash, sibling);
  }

  return computedHash === root;
}

/**
 * Main class for managing Merkle tree snapshots
 */
export class MerkleTreeManager {
  private currentSnapshot: SnapshotState | null = null;
  private snapshotHistory: Map<number, SnapshotState> = new Map();
  private snapshotCounter = 0;

  // M-09 FIX: Merkle tree 缓存 — 避免每次 getProof 都重建整棵树
  private cachedTree: Hex[][] | null = null;
  private cachedTreeSnapshotId: number | null = null;

  /**
   * Create a new snapshot from user equities
   */
  createSnapshot(equities: UserEquity[]): SnapshotState {
    // Calculate leaves
    const leaves = equities.map(eq => calculateLeaf(eq.user, eq.equity));

    // Build tree
    const tree = buildMerkleTree(leaves);
    const root = getMerkleRoot(tree);

    // Create snapshot
    // L-04 FIX: 使用 Unix 秒而非毫秒 — 与链上 block.timestamp 保持一致
    const snapshot: SnapshotState = {
      snapshotId: ++this.snapshotCounter,
      timestamp: Math.floor(Date.now() / 1000),
      root,
      leaves,
      equities,
    };

    // Store snapshot
    this.currentSnapshot = snapshot;
    this.snapshotHistory.set(snapshot.snapshotId, snapshot);

    console.log(`[Merkle] Created snapshot #${snapshot.snapshotId} with ${equities.length} users, root=${root.slice(0, 18)}...`);

    return snapshot;
  }

  /**
   * Get proof for a specific user from the current snapshot
   */
  getProof(user: Address): MerkleProof | null {
    if (!this.currentSnapshot) {
      console.warn("[Merkle] No snapshot available");
      return null;
    }

    const normalizedUser = user.toLowerCase() as Address;

    // Find user's equity
    const equityIndex = this.currentSnapshot.equities.findIndex(
      eq => eq.user.toLowerCase() === normalizedUser
    );

    if (equityIndex === -1) {
      console.warn(`[Merkle] User ${user.slice(0, 10)} not found in snapshot`);
      return null;
    }

    const equity = this.currentSnapshot.equities[equityIndex];
    const leaf = calculateLeaf(equity.user, equity.equity);

    // Find leaf in sorted leaves
    const sortedLeaves = [...this.currentSnapshot.leaves].sort();
    const leafIndex = sortedLeaves.findIndex(l => l === leaf);

    if (leafIndex === -1) {
      console.warn(`[Merkle] Leaf not found in tree for user ${user.slice(0, 10)}`);
      return null;
    }

    // M-09 FIX: 使用缓存的 Merkle tree，避免每次 getProof 都 O(n) 重建
    if (this.cachedTreeSnapshotId !== this.currentSnapshot.snapshotId || !this.cachedTree) {
      this.cachedTree = buildMerkleTree(this.currentSnapshot.leaves);
      this.cachedTreeSnapshotId = this.currentSnapshot.snapshotId;
    }
    const proof = generateProof(this.cachedTree, leafIndex);

    return {
      user: equity.user,
      equity: equity.equity,
      proof,
      leaf,
      root: this.currentSnapshot.root,
    };
  }

  /**
   * Get proof from a specific historical snapshot
   */
  getProofFromSnapshot(user: Address, snapshotId: number): MerkleProof | null {
    const snapshot = this.snapshotHistory.get(snapshotId);
    if (!snapshot) {
      console.warn(`[Merkle] Snapshot #${snapshotId} not found`);
      return null;
    }

    // AUDIT-FIX ME-H02: 不再临时替换 currentSnapshot（并发请求会互相腐蚀）
    // 直接从目标 snapshot 计算 proof，无需修改任何共享状态
    const normalizedUser = user.toLowerCase() as Address;
    const equityIndex = snapshot.equities.findIndex(
      eq => eq.user.toLowerCase() === normalizedUser
    );
    if (equityIndex === -1) {
      console.warn(`[Merkle] User ${user.slice(0, 10)} not in snapshot #${snapshotId}`);
      return null;
    }
    const equity = snapshot.equities[equityIndex];
    const leaf = calculateLeaf(equity.user, equity.equity);
    const sortedLeaves = [...snapshot.leaves].sort();
    const leafIndex = sortedLeaves.findIndex(l => l === leaf);
    if (leafIndex === -1) return null;
    const tree = buildMerkleTree(snapshot.leaves);
    const proof = generateProof(tree, leafIndex);
    return {
      user: equity.user,
      equity: equity.equity,
      proof,
      leaf,
      root: snapshot.root,
    };
  }

  /**
   * Verify a proof
   */
  verifyUserProof(proof: MerkleProof): boolean {
    const computedLeaf = calculateLeaf(proof.user, proof.equity);

    if (computedLeaf !== proof.leaf) {
      console.warn(`[Merkle] Leaf mismatch: computed=${computedLeaf.slice(0, 18)}, provided=${proof.leaf.slice(0, 18)}`);
      return false;
    }

    const isValid = verifyProof(proof.leaf, proof.proof, proof.root);

    if (!isValid) {
      console.warn(`[Merkle] Proof verification failed for user ${proof.user.slice(0, 10)}`);
    }

    return isValid;
  }

  /**
   * Get current snapshot
   */
  getCurrentSnapshot(): SnapshotState | null {
    return this.currentSnapshot;
  }

  /**
   * Get current root
   */
  getCurrentRoot(): Hex | null {
    return this.currentSnapshot?.root ?? null;
  }

  /**
   * Get snapshot by ID
   */
  getSnapshot(snapshotId: number): SnapshotState | null {
    return this.snapshotHistory.get(snapshotId) ?? null;
  }

  /**
   * Get all snapshot IDs
   */
  getSnapshotIds(): number[] {
    return Array.from(this.snapshotHistory.keys()).sort((a, b) => b - a);
  }

  /**
   * Prune old snapshots (keep last N)
   */
  pruneSnapshots(keepLast: number = 24): void {
    const ids = this.getSnapshotIds();
    const toDelete = ids.slice(keepLast);

    for (const id of toDelete) {
      this.snapshotHistory.delete(id);
    }

    if (toDelete.length > 0) {
      console.log(`[Merkle] Pruned ${toDelete.length} old snapshots`);
    }
  }
}

// Singleton instance
export const merkleTreeManager = new MerkleTreeManager();
