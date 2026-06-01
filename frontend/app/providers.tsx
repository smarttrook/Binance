"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { polygon } from "viem/chains";

export default function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmozkzu8c009w0cl19";

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        defaultChain: polygon,
        supportedChains: [polygon],
        appearance: {
          theme: "dark",
          accentColor: "#29d687"
        }
      }}
    >
      {children}
    </PrivyProvider>
  );
}
