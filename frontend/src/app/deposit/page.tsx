"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ChevronDown, DollarSign, Wallet, X } from "lucide-react";

const actionButtons = [
  "链质押",
  "稳定币兑换",
  "合约 ↔ 现货",
  "EVM ↔ Core",
  "组合保证金",
  "发送",
  "提款",
  "存款",
];

const pnlRows = [
  ["盈亏", "$0.00"],
  ["成交量", "$0.00"],
  ["最大回撤", "0.00%"],
  ["总权益", "$0.00"],
  ["合约账户权益", "$0.00"],
  ["现货账户权益", "$0.00"],
  ["Earn余额", "$0.00"],
];

const historyTabs = ["余额", "仓位", "预测", "当前委托", "TWAP", "历史成交", "资金费历史", "历史委托", "利息", "存款和提款"];

function PortfolioBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -bottom-[420px] -left-[260px] h-[760px] w-[760px] rounded-full border border-[rgba(51,64,82,0.18)]" />
      <div className="absolute -bottom-[360px] -left-[210px] h-[650px] w-[650px] rounded-full border border-[rgba(51,64,82,0.12)]" />
      <div className="absolute right-[-260px] top-[150px] h-[880px] w-[880px] rounded-full border border-[rgba(51,64,82,0.16)]" />
      <div className="absolute right-[-180px] top-[240px] h-[710px] w-[710px] rounded-full border border-[rgba(51,64,82,0.10)]" />
    </div>
  );
}

function SelectRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-10 items-center justify-between rounded-[6px] border border-[#334052] bg-[#111922] px-3">
      <span className="text-[13px] text-[#C3D0D8]">{label}</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#05070D]/72 px-4 backdrop-blur-[6px]">
      <section className="relative w-full max-w-[540px] rounded-[16px] border border-[#334052] bg-[#121822] px-7 pb-7 pt-8 shadow-[0_30px_100px_rgba(0,0,0,0.38)]">
        <Link
          href="/deposit"
          className="absolute right-5 top-5 flex h-7 w-7 items-center justify-center rounded-full text-[#C3D0D8] transition-colors hover:bg-[#1D2430] hover:text-white"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </Link>

        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#5EEAD4] text-[#061215] ring-4 ring-[rgba(94,234,212,0.16)]">
          <DollarSign className="h-7 w-7" />
        </div>

        <div className="mt-5 text-center">
          <h1 className="text-[22px] font-semibold text-white">
            {isDeposit ? "向交易账户存入 BNB" : "从交易账户提取 BNB"}
          </h1>
          <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-5 text-[#C3D0D8]">
            {isDeposit
              ? "资金会进入链上托管合约，随后可作为合约保证金使用。"
              : "提款会按 SettlementV2 证明路径处理，余额不足时保持不可用。"}
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <SelectRow label="Asset" value="BNB" />
          <SelectRow label={isDeposit ? "充值链" : "提款链"} value="BSC Mainnet" />
          <div className="flex h-10 items-center justify-between rounded-[6px] border border-[#334052] bg-[#111922] px-3">
            <span className="text-[13px] text-[#C3D0D8]">金额</span>
            <span className="text-[13px] font-semibold text-[#5EEAD4]">最大值: 0.00</span>
          </div>
        </div>

        <button
          onClick={() => openConnectModal?.()}
          className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-[7px] bg-[#5EEAD4] text-[14px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8]"
        >
          <Wallet className="h-4 w-4" />
          {isDeposit ? "连接钱包进行存款" : "连接钱包进行提款"}
        </button>

        {!isDeposit && (
          <div className="mt-4 border-t border-[#2B3542] pt-4 text-center text-[12px] leading-5 text-[#8E9AA7]">
            如果您的现货余额中有 BNB，转账到合约账户后可以提取。提款通常在数分钟内到账。
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
    <main className="relative min-h-screen overflow-hidden bg-[#0A0C11] text-white">
      <PortfolioBackground />
      <div className="relative z-10 border-b border-[#2B3542] bg-[#10141B] px-4 py-3 text-[13px] text-[#8FF7E8]">
        欢迎来到 DEXI：连接钱包后即可管理存款、提款和合约保证金。
      </div>

      <div className="relative z-10 mx-auto max-w-[1312px] px-6 py-9">
        <section className="mb-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <h1 className="text-[42px] font-semibold leading-none tracking-normal text-white">投资组合</h1>
          <div className="flex max-w-[760px] flex-wrap justify-end gap-2">
            {actionButtons.map((label) => {
              const active = (activeModal === "deposit" && label === "存款") || (activeModal === "withdraw" && label === "提款");
              const href = label === "存款" ? "/deposit?modal=deposit" : label === "提款" ? "/deposit?modal=withdraw" : "#";
              return (
                <Link
                  key={label}
                  href={href}
                  className={`inline-flex h-10 items-center justify-center rounded-[7px] border px-4 text-[13px] font-semibold transition-colors ${
                    active
                      ? "border-[#B7FFF5] bg-[#B7FFF5] text-[#061215]"
                      : "border-[#2B746E] bg-transparent text-[#5EEAD4] hover:border-[#5EEAD4]"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </section>

        <section className="grid gap-2 lg:grid-cols-[324px_324px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="rounded-[8px] bg-[#121822] p-4">
              <div className="text-[13px] text-[#8E9AA7]">14天成交量</div>
              <div className="mt-4 font-mono text-[32px] leading-none text-white">$0</div>
              <button className="mt-5 text-[13px] font-semibold text-[#5EEAD4]">查看成交量</button>
            </div>
            <div className="rounded-[8px] bg-[#121822] p-4">
              <div className="flex items-center justify-between text-[13px] text-[#8E9AA7]">
                <span>费用（买方 / 卖方）</span>
                <button className="inline-flex items-center gap-1 font-semibold text-white">
                  合约 <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 font-mono text-[31px] leading-none text-white">0.0450% / 0.0150%</div>
              <button className="mt-5 text-[13px] font-semibold text-[#5EEAD4]">查看费用表</button>
            </div>
          </div>

          <div className="rounded-[8px] bg-[#121822]">
            <div className="flex h-9 items-center justify-between border-b border-[#2B3542] px-3 text-[13px] font-semibold text-white">
              <span className="inline-flex items-center gap-1">
                合约 + 现货 + 金库
                <ChevronDown className="h-4 w-4 text-[#8E9AA7]" />
              </span>
              <span>30D <ChevronDown className="inline h-4 w-4 text-[#8E9AA7]" /></span>
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

          <div className="rounded-[8px] bg-[#121822]">
            <div className="flex h-9 items-center justify-between border-b border-[#2B3542] px-3">
              <div className="flex h-full items-center gap-5 text-[13px]">
                <span className="text-[#8E9AA7]">账户金额</span>
                <span className="relative flex h-full items-center font-semibold text-white">
                  盈亏
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#5EEAD4]" />
                </span>
                <span className="text-[#8E9AA7]">合约盈亏</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-white">
                30D <ChevronDown className="h-4 w-4 text-[#8E9AA7]" />
              </span>
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
                2026 五月 4: $0
              </span>
            </div>
          </div>
        </section>

        <section className="mt-2 rounded-[8px] bg-[#121822]">
          <div className="flex min-h-9 items-center gap-5 border-b border-[#2B3542] px-3 text-[13px]">
            {historyTabs.map((tab) => (
              <span
                key={tab}
                className={`relative flex h-9 items-center ${
                  tab === "资金费历史" ? "font-semibold text-white" : "text-[#8E9AA7]"
                }`}
              >
                {tab}
                {tab === "资金费历史" && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#5EEAD4]" />}
              </span>
            ))}
            <button className="ml-auto inline-flex items-center gap-1 font-semibold text-white">
              筛选 <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-5 px-3 py-3 text-[13px] text-[#8E9AA7]">
            <span>时间 <ChevronDown className="inline h-4 w-4" /></span>
            <span>币种</span>
            <span>数量</span>
            <span>仓位方向</span>
            <span>支付</span>
          </div>
          <div className="px-3 pb-5 text-[13px] font-semibold text-white">尚无资金分配</div>
          <button className="px-3 pb-3 text-[13px] font-semibold text-[#5EEAD4]">导出为 CSV</button>
        </section>
      </div>

      <div className="fixed bottom-3 left-3 z-20 rounded-[4px] border border-[#5EEAD4]/40 bg-[#0F2528] px-2 py-1 text-[12px] text-[#5EEAD4]">
        ● 在线
      </div>
      <div className="fixed bottom-4 right-5 z-20 flex gap-5 text-[12px] font-semibold text-white/80">
        <span>文档</span>
        <span>支持</span>
        <span>条款</span>
        <span>隐私政策</span>
      </div>

      {activeModal && <FundingModal mode={activeModal} />}
    </main>
  );
}
