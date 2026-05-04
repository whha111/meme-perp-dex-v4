"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/perp?marketId=PEPE-USDT-PERP");
  }, [router]);

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <div className="grid min-h-[calc(100vh-48px)] place-items-center">
        <div className="w-[360px] rounded-[8px] border border-okx-border-primary bg-okx-bg-card p-5 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-dexi-accent border-t-transparent" />
          <div className="text-sm font-semibold text-okx-text-primary">Opening trading terminal</div>
          <div className="mt-1 text-xs text-okx-text-tertiary">PEPE / USDT perpetual market</div>
        </div>
      </div>
    </main>
  );
}
