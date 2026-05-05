"use client";

import dynamic from "next/dynamic";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock3,
  LockKeyhole,
  Search,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

const AccountFullPage = dynamic(() => import("./AccountFullPage"), {
  ssr: false,
  loading: () => (
    <main className="min-h-screen bg-[#031F1A] text-[#F3F7F9]">
      <section className="mx-auto flex min-h-[calc(100vh-44px)] max-w-[1280px] items-center justify-center px-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#5EEAD4] border-t-transparent" />
      </section>
    </main>
  ),
});

const headerStats = [
  ["Account equity", "--"],
  ["Available balance", "--"],
  ["Margin used", "--"],
  ["Lifetime PnL", "--"],
];

const holdings = [
  ["B", "BNB", "Gas and collateral", "--", "--", "--"],
  ["U", "USDT", "Quote collateral", "--", "--", "--"],
  ["M", "Meme Perps", "Unrealized PnL", "--", "--", "--"],
  ["F", "Funding", "Funding payments", "--", "--", "--"],
];

const statusRows: Array<{ label: string; value: string; Icon: LucideIcon }> = [
  { label: "Custody", value: "SettlementV2", Icon: ShieldCheck },
  { label: "Withdrawal path", value: "Merkle proof", Icon: LockKeyhole },
  { label: "Funding state", value: "Waiting for wallet", Icon: Clock3 },
];

function PortfolioBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -bottom-[420px] -left-[280px] h-[760px] w-[760px] rounded-full border border-[rgba(94,234,212,0.10)]" />
      <div className="absolute -bottom-[350px] -left-[210px] h-[620px] w-[620px] rounded-full border border-[rgba(94,234,212,0.06)]" />
      <div className="absolute right-[-300px] top-[160px] h-[900px] w-[900px] rounded-full border border-[rgba(94,234,212,0.08)]" />
    </div>
  );
}

export default function AccountPage() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  if (isConnected) {
    return <AccountFullPage />;
  }

  return (
    <main className="relative min-h-[calc(100vh-44px)] overflow-hidden bg-[#031F1A] text-[#F3F7F9]">
      <PortfolioBackground />
      <div className="relative z-10 mx-auto max-w-[1312px] px-6 py-10">
        <section className="flex flex-col gap-8 pb-8 lg:flex-row lg:items-center">
          <div className="flex min-w-[280px] items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[#28514D] bg-[#0B171E] shadow-[0_0_0_6px_rgba(94,234,212,0.08)]">
              <span className="dexi-logo-mark h-8 w-8 rounded-full text-[13px]">D</span>
            </div>
            <div>
              <h1 className="text-[42px] font-semibold leading-none tracking-normal text-white">Portfolio</h1>
              <p className="mt-3 text-[14px] text-[#9DB3AF]">BNB and USDT collateral, positions, orders, and ledger.</p>
            </div>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-2 md:grid-cols-4">
            {headerStats.map(([label, value]) => (
              <div key={label} className="rounded-[8px] bg-[#0B171E] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
                <div className="text-[13px] text-[#8E9AA7]">{label}</div>
                <div className="mt-4 font-mono text-[28px] font-semibold leading-none text-white">{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-8 lg:grid-cols-[minmax(0,840px)_400px]">
          <div className="min-w-0">
            <section className="rounded-[8px] bg-[#0B171E] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button className="rounded-full border border-[#5EEAD4] px-4 py-2 text-[13px] font-semibold text-white">
                    Account equity
                  </button>
                  <button className="rounded-full border border-[#28514D] px-4 py-2 text-[13px] text-[#8E9AA7]">
                    Collateral
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {["7D", "30D", "90D"].map((range, index) => (
                    <button
                      key={range}
                      className={`rounded-full border px-3 py-2 text-[13px] ${
                        index === 1 ? "border-[#C3D0D8] text-white" : "border-[#28514D] text-[#8E9AA7]"
                      }`}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3">
                <div className="text-[13px] text-[#8E9AA7]">May 4, 2026</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-[22px] font-semibold text-white">--</span>
                  <span className="font-mono text-[15px] font-semibold text-[#20D7A1]">--</span>
                </div>
              </div>

              <div
                className="relative h-[360px] overflow-hidden border-b border-[#263845]"
                style={{
                  backgroundImage: "radial-gradient(circle, rgba(243,247,249,0.055) 1px, transparent 1px)",
                  backgroundSize: "14px 14px",
                }}
              >
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 840 360" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="accountLine" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0%" stopColor="#5EEAD4" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="#5EEAD4" />
                    </linearGradient>
                  </defs>
                  <polyline
                    fill="none"
                    stroke="url(#accountLine)"
                    strokeWidth="3"
                    points="0,292 42,284 84,268 126,242 168,228 210,220 252,204 294,168 336,150 378,138 420,116 462,108 504,98 546,86 588,66 630,58 672,48 714,34 756,30 798,26 840,18"
                  />
                </svg>
                <div className="absolute bottom-0 left-0 right-0 flex justify-between border-t border-[#263845] px-4 py-2 text-[12px] text-[#77838F]">
                  <span>4/5</span>
                  <span>4/12</span>
                  <span>4/19</span>
                  <span>4/26</span>
                  <span>5/3</span>
                </div>
                <div className="absolute right-0 top-14 grid gap-[72px] text-right text-[12px] text-[#77838F]">
                  <span>US$--</span>
                  <span>US$--</span>
                  <span>US$--</span>
                </div>
              </div>
            </section>

            <section className="mt-8 rounded-[8px] bg-[#0B171E] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-[24px] font-semibold text-white">Holdings</h2>
                  <span className="rounded-[4px] bg-[#28514D] px-2 py-1 text-[12px] font-semibold text-white">0</span>
                </div>
                <button className="text-[13px] font-semibold text-[#8FF7E8]">Metrics</button>
              </div>

              <div className="mb-4 flex h-10 items-center gap-2 rounded-full border border-[#28514D] bg-[#0D1920] px-4">
                <Search className="h-4 w-4 text-[#B8C2CC]" />
                <input
                  className="h-full flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-[#8E9AA7]"
                  placeholder="Search holdings"
                />
              </div>

              <div className="overflow-hidden rounded-[12px] border border-[#263845]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#263845] bg-[#0D1920] text-left text-[13px] font-medium text-[#A0ACB8]">
                      <th className="px-4 py-3">Market</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-right">30D PnL</th>
                      <th className="px-4 py-3 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map(([initial, symbol, desc, qty, pnl, value]) => (
                      <tr key={symbol} className="border-b border-[#263845] bg-[#0B171E] last:border-b-0">
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#102B29] text-[13px] font-bold text-white">
                              {initial}
                            </span>
                            <span>
                              <span className="block text-[14px] font-semibold text-white">{symbol}</span>
                              <span className="mt-0.5 block text-[12px] text-[#77838F]">{desc}</span>
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-[#B8C2CC]">{qty}</td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-white">{pnl}</td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-white">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-[10px] border border-[#263845] bg-[#0B171E] p-4">
                <div className="text-[13px] text-[#8E9AA7]">Vault balance</div>
                <div className="mt-2 font-mono text-[22px] font-semibold text-white">--</div>
              </div>
              <div className="rounded-[10px] border border-[#263845] bg-[#0B171E] p-4">
                <div className="text-[13px] text-[#8E9AA7]">Historical PnL</div>
                <div className="mt-2 font-mono text-[22px] font-semibold text-white">--</div>
              </div>
            </div>

            <section className="rounded-[10px] bg-[#0B171E] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <div className="mb-5 grid grid-cols-2 rounded-[8px] bg-[#081217] p-1">
                <button className="flex h-11 items-center justify-center gap-2 rounded-[7px] text-[15px] font-medium text-[#8E9AA7]">
                  <ArrowDownToLine className="h-4 w-4" />
                  Deposit
                </button>
                <button className="flex h-11 items-center justify-center gap-2 rounded-[7px] bg-[#031F1A] text-[15px] font-semibold text-white">
                  <ArrowUpFromLine className="h-4 w-4" />
                  Withdraw
                </button>
              </div>

              <div className="rounded-[6px] bg-[#0D1920] p-3">
                <div className="mb-1 flex items-center justify-between text-[12px] text-[#8E9AA7]">
                  <span>Withdraw amount</span>
                  <button className="rounded-[6px] bg-[#5EEAD4] px-2 py-1 text-[12px] font-semibold text-[#061215]">
                    Max
                  </button>
                </div>
                <div className="font-mono text-[16px] text-[#8E9AA7]">$0.00</div>
              </div>

              <div className="mt-5 rounded-[6px] bg-[#081217] p-4">
                {[
                  ["Free collateral", "$0.00"],
                  ["Estimated slippage", "0.00%"],
                  ["Estimated received", "--"],
                ].map(([label, value]) => (
                  <div key={label} className="mb-3 flex justify-between text-[14px] last:mb-0">
                    <span className="text-[#A0ACB8]">{label}</span>
                    <span className="font-mono font-semibold text-white">{value}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => openConnectModal?.()}
                className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-[#28514D] text-[14px] font-semibold text-[#A7B2BE] transition-colors hover:bg-[#102B29]"
              >
                <Wallet className="h-4 w-4" />
                Connect wallet
              </button>
            </section>

            <section className="rounded-[10px] border border-[#263845] p-5">
              <div className="mb-4 flex justify-center">
                <div className="h-9 w-9 animate-spin rounded-full border-2 border-dashed border-[#77838F]" />
              </div>
              <div className="text-center text-[14px] text-[#8E9AA7]">No vault balance yet.</div>
            </section>

            <section className="rounded-[10px] border border-[#263845] bg-[#0B171E]">
              {statusRows.map(({ label, value, Icon }) => (
                <div key={label} className="flex items-center justify-between border-b border-[#263845] px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-[#102B29] text-[#8FF7E8]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-[13px] font-semibold text-white">{label}</span>
                      <span className="block text-[12px] text-[#77838F]">{value}</span>
                    </span>
                  </div>
                  <span className="h-2 w-2 rounded-full bg-[#20D7A1]" />
                </div>
              ))}
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
