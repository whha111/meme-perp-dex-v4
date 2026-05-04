import type { Metadata } from "next";
import "./globals.css";
import "@rainbow-me/rainbowkit/styles.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "DEXI | Meme Spot & Perpetual Markets",
  description: "A self-custody meme token launch, spot trading, and perpetual trading terminal on BSC.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-okx-bg-primary min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
