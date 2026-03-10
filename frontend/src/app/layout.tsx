import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "@rainbow-me/rainbowkit/styles.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MemePerpDEX",
  description: "Meme coin spot and perpetual trading platform on Base Chain",
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
      <body className={`${inter.className} bg-okx-bg-primary min-h-screen`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
