import clsx from "clsx";
import { LogOut, MessagesSquare, Mic } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { useLogout, useMe } from "../api/queries";
import { Button } from "./ui/Button";

const NAV = [
  { to: "/", label: "회의", icon: Mic, end: true },
  { to: "/chat", label: "채팅", icon: MessagesSquare, end: false },
];

function NavLinks({ vertical }: { vertical: boolean }) {
  return (
    <nav
      aria-label="주요 메뉴"
      className={clsx("flex gap-1", vertical ? "flex-col" : "flex-row")}
    >
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            clsx(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary-soft text-primary"
                : "text-fg-muted hover:bg-surface-muted hover:text-fg",
            )
          }
        >
          <Icon aria-hidden className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function UserBlock({ compact }: { compact: boolean }) {
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  const signOut = () => {
    logout.mutate(undefined, { onSettled: () => navigate("/login", { replace: true }) });
  };

  return (
    <div className={clsx("flex items-center gap-2", compact ? "" : "justify-between")}>
      <span className="min-w-0 truncate text-xs text-fg-muted" title={me?.username}>
        {me?.display_name}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={signOut}
        loading={logout.isPending}
        icon={<LogOut aria-hidden className="size-4" />}
        aria-label="로그아웃"
      >
        <span className={compact ? "sr-only" : ""}>로그아웃</span>
      </Button>
    </div>
  );
}

/** Sidebar on desktop, a single top bar below `md`. One nav definition drives both. */
export function AppShell() {
  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 z-30 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface px-3 py-4 md:flex">
        <NavLink to="/" className="mb-5 px-2.5 text-lg font-semibold tracking-tight text-fg">
          Minutes
        </NavLink>
        <NavLinks vertical />
        <div className="mt-auto border-t border-border pt-3">
          <UserBlock compact={false} />
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5 md:hidden">
        <NavLink to="/" className="text-base font-semibold text-fg">
          Minutes
        </NavLink>
        <NavLinks vertical={false} />
        <div className="ml-auto">
          <UserBlock compact />
        </div>
      </header>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** Contextual header for a page, inside the shell's main column. */
export function PageHeader({
  title, meta, actions, back,
}: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-border bg-surface px-5 py-4">
      {back}
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        {meta ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
