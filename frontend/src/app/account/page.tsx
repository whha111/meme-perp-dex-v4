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
    <main className="min-h-screen bg-[#11161E] text-[#F3F7F9]">
      <section className="mx-auto flex min-h-[calc(100vh-44px)] max-w-[1280px] items-center justify-center px-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#5EEAD4] border-t-transparent" />
      </section>
    </main>
  ),
});

const headerStats = [
  ["账户净值", "--"],
  ["可用余额", "--"],
  ["保证金使用率", "--"],
  ["历史盈亏", "--"],
];

const holdings = [
  ["B", "BNB", "BSC gas / collateral", "--", "--", "--"],
  ["U", "USDT", "Quote collateral", "--", "--", "--"],
  ["M", "Meme Perps", "Unrealized PnL", "--", "--", "--"],
  ["F", "Funding", "Funding payments", "--", "--", "--"],
];

const statusRows: Array<{ label: string; value: string; Icon: LucideIcon }> = [
  { label: "托管合约", value: "SettlementV2", Icon: ShieldCheck },
  { label: "提款路径", value: "Merkle proof", Icon: LockKeyhole },
  { label: "资金状态", value: "等待钱包连接", Icon: Clock3 },
];

export default function AccountPage() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  if (isConnected) {
    return <AccountFullPage />;
  }

  return (
    <main className="min-h-screen bg-[#11161E] text-[#F3F7F9]">
      <div className="mx-auto max-w-[1280px] px-6 py-8">
        <section className="flex flex-col gap-6 border-b border-[#2B3542] pb-7 lg:flex-row lg:items-center">
          <div className="flex min-w-[230px] items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[#2B3542] bg-[#151A22] shadow-[0_0_0_6px_rgba(94,234,212,0.08)]">
              <span className="dexi-logo-mark h-8 w-8 rounded-full text-[13px]">D</span>
            </div>
            <div>
              <h1 className="text-[28px] font-semibold leading-tight tracking-normal text-[#F7FAFC]">资产组合</h1>
              <p className="mt-1 text-[13px] text-[#8E9AA7]">BNB / USDT 保证金与合约账户</p>
            </div>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-y-4 md:grid-cols-4">
            {headerStats.map(([label, value], index) => (
              <div key={label} className={`px-5 ${index > 0 ? "md:border-l md:border-[#2B3542]" : ""}`}>
                <div className="text-[13px] text-[#8E9AA7]">{label}</div>
                <div className="mt-2 font-mono text-[24px] font-semibold text-[#F3F7F9]">{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,840px)_400px]">
          <div className="min-w-0">
            <section className="border-b border-[#2B3542] pb-8">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button className="rounded-full border border-[#374555] px-4 py-2 text-[13px] font-semibold text-[#F3F7F9]">
                    账户净值
                  </button>
                  <button className="rounded-full border border-[#374555] px-4 py-2 text-[13px] text-[#8E9AA7]">
                    保证金
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {["7天", "30天", "90天"].map((range, index) => (
                    <button
                      key={range}
                      className={`rounded-full border px-3 py-2 text-[13px] ${
                        index === 1
                          ? "border-[#C3D0D8] text-[#F3F7F9]"
                          : "border-[#374555] text-[#8E9AA7]"
                      }`}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3">
                <div className="text-[13px] text-[#8E9AA7]">2026年5月4日</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-[22px] font-semibold text-[#F3F7F9]">--</span>
                  <span className="font-mono text-[15px] font-semibold text-[#20D7A1]">--</span>
                </div>
              </div>

              <div
                className="relative h-[360px] overflow-hidden border-b border-[#2B3542]"
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
                <div className="absolute bottom-0 left-0 right-0 flex justify-between border-t border-[#2B3542] px-4 py-2 text-[12px] text-[#77838F]">
                  <span>4/5 0时</span>
                  <span>4/12 0时</span>
                  <span>4/19 0时</span>
                  <span>4/26 0时</span>
                  <span>5/3 0时</span>
                </div>
                <div className="absolute right-0 top-14 grid gap-[72px] text-right text-[12px] text-[#77838F]">
                  <span>US$--</span>
                  <span>US$--</span>
                  <span>US$--</span>
                </div>
              </div>
            </section>

            <section className="mt-8">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-[24px] font-semibold text-[#F7FAFC]">持有资产</h2>
                  <span className="rounded-[4px] bg-[#374555] px-2 py-1 text-[12px] font-semibold text-[#F3F7F9]">0</span>
                </div>
                <button className="text-[13px] font-semibold text-[#8FF7E8]">指标 ↗</button>
              </div>

              <div className="mb-4 flex h-10 items-center gap-2 rounded-full border border-[#374555] bg-[#1D2430] px-4">
                <Search className="h-4 w-4 text-[#B8C2CC]" />
                <input
                  className="h-full flex-1 bg-transparent text-[14px] text-[#F3F7F9] outline-none placeholder:text-[#8E9AA7]"
                  placeholder="键入以查询"
                />
              </div>

              <div className="overflow-hidden rounded-[12px] border border-[#374555]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#374555] bg-[#151A22] text-left text-[13px] font-medium text-[#A0ACB8]">
                      <th className="px-4 py-3">市场</th>
                      <th className="px-4 py-3 text-right">数量</th>
                      <th className="px-4 py-3 text-right">过去30天盈亏</th>
                      <th className="px-4 py-3 text-right">资产</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map(([initial, symbol, desc, qty, pnl, value]) => (
                      <tr key={symbol} className="border-b border-[#2B3542] bg-[#151A22] last:border-b-0">
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2B3542] text-[13px] font-bold text-[#F3F7F9]">
                              {initial}
                            </span>
                            <span>
                              <span className="block text-[14px] font-semibold text-[#F3F7F9]">{symbol}</span>
                              <span className="mt-0.5 block text-[12px] text-[#77838F]">{desc}</span>
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-[#B8C2CC]">{qty}</td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-[#F3F7F9]">{pnl}</td>
                        <td className="px-4 py-4 text-right font-mono text-[14px] text-[#F3F7F9]">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-[10px] border border-[#374555] bg-[#151A22] p-4">
                <div className="text-[13px] text-[#8E9AA7]">您的保证库余额</div>
                <div className="mt-2 font-mono text-[22px] font-semibold text-[#F3F7F9]">--</div>
              </div>
              <div className="rounded-[10px] border border-[#374555] bg-[#151A22] p-4">
                <div className="text-[13px] text-[#8E9AA7]">您的历史盈亏记录</div>
                <div className="mt-2 font-mono text-[22px] font-semibold text-[#F3F7F9]">--</div>
              </div>
            </div>

            <section className="rounded-[10px] bg-[#151A22] p-5">
              <div className="mb-5 grid grid-cols-2 rounded-[8px] bg-[#10141B] p-1">
                <button className="h-11 rounded-[7px] text-[18px] font-medium text-[#77838F]">添加资金</button>
                <button className="h-11 rounded-[7px] bg-[#0A0C11] text-[18px] font-semibold text-[#F3F7F9]">提取资金</button>
              </div>

              <div className="rounded-[6px] bg-[#1D2430] p-3">
                <div className="mb-1 flex items-center justify-between text-[12px] text-[#8E9AA7]">
                  <span>提取金额</span>
                  <button className="rounded-[6px] bg-[#5EEAD4] px-2 py-1 text-[12px] font-semibold text-[#061215]">
                    最大值
                  </button>
                </div>
                <div className="font-mono text-[16px] text-[#8E9AA7]">$0.00</div>
              </div>

              <div className="mt-5 rounded-[6px] bg-[#10141B] p-4">
                {[
                  ["无交叉保证金", "$0.00"],
                  ["估计滑点", "0.00%"],
                  ["估计收到的金额", "--"],
                ].map(([label, value]) => (
                  <div key={label} className="mb-3 flex justify-between text-[14px] last:mb-0">
                    <span className="text-[#A0ACB8]">{label}</span>
                    <span className="font-mono font-semibold text-[#F3F7F9]">{value}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => openConnectModal?.()}
                className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-[#374555] text-[14px] font-semibold text-[#A7B2BE] transition-colors hover:bg-[#242D3A]"
              >
                <Wallet className="h-4 w-4" />
                连接钱包
              </button>
            </section>

            <section className="rounded-[10px] border border-[#374555] p-5">
              <div className="mb-4 flex justify-center">
                <div className="h-9 w-9 animate-spin rounded-full border-2 border-dashed border-[#77838F]" />
              </div>
              <div className="text-center text-[14px] text-[#8E9AA7]">您没有保证库余额。</div>
            </section>

            <section className="rounded-[10px] border border-[#2B3542] bg-[#151A22]">
              {statusRows.map(({ label, value, Icon }) => (
                <div key={label} className="flex items-center justify-between border-b border-[#2B3542] px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-[#222A35] text-[#8FF7E8]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-[13px] font-semibold text-[#F3F7F9]">{label}</span>
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
