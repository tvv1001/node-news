import type { Metadata } from "next";
import "../style.css";
import ThemeSettings from "../components/ThemeSettings";

export const metadata: Metadata = {
  title: "Query Notify",
  description: "Contextual search and live-feed app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body>
        {children}
        <ThemeSettings />
      </body>
    </html>
  );
}
