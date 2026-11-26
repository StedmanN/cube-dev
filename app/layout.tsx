import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

import "./globals.css";
import "./app-shell.css";

export const metadata: Metadata = {
  title: "p-72",
  description: "72nd / AFSC-MXDE application environment",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SessionProvider>{children}</SessionProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
