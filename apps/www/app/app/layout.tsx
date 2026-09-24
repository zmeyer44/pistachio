import type { Metadata } from "next";
import "./app.css";
import { Shell } from "../../components/app/shell";

export const metadata: Metadata = {
  title: "Pistachio",
  description: "Your agent, your sessions, and what it remembers — from any browser.",
  robots: { index: false, follow: false },
};

export default function AppLayout(props: LayoutProps<"/app">) {
  return (
    <div className="pa">
      <Shell>{props.children}</Shell>
    </div>
  );
}
