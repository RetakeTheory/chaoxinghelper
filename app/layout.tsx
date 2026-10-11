import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "学习补给站", description: "学习通助手" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
