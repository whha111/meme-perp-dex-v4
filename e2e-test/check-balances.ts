import { createPublicClient, http, formatEther, type Address } from "viem";
import { bscTestnet } from "viem/chains";

const client = createPublicClient({
  chain: bscTestnet,
  transport: http("https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
});

const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address;

const abi = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const contracts: Record<string, Address> = {
  TokenFactory: "0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83",
  Settlement: "0x32de01f0E464521583E52d50f125492D10EfDBB3",
  SettlementV2: "0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b",
  PriceFeed: "0xB480517B96558E4467cfa1d91d8E6592c66B564D",
  PositionManager: "0x50d3e039Efe373D9d52676D482E732FD9C411b05",
  Vault: "0xE70b128aA233Fa6e54C1EDCACDdC11C5465760Ac",
  PerpVault: "0xF0db95eD967318BC7757A671399f0D4FFC853e05",
  RiskManager: "0x176a7Abf1B3917DEd911B6F6aac4adcB318cd558",
  FundingRate: "0x246d00Bfb4DC18d199Fecaf4045A2F6f2A018A9C",
  Liquidation: "0x5587Cf6b94E52e2Da0B8412381fcdfe4D39CA562",
  InsuranceFund: "0xa20488Ed2CEABD0e6441496c2F4F5fBA18F4cE83",
  ContractRegistry: "0x0C6605b820084e43d0708943d15b1c681f2bCac1",
  Deployer: "0xAecb229194314999E396468eb091b42E44Bc3c8c",
};

async function main() {
  let totalBNB = 0n;
  let totalWBNB = 0n;

  console.log("=== Contract BNB & WBNB Balances ===\n");

  for (const [name, addr] of Object.entries(contracts)) {
    const bnb = await client.getBalance({ address: addr });
    const wbnb = (await client.readContract({
      address: WBNB,
      abi,
      functionName: "balanceOf",
      args: [addr],
    })) as bigint;

    if (bnb > 0n || wbnb > 0n) {
      console.log(
        `${name.padEnd(20)} BNB: ${formatEther(bnb).padStart(12)}  WBNB: ${formatEther(wbnb).padStart(12)}`
      );
    }
    totalBNB += bnb;
    totalWBNB += wbnb;
  }

  console.log("\n--- Summary ---");
  console.log(`Total BNB:  ${formatEther(totalBNB)}`);
  console.log(`Total WBNB: ${formatEther(totalWBNB)}`);
  console.log(`Grand Total: ${formatEther(totalBNB + totalWBNB)} BNB equivalent`);
}

main().catch(console.error);
