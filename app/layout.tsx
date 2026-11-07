import type { Metadata } from "next";
import { Geist, Geist_Mono, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import SheetTransition from "@/components/ui/SheetTransition";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const barlow = Barlow_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: "500",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CloudScan",
  description: "3D building layouts for firefighters, from a photo or an address.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${barlow.variable} ${jetbrains.variable} antialiased`}
      >
        <SheetTransition>{children}</SheetTransition>
      </body>
    </html>
  );
}
