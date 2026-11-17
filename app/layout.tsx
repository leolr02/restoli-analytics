import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Restoli Analytics",
  description: "Acceso a Restoli Analytics",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" data-theme="restoli-light">
      <body className={`${geistSans.className} antialiased`}>
        {children}
        <Toaster
          position="top-right"
          closeButton
          expand={false}
          visibleToasts={4}
          toastOptions={{
            duration: 5000,
            unstyled: true,
            classNames: {
              toast:
                "group relative flex w-full items-center gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3 pr-10 text-base-content shadow-xl",
              title: "text-sm font-semibold",
              description: "text-sm text-base-content/70",
              actionButton: "btn btn-primary btn-xs",
              cancelButton: "btn btn-ghost btn-xs",
              closeButton: "btn btn-ghost btn-circle btn-xs absolute right-2 top-2",
              success: "ring-1 ring-success/30",
              error: "ring-1 ring-error/30",
              info: "ring-1 ring-info/30",
              warning: "ring-1 ring-warning/30",
              loading: "ring-1 ring-primary/30",
              default: "ring-1 ring-primary/20",
            },
          }}
        />
      </body>
    </html>
  );
}
