"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, ShieldCheck, ShoppingBasket } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";

export type PurchaseView = "new" | "history";

const PurchaseViewContext = createContext<{
  purchaseView: PurchaseView;
  setPurchaseView: Dispatch<SetStateAction<PurchaseView>>;
} | null>(null);

export function usePurchaseView() {
  const context = useContext(PurchaseViewContext);
  if (!context) throw new Error("usePurchaseView debe usarse dentro de ProtectedShell.");
  return context;
}

export function ProtectedShell({
  email,
  profileLabel,
  isRoot,
  children,
}: {
  email: string;
  profileLabel: string;
  isRoot: boolean;
  children: ReactNode;
}) {
  const [desktopDrawerOpen, setDesktopDrawerOpen] = useState(true);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [purchaseView, setPurchaseView] = useState<PurchaseView>("new");

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      event.preventDefault();
      if (window.matchMedia("(min-width: 64rem)").matches) {
        setDesktopDrawerOpen((isOpen) => !isOpen);
      } else {
        setMobileDrawerOpen((isOpen) => !isOpen);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  return (
    <PurchaseViewContext.Provider value={{ purchaseView, setPurchaseView }}>
    <div className={`drawer min-h-svh ${desktopDrawerOpen ? "lg:drawer-open" : ""}`}>
      <input
        id="main-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={mobileDrawerOpen}
        onChange={(event) => setMobileDrawerOpen(event.target.checked)}
      />

      <div className="drawer-content flex min-h-svh flex-col">
        <header className="navbar sticky top-0 z-10 flex-wrap border-b border-base-300 bg-base-100 px-3 sm:px-5">
          <div className="flex-none">
            <label
              htmlFor="main-drawer"
              className="btn btn-square btn-ghost drawer-button lg:hidden"
              aria-label={mobileDrawerOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={mobileDrawerOpen}
            >
              <Menu className="size-5" aria-hidden="true" />
            </label>
          </div>
          <div className="min-w-0 flex-1 px-2 md:w-64 md:flex-none">
            <p className="truncate text-sm font-semibold" title={email}>
              {email}
            </p>
            <p className="text-xs font-light text-base-content/70">{profileLabel}</p>
          </div>
          <nav
            className="order-last flex w-full items-center justify-center gap-1 rounded-full bg-base-200 p-1 md:order-none md:w-auto md:flex-1"
            role="tablist"
            aria-label="Secciones de compras"
          >
            <button
              type="button"
              role="tab"
              aria-selected={purchaseView === "new"}
              aria-controls="purchase-module-panel"
              className={`btn btn-sm min-h-10 rounded-full ${purchaseView === "new" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setPurchaseView("new")}
            >
              Nueva compra
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={purchaseView === "history"}
              aria-controls="purchase-module-panel"
              className={`btn btn-sm min-h-10 rounded-full ${purchaseView === "history" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setPurchaseView("history")}
            >
              Historial de compras
            </button>
          </nav>
          <div className="flex flex-none items-center gap-2">
            <LogoutButton />
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 bg-base-200" aria-label="Módulo de compras">
          {children}
        </main>
      </div>

      <div className="drawer-side z-20">
        <label
          htmlFor="main-drawer"
          aria-label="Cerrar menú"
          className="drawer-overlay"
        />
        <aside className="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-100 text-base-content">
          <div className="flex justify-center border-b border-base-300 px-6 py-5">
            <Image
              src="/logo.png"
              alt="Restoli Analytics"
              width={180}
              height={145}
              priority
              className="h-auto w-36 object-contain"
            />
          </div>
          <ul className="menu w-full flex-1 p-4">
            <li>
              <Link href="/protected" aria-current="page" className="active">
                <ShoppingBasket className="size-4" aria-hidden="true" />
                Compras
              </Link>
            </li>
            {isRoot ? (
              <li>
                <Link href="/protected/access">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Control de accesos
                </Link>
              </li>
            ) : null}
          </ul>
        </aside>
      </div>
    </div>
    </PurchaseViewContext.Provider>
  );
}
