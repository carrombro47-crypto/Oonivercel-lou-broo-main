import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Live Player",
  description: "Simple HLS live proxy + player",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
