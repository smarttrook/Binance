import Providers from "./providers";
import "./globals.css";

export const metadata = {
  title: "Trook Bot",
  description: "Polymarket Trading Bot"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
