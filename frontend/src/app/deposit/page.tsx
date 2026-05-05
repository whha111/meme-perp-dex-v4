"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  DollarSign,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";

const actionButtons = [
  { label: "Bridge", href: "#", muted: true },
  { label: "Stable swap", href: "#", muted: true },
  { label: "Perps to spot", href: "#", muted: true },
  { label: "EVM to Core", href: "#", muted: true },
  { label: "Portfolio margin", href: "#", muted: true },
  { label: "Transfer", href: "#", muted: true },
  { label: "Withdraw", href: "/deposit?modal=withdraw", muted: false },
  { label: "Deposit", href: "/deposit?modal=deposit", muted: false },
];

const pnlRows = [
  ["PnL", "$0.00"],
  ["Volume", "$0.00"],
  ["Max drawdown", "0.00%"],
  ["Total equity", "$0.00"],
  ["Perps equity", "$0.00"],
  ["Spot equity", "$0.00"],
  ["Earn balance", "$0.00"],
];

const historyTabs = ["Balances", "Positions", "Predictions", "Open orders", "TWAP", "Trades", "Funding", "Orders", "Interest", "Deposits"];

function PortfolioBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -bottom-[430px] -left-[280px] h-[780px] w-[780px] rounded-full border border-[rgba(94,234,212,0.10)]" />
      <div className="absolute -bottom-[360px] -left-[200px] h-[640px] w-[640px] rounded-full border border-[rgba(94,234,212,0.07)]" />
      <div className="absolute right-[-280px] top-[160px] h-[880px] w-[880px] rounded-full border border-[rgba(94,234,212,0.09)]" />
      <div className="absolute right-[-180px] top-[260px] h-[720px] w-[720px] rounded-full border border-[rgba(94,234,212,0.06)]" />
    </div>
  );
}

function SelectRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-10 items-center justify-between rounded-[6px] border border-[#263845] bg-[#0D1920] px-3">
      <span className="text-[13px] text-[#A7B2BE]">{label}</span>
      <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-white">
        {value}
        <ChevronDown className="h-4 w-4 text-[#77838F]" />
      </span>
    </div>
  );
}

function FundingModal({ mode }: { mode: "deposit" | "withdraw" }) {
  const { openConnectModal } = useConnectModal();
  const isDeposit = mode === "deposit";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#03110F]/72 px-4 backdrop-blur-[8px]">
      <section className="relative w-full max-w-[540px] rounded-[16px] border border-[#29464A] bg-[#0D181E] px-7 pb-7 pt-8 shadow-[0_30px_100px_rgba(0,0,0,0.46)]">
        <Link
          href="/deposit"
          replace
          className="absolute right-5 top-5 flex h-7 w-7 items-center justify-center rounded-full text-[#C3D0D8] transition-colors hover:bg-[#16242C] hover:text-white"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </Link>

        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#5EEAD4] text-[#061215] ring-4 ring-[rgba(94,234,212,0.16)]">
          <DollarSign className="h-7 w-7" />
        </div>

        <div className="mt-5 text-center">
          <h1 className="text-[22px] font-semibold text-white">
            {isDeposit ? "Deposit BNB to trading account" : "Withdraw BNB to wallet"}
          </h1>
          <p className="mx-auto mt-2 max-w-[370px] text-[13px] leading-5 text-[#A7B2BE]">
            {isDeposit
              ? "Funds stay in the on-chain settlement contract and become available as trading margin."
              : "Withdrawals use the SettlementV2 proof path. Forced withdrawal remains available as the emergency route."}
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <SelectRow label="Asset" value="BNB" />
          <SelectRow label={isDeposit ? "Deposit chain" : "Withdraw chain"} value="BSC Mainnet" />
          <div className="flex h-10 items-center justify-between rounded-[6px] border border-[#263845] bg-[#0D1920] px-3">
            <span className="text-[13px] text-[#A7B2BE]">Amount</span>
            <span className="text-[13px] font-semibold text-[#5EEAD4]">Max: 0.00</span>
          </div>
        </div>

        <button
          onClick={() => openConnectModal?.()}
          className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-[7px] bg-[#5EEAD4] text-[14px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8]"
        >
          <Wallet className="h-4 w-4" />
          {isDeposit ? "Connect wallet to deposit" : "Connect wallet to withdraw"}
        </button>

        {!isDeposit && (
          <div className="mt-4 border-t border-[#263845] pt-4 text-center text-[12px] leading-5 text-[#7F8C98]">
            Withdrawal estimates unlock after a wallet session is active.
          </div>
        )}
      </section>
    </div>
  );
}

export default function DepositPage() {
  const searchParams = useSearchParams();
  const modalParam = searchParams.get("modal");
  const legacyTab = searchParams.get("tab");
  const activeModal =
    modalParam === "deposit" || modalParam === "withdraw"
      ? modalParam
      : legacyTab === "withdraw"
        ? "withdraw"
        : null;

  return (
    <main className="relative min-h-[calc(100vh-44px)] overflow-hidden bg-[#031F1A] text-white">
      <PortfolioBackground />
      <div className="relative z-10 border-b border-[#143A36] bg-[#5EEAD4] px-4 py-3 text-[13px] font-semibold text-[#03110F]">
        Non-custodial funding center. Deposits and withdrawals are signed by your wallet and settled on BSC.
      </div>

      <div className="relative z-10 mx-auto max-w-[1312px] px-6 py-9">
        <section className="mb-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-[42px] font-semibold leading-none tracking-normal text-white">Portfolio</h1>
            <p className="mt-3 max-w-[560px] text-[14px] leading-6 text-[#9DB3AF]">
              Manage collateral, movement between spot and perps, and proof-based withdrawals from one surface.
            </p>
          </div>

          <div className="flex max-w-[760px] flex-wrap justify-start gap-2 lg:justify-end">
            {actionButtons.map((item) => {
              const active =
                (activeModal === "deposit" && item.label === "Deposit") ||
                (activeModal === "withdraw" && item.label === "Withdraw");
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className={`inline-flex h-10 items-center justify-center rounded-[7px] border px-4 text-[13px] font-semibold transition-colors ${
                    active
                      ? "border-[#B7FFF5] bg-[#B7FFF5] text-[#061215]"
                      : item.muted
                        ? "border-[#24514C] bg-transparent text-[#6BA8A0]"
                        : "border-[#2B746E] bg-transparent text-[#5EEAD4] hover:border-[#5EEAD4]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </section>

        <section className="grid gap-2 lg:grid-cols-[324px_324px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="rounded-[8px] bg-[#0B171E] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <div className="text-[13px] text-[#8E9AA7]">14 day volume</div>
              <div className="mt-4 font-mono text-[32px] leading-none text-white">$0</div>
              <button className="mt-5 text-[13px] font-semibold text-[#5EEAD4]">View fills</button>
            </div>
            <div className="rounded-[8px] bg-[#0B171E] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <div className="flex items-center justify-between text-[13px] text-[#8E9AA7]">
                <span>Fees buyer / seller</span>
                <button className="inline-flex items-center gap-1 font-semibold text-white">
                  Perps <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 font-mono text-[31px] leading-none text-white">0.0450% / 0.0150%</div>
              <button className="mt-5 text-[13px] font-semibold text-[#5EEAD4]">View fee schedule</button>
            </div>
          </div>

          <div className="rounded-[8px] bg-[#0B171E] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
            <div className="flex h-9 items-center justify-between border-b border-[#263845] px-3 text-[13px] font-semibold text-white">
              <span className="inline-flex items-center gap-1">
                Perps + Spot + Vault
                <ChevronDown className="h-4 w-4 text-[#8E9AA7]" />
              </span>
              <span>30D</span>
            </div>
            <div className="space-y-2 p-3 text-[13px]">
              {pnlRows.map(([label, value]) => (
                <div key={label} className="flex justify-between">
                  <span className="text-[#8E9AA7]">{label}</span>
                  <span className="font-mono font-semibold text-white">{value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[8px] bg-[#0B171E] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
            <div className="flex h-9 items-center justify-between border-b border-[#263845] px-3">
              <div className="flex h-full items-center gap-5 text-[13px]">
                <span className="text-[#8E9AA7]">Account equity</span>
                <span className="relative flex h-full items-center font-semibold text-white">
                  PnL
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#5EEAD4]" />
                </span>
                <span className="text-[#8E9AA7]">Perps PnL</span>
              </div>
              <span className="text-[13px] font-semibold text-white">30D</span>
            </div>
            <div className="relative h-[214px] px-12 py-8">
              <div className="absolute bottom-7 left-14 right-8 h-[2px] bg-white" />
              <div className="absolute bottom-7 left-14 top-8 w-[2px] bg-white" />
              <div className="absolute left-8 top-7 grid h-[162px] content-between text-[13px] font-semibold text-white">
                <span>3</span>
                <span>2</span>
                <span>1</span>
                <span>0</span>
              </div>
              <span className="absolute left-16 top-[72px] rounded bg-black px-1 py-0.5 text-[13px] font-semibold text-white">
                May 2026: $0
              </span>
            </div>
          </div>
        </section>

        <section className="mt-2 rounded-[8px] bg-[#0B171E] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
          <div className="flex min-h-9 items-center gap-5 overflow-x-auto border-b border-[#263845] px-3 text-[13px]">
            {historyTabs.map((tab) => (
              <span
                key={tab}
                className={`relative flex h-9 shrink-0 items-center ${
                  tab === "Funding" ? "font-semibold text-white" : "text-[#8E9AA7]"
                }`}
              >
                {tab}
                {tab === "Funding" && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#5EEAD4]" />}
              </span>
            ))}
            <button className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-white">
              Filter <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-5 px-3 py-3 text-[13px] text-[#8E9AA7]">
            <span>Time</span>
            <span>Coin</span>
            <span>Amount</span>
            <span>Direction</span>
            <span>Payment</span>
          </div>
          <div className="px-3 pb-5 text-[13px] font-semibold text-white">No funding payments yet</div>
          <button className="px-3 pb-4 text-[13px] font-semibold text-[#5EEAD4]">Export CSV</button>
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

      {activeModal && <FundingModal mode={activeModal} />}
    </main>
  );
}
