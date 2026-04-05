/**
 * SettlementV2 WBNB 提取脚本
 *
 * 策略：
 * 1. 构建单叶 Merkle 树 (leaf = deployer + 27.1 WBNB)
 * 2. deployer 作为 authorizedUpdater 提交 stateRoot
 * 3. deployer 作为 platformSigner 签署 EIP-712 提款
 * 4. deployer 调用 SettlementV2.withdraw()
 * 5. 收到的 WBNB → unwrap 成 BNB
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

// ============ Config ============
const RPC_URL = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const DEPLOYER_PK =
  "0x4698c351c4aead4844a41399b035e1177535db94a5418a79df07b7f0bf158776" as Hex;
const DEPLOYER = "0xAecb229194314999E396468eb091b42E44Bc3c8c" as Address;
const SETTLEMENT_V2 = "0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b" as Address;
const WBNB_ADDR = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address;

// ============ Clients ============
const account = privateKeyToAccount(DEPLOYER_PK);
const client = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});
const wallet = createWalletClient({
  account,
  chain: bscTestnet,
  transport: http(RPC_URL),
});

// ============ ABI ============
const SV2_ABI = [
  {
    name: "updateStateRoot",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "newRoot", type: "bytes32" }],
    outputs: [],
  },
  {
    // H-1 fix: New ABI with merkleRoot parameter (deployed 2026-04-03)
    name: "withdraw",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "userEquity", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "withdrawalNonces",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "totalWithdrawn",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const WBNB_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

// ============ EIP-712 ============
const EIP712_DOMAIN = {
  name: "SettlementV2" as const,
  version: "1" as const,
  chainId: 97,
  verifyingContract: SETTLEMENT_V2,
} as const;

const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "merkleRoot", type: "bytes32" },
  ],
} as const;

// ============ Merkle Tree (single leaf) ============
function buildSingleLeafTree(
  user: Address,
  equity: bigint
): { root: Hex; leaf: Hex; proof: Hex[] } {
  // leaf = keccak256(abi.encodePacked(user, equity))
  const leaf = keccak256(encodePacked(["address", "uint256"], [user, equity]));
  // Single leaf tree: root = keccak256(leaf || leaf) — self-hash for single node
  // Actually for a single leaf, root IS the leaf (MerkleProof.verify with empty proof checks leaf == root)
  const root = leaf;
  return { root, leaf, proof: [] };
}

// ============ Main ============
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  SettlementV2 Direct Withdrawal — BSC Testnet");
  console.log("═══════════════════════════════════════════════════\n");

  // 1. Get contract WBNB balance
  const wbnbBalance = (await client.readContract({
    address: WBNB_ADDR,
    abi: WBNB_ABI,
    functionName: "balanceOf",
    args: [SETTLEMENT_V2],
  })) as bigint;
  console.log(`SettlementV2 WBNB: ${formatEther(wbnbBalance)}`);

  if (wbnbBalance === 0n) {
    console.log("Nothing to withdraw.");
    return;
  }

  // 2. Check deployer's withdrawal state
  const nonce = (await client.readContract({
    address: SETTLEMENT_V2,
    abi: SV2_ABI,
    functionName: "withdrawalNonces",
    args: [DEPLOYER],
  })) as bigint;
  const totalWithdrawn = (await client.readContract({
    address: SETTLEMENT_V2,
    abi: SV2_ABI,
    functionName: "totalWithdrawn",
    args: [DEPLOYER],
  })) as bigint;
  console.log(`Deployer nonce: ${nonce}, totalWithdrawn: ${formatEther(totalWithdrawn)}`);

  // The equity must be > totalWithdrawn + withdrawAmount
  const withdrawAmount = wbnbBalance;
  const userEquity = totalWithdrawn + withdrawAmount;
  console.log(`\nPlan: equity=${formatEther(userEquity)}, withdraw=${formatEther(withdrawAmount)}`);

  // 3. Build Merkle tree
  console.log("\n━━━ Step 1: Build Merkle Tree ━━━");
  const { root, proof } = buildSingleLeafTree(DEPLOYER, userEquity);
  console.log(`  Root: ${root}`);
  console.log(`  Proof: [] (single leaf — empty proof)`);

  // 4. Submit state root to contract
  console.log("\n━━━ Step 2: Submit State Root ━━━");
  const rootTx = await wallet.writeContract({
    address: SETTLEMENT_V2,
    abi: SV2_ABI,
    functionName: "updateStateRoot",
    args: [root],
  });
  console.log(`  Tx: ${rootTx}`);
  const rootReceipt = await client.waitForTransactionReceipt({
    hash: rootTx,
    confirmations: 2,
  });
  if (rootReceipt.status === "reverted") {
    console.log("  ❌ updateStateRoot REVERTED");
    return;
  }
  console.log("  ✅ State root updated on-chain");

  // 5. Sign EIP-712 withdrawal
  // TYPEHASH includes merkleRoot even though function param doesn't
  // The contract reads merkleRoot from currentStateRoot internally
  console.log("\n━━━ Step 3: Sign EIP-712 Withdrawal ━━━");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
  const signature = await account.signTypedData({
    domain: EIP712_DOMAIN,
    types: WITHDRAWAL_TYPES,
    primaryType: "Withdrawal",
    message: {
      user: DEPLOYER,
      amount: withdrawAmount,
      nonce: nonce,
      deadline: deadline,
      merkleRoot: root, // included in TYPEHASH, contract reads currentStateRoot
    },
  });
  console.log(`  Signature: ${signature.slice(0, 20)}...`);
  console.log(`  Deadline: ${new Date(Number(deadline) * 1000).toISOString()}`);

  // 6. Call withdraw (OLD ABI: no merkleRoot param, contract uses currentStateRoot)
  console.log("\n━━━ Step 4: Submit Withdrawal On-Chain ━━━");
  console.log(`  Amount: ${formatEther(withdrawAmount)} WBNB`);
  console.log(`  Equity: ${formatEther(userEquity)}`);

  try {
    const withdrawTx = await wallet.writeContract({
      address: SETTLEMENT_V2,
      abi: SV2_ABI,
      functionName: "withdraw",
      args: [withdrawAmount, userEquity, proof as Hex[], root, deadline, signature],
    });
    console.log(`  Tx: ${withdrawTx}`);
    const withdrawReceipt = await client.waitForTransactionReceipt({
      hash: withdrawTx,
      confirmations: 2,
    });
    if (withdrawReceipt.status === "reverted") {
      console.log("  ❌ withdraw REVERTED");
      return;
    }
    console.log("  ✅ Withdrawal successful!");
  } catch (e: any) {
    console.log(`  ❌ ERROR: ${e.message?.slice(0, 200)}`);
    return;
  }

  // 7. Unwrap WBNB → BNB
  console.log("\n━━━ Step 5: Unwrap WBNB → BNB ━━━");
  const deployerWBNB = (await client.readContract({
    address: WBNB_ADDR,
    abi: WBNB_ABI,
    functionName: "balanceOf",
    args: [DEPLOYER],
  })) as bigint;
  console.log(`  Deployer WBNB: ${formatEther(deployerWBNB)}`);

  if (deployerWBNB > 0n) {
    const unwrapTx = await wallet.writeContract({
      address: WBNB_ADDR,
      abi: WBNB_ABI,
      functionName: "withdraw",
      args: [deployerWBNB],
    });
    await client.waitForTransactionReceipt({ hash: unwrapTx, confirmations: 1 });
    console.log(`  ✅ Unwrapped ${formatEther(deployerWBNB)} WBNB → BNB`);
  }

  // 8. Final summary
  console.log("\n═══════════════════════════════════════════════════");
  const sv2Remaining = (await client.readContract({
    address: WBNB_ADDR,
    abi: WBNB_ABI,
    functionName: "balanceOf",
    args: [SETTLEMENT_V2],
  })) as bigint;
  const deployerBNB = await client.getBalance({ address: DEPLOYER });
  console.log(`  SettlementV2 remaining: ${formatEther(sv2Remaining)} WBNB`);
  console.log(`  Deployer BNB: ${formatEther(deployerBNB)}`);
  console.log("═══════════════════════════════════════════════════");
}

main().catch(console.error);
