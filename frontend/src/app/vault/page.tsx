"use client";

import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ChevronDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, Wallet } from "lucide-react";

const protocolVaults = [
  {
    name: "DEXI Liquidity Provider",
    tag: "DLP",
    manager: "0x677d...846e7",
    apr: "-0.04%",
    aprTone: "text-[#F45B69]",
    tvl: "$397,322,441.59",
    deposit: "$0.00",
    age: "1095",
    spark: "M24 28 L42 29 L60 28 L78 30 L96 30 L114 31 L132 31 L150 30",
    sparkTone: "#F45B69",
  },
  {
    name: "Liquidator",
    tag: "LIQ",
    manager: "0xfc13...80c9",
    apr: "-0.00%",
    aprTone: "text-[#F45B69]",
    tvl: "$16,474.25",
    deposit: "$0.00",
    age: "1162",
    spark: "M24 26 L45 28 L66 28 L87 29 L108 46 L129 46 L150 36",
    sparkTone: "#F45B69",
  },
];

const userVaults = [
  ["Systemic Meme Growth", "0x2b80...6f4b", "72.87%", "$11,073,850.65", "$0.00", "247", "up"],
  ["Delta Neutral Grids", "0x2b80...6f4b", "72.28%", "$8,510,509.77", "$0.00", "466", "up"],
  ["Growi HF", "0x7789...f60d", "33.76%", "$7,901,349.02", "$0.00", "664", "up"],
  ["Ultron", "0x8d3f...c056", "149.66%", "$5,159,339.58", "$0.00", "151", "up"],
  ["drkmttr", "0xf4f7...239f", "728.02%", "$4,447,173.82", "$0.00", "145", "up"],
  ["Bitcoin Moving Average Long/Short", "0x1fa1...1d08", "-13.57%", "$3,354,909.66", "$0.00", "214", "down"],
  ["Orbit Value Strategies", "0xf292...9edf", "114.40%", "$3,097,298.94", "$0.00", "140", "up"],
  ["AIQuantPulse", "0xcbdf...b4b3", "-0.45%", "$2,671,948.60", "$0.00", "91", "down"],
  ["FC Genesis Quantum", "0x3d32...cfec", "0.23%", "$2,448,049.86", "$0.00", "233", "up"],
  ["Long Meme Majors", "0xa380...d939", "133.31%", "$2,056,560.45", "$0.00", "389", "up"],
];

const sparkUp = "M6 42 L16 24 L26 31 L36 16 L46 27 L56 25 L66 30 L76 18 L86 20 L96 14";
const sparkDown = "M6 18 L16 23 L26 27 L36 25 L46 34 L56 36 L66 42 L76 38 L86 35 L96 39";

function MiniSparkline({ tone, path }: { tone: string; path: string }) {
  return (
    <svg viewBox="0 0 160 58" className="h-10 w-24">
      <path d={path} fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UserSparkline({ direction }: { direction: string }) {
  const up = direction === "up";
  return <MiniSparkline tone={up ? "#5EEAD4" : "#F45B69"} path={up ? sparkUp : sparkDown} />;
}

function VaultLogo({ name, tag }: { name: string; tag: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#102B29] text-[11px] font-bold text-[#5EEAD4] ring-1 ring-[#28514D]">
        {tag.slice(0, 1)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-white">{name}</span>
        <span className="mt-0.5 block text-[11px] text-[#7F9A96]">{tag}</span>
      </span>
    </div>
  );
}

export default function VaultPage() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  return (
    <main className="relative min-h-[calc(100vh-44px)] overflow-hidden bg-[#031F1A] text-white">
      <div className="pointer-events-none absolute -bottom-[420px] -left-[260px] h-[760px] w-[760px] rounded-full border border-[rgba(94,234,212,0.10)]" />
      <div className="pointer-events-none absolute -bottom-[360px] -left-[210px] h-[650px] w-[650px] rounded-full border border-[rgba(94,234,212,0.07)]" />
      <div className="pointer-events-none absolute right-[-280px] top-[180px] h-[880px] w-[880px] rounded-full border border-[rgba(94,234,212,0.09)]" />
      <div className="pointer-events-none absolute right-[-200px] top-[250px] h-[740px] w-[740px] rounded-full border border-[rgba(94,234,212,0.06)]" />

      <div className="relative z-10 border-b border-[#143A36] bg-[#5EEAD4] px-4 py-3 text-[13px] font-semibold text-[#03110F]">
        DEXI vaults are self-custody liquidity products. Connect wallet to view your LP positions.
      </div>

      <div className="relative z-10 mx-auto max-w-[1312px] px-6 py-10">
        <section className="mb-7 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-[42px] font-semibold leading-none tracking-normal text-white">Vaults</h1>
            <div className="mt-7 w-[360px] max-w-full rounded-[8px] bg-[#0B171E] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
              <div className="text-[13px] text-[#8E9AA7]">Total locked value</div>
              <div className="mt-2 font-mono text-[31px] font-semibold leading-tight text-white">$479,025,345</div>
            </div>
          </div>

          <button
            onClick={() => openConnectModal?.()}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-[#5EEAD4] px-5 text-[14px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8]"
          >
            <Wallet className="h-4 w-4" />
            {isConnected ? "Manage connection" : "Connect wallet"}
          </button>
        </section>

        <section className="rounded-[8px] bg-[#0B171E] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex h-9 w-full items-center gap-2 rounded-[7px] border border-[#263845] bg-[#0D1920] px-3 lg:max-w-[410px]">
              <Search className="h-4 w-4 text-[#A7B2BE]" />
              <input
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-[#77838F]"
                placeholder="Search by vault, manager, or address..."
              />
            </div>
            <div className="flex items-center gap-2">
              <button className="inline-flex h-9 items-center gap-2 rounded-[7px] border border-[#263845] bg-[#0D1920] px-3 text-[13px] font-semibold text-white">
                Leading, Deposited, Others
                <ChevronDown className="h-4 w-4 text-[#8E9AA7]" />
              </button>
              <button className="inline-flex h-9 items-center gap-2 rounded-[7px] border border-[#263845] bg-[#0D1920] px-3 text-[13px] font-semibold text-white">
                30D
                <ChevronDown className="h-4 w-4 text-[#8E9AA7]" />
              </button>
            </div>
          </div>

          <section className="mb-9 overflow-x-auto">
            <h2 className="mb-5 text-[15px] font-semibold text-white">Protocol vaults</h2>
            <div className="min-w-[930px]">
              <div className="grid grid-cols-[minmax(240px,1.6fr)_minmax(120px,1fr)_110px_minmax(150px,1fr)_120px_90px_110px] items-center pb-3 text-[12px] text-[#77838F]">
                <span>Vault</span>
                <span>Manager</span>
                <span>APR</span>
                <span>TVL</span>
                <span>Your deposit</span>
                <span>Age days</span>
                <span className="text-right">Snapshot</span>
              </div>
              {protocolVaults.map((vault) => (
                <div
                  key={vault.name}
                  className="grid grid-cols-[minmax(240px,1.6fr)_minmax(120px,1fr)_110px_minmax(150px,1fr)_120px_90px_110px] items-center border-t border-[#263845] py-3 text-[13px]"
                >
                  <VaultLogo name={vault.name} tag={vault.tag} />
                  <span className="font-mono font-semibold text-white">{vault.manager}</span>
                  <span className={`font-mono ${vault.aprTone}`}>{vault.apr}</span>
                  <span className="font-mono font-semibold text-white">{vault.tvl}</span>
                  <span className="font-mono font-semibold text-white">{vault.deposit}</span>
                  <span className="font-mono font-semibold text-white">{vault.age}</span>
                  <span className="flex justify-end">
                    <MiniSparkline tone={vault.sparkTone} path={vault.spark} />
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-x-auto">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-white">User vaults</h2>
              <button className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#8E9AA7] hover:text-white">
                <SlidersHorizontal className="h-4 w-4" />
                Filter
              </button>
            </div>
            <div className="min-w-[930px]">
              <div className="grid grid-cols-[minmax(280px,1.7fr)_minmax(120px,1fr)_110px_minmax(150px,1fr)_120px_90px_110px] items-center pb-3 text-[12px] text-[#77838F]">
                <span>Vault</span>
                <span>Manager</span>
                <span>APR</span>
                <span>TVL</span>
                <span>Your deposit</span>
                <span>Age days</span>
                <span className="text-right">Snapshot</span>
              </div>
              {userVaults.map(([name, manager, apr, tvl, deposit, age, trend], index) => {
                const positive = !apr.startsWith("-");
                return (
                  <div
                    key={name}
                    className="grid grid-cols-[minmax(280px,1.7fr)_minmax(120px,1fr)_110px_minmax(150px,1fr)_120px_90px_110px] items-center border-t border-[#263845] py-2.5 text-[13px]"
                  >
                    <VaultLogo name={name} tag={`V${index + 1}`} />
                    <span className="font-mono font-semibold text-white">{manager}</span>
                    <span className={`font-mono ${positive ? "text-[#20D7A1]" : "text-[#F45B69]"}`}>{apr}</span>
                    <span className="font-mono font-semibold text-white">{tvl}</span>
                    <span className="font-mono font-semibold text-white">{deposit}</span>
                    <span className="font-mono font-semibold text-white">{age}</span>
                    <span className="flex justify-end">
                      <UserSparkline direction={trend} />
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 flex items-center justify-end gap-4 text-[13px] text-white">
              <span>Rows per page:</span>
              <button className="inline-flex items-center gap-1 font-semibold">
                10 <ChevronDown className="h-4 w-4" />
              </button>
              <span>1-10 of 3290</span>
              <button className="text-[#72878B] hover:text-white">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button className="text-white hover:text-[#5EEAD4]">
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </section>
        </section>
      </div>

      <div className="fixed bottom-3 left-3 z-20 rounded-[4px] border border-[#5EEAD4]/40 bg-[#0F2528] px-2 py-1 text-[12px] text-[#5EEAD4]">
        Online
      </div>
      <div className="fixed bottom-4 right-5 z-20 flex gap-5 text-[12px] font-semibold text-white/80">
        <span>Docs</span>
        <span>Support</span>
        <span>Terms</span>
        <span>Privacy</span>
      </div>
    </main>
  );
}
