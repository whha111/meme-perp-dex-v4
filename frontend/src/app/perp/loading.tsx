"use client";

export default function PerpLoading() {
  return (
    <div className="h-screen overflow-hidden bg-[#08080C] text-[#FAFAFD]">
      <nav className="h-[2.75rem] border-b border-[#303045] bg-[#08080C]">
        <div className="flex h-full items-center justify-between px-3">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="dexi-logo-mark rounded-[4px]">D</span>
              <span>DEXI</span>
            </div>
            <div className="hidden h-7 w-56 rounded-[0.375rem] bg-[#181825] lg:block" />
          </div>
          <div className="h-8 w-32 rounded-[0.375rem] bg-[#181825]" />
        </div>
      </nav>

      <div
        className="grid h-[calc(100vh-2.75rem)] gap-px bg-[#303045]"
        style={{
          gridTemplate:
            "'Top Top Top' 2.675rem 'Inner Vertical Side' minmax(0,1fr) 'Horizontal Horizontal Side' 288px / minmax(0,1fr) 18.75rem 20.25rem",
        }}
      >
        <div className="flex items-center gap-5 bg-[#101018] px-4" style={{ gridArea: "Top" }}>
          <div className="h-5 w-28 rounded-[0.25rem] bg-[#181825]" />
          <div className="h-4 w-20 rounded-[0.25rem] bg-[#181825]" />
          <div className="h-4 w-20 rounded-[0.25rem] bg-[#181825]" />
          <div className="h-4 w-24 rounded-[0.25rem] bg-[#181825]" />
        </div>

        <div className="relative bg-[#101018]" style={{ gridArea: "Inner" }}>
          <div className="absolute inset-x-0 top-0 h-[2.625rem] border-b border-[#303045] bg-[#181825]" />
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-xs text-[#807E98]">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#7774FF] border-t-transparent" />
              <span>Loading market</span>
            </div>
          </div>
        </div>

        <div className="bg-[#181825]" style={{ gridArea: "Vertical" }}>
          <div className="h-[2.625rem] border-b border-[#303045]" />
          <div className="space-y-2 p-3">
            {Array.from({ length: 16 }).map((_, index) => (
              <div key={index} className="h-4 rounded-[0.25rem] bg-[#212131]" />
            ))}
          </div>
        </div>

        <div className="grid grid-rows-[7.75rem_minmax(0,1fr)] gap-px bg-[#303045]" style={{ gridArea: "Side" }}>
          <div className="bg-[#181825] p-4">
            <div className="grid gap-2">
              <div className="h-3 w-full rounded bg-[#212131]" />
              <div className="h-3 w-4/5 rounded bg-[#212131]" />
              <div className="h-8 w-full rounded-[0.375rem] bg-[#7774FF]/45" />
            </div>
          </div>
          <div className="bg-[#181825]">
            <div className="h-[2.625rem] border-b border-[#303045]" />
            <div className="h-[2.625rem] border-b border-[#303045]" />
            <div className="space-y-3 p-4">
              <div className="h-12 rounded-[0.5rem] bg-[#101018]" />
              <div className="h-12 rounded-[0.5rem] bg-[#101018]" />
              <div className="h-9 rounded-[0.375rem] bg-[#7774FF]/60" />
            </div>
          </div>
        </div>

        <div className="bg-[#101018]" style={{ gridArea: "Horizontal" }}>
          <div className="h-[2.675rem] border-b border-[#303045]" />
        </div>
      </div>
    </div>
  );
}
