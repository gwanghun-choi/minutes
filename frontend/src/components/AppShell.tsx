import clsx from "clsx";
import { ListTree, LogOut, MessagesSquare, Mic } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { useLogout, useMe } from "../api/queries";
import { ChatNav } from "../features/chat/ChatNav";
import { CategoryNav } from "../features/meetings/CategoryNav";
import { Button } from "./ui/Button";

const NAV = [
  { to: "/", label: "회의", icon: Mic, end: true },
  { to: "/chat", label: "채팅", icon: MessagesSquare, end: false },
];

/**
 * One row style for everything selectable in the sidebar — a nav link and a
 * saved conversation are the same kind of thing, so they look the same. The
 * active row is a quiet surface, not a blue block.
 */
export const NAV_ROW =
  "flex items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors";
export const NAV_ROW_ACTIVE = "bg-surface-muted font-medium text-fg";
export const NAV_ROW_IDLE = "text-fg-muted hover:bg-surface-muted hover:text-fg";

function UserBlock({ compact }: { compact: boolean }) {
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  const signOut = () => {
    logout.mutate(undefined, { onSettled: () => navigate("/login", { replace: true }) });
  };

  return (
    <div className={clsx("flex items-center gap-1", compact ? "" : "justify-between")}>
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

/**
 * One sidebar, whichever way the screen runs.
 *
 * Chat history lives *inside* it rather than in a second panel the chat route
 * unfolds beside it: a conversation is somewhere you navigate to, so it belongs
 * with the navigation and shares its row style. The category tree is the same
 * kind of thing for the meeting side, so it sits in the same slot — one panel
 * whose contents depend on the route, never two panels.
 *
 * Below `md` the same element becomes a top bar and that panel collapses behind
 * one button — mounted once either way, so there is no second copy of the list
 * to drift.
 */
export function AppShell() {
  const onChat = useLocation().pathname.startsWith("/chat");
  const [listOpen, setListOpen] = useState(false);

  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 z-30 flex shrink-0 flex-col border-b border-border bg-surface md:h-dvh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-3 py-2 md:flex-col md:items-stretch md:gap-2.5 md:px-2.5 md:py-3">
          <NavLink to="/" className="px-1 text-[15px] font-semibold tracking-tight text-fg">
            Minutes
          </NavLink>
          <nav aria-label="주요 메뉴" className="flex gap-0.5 md:flex-col">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setListOpen(false)}
                className={({ isActive }) =>
                  clsx(NAV_ROW, isActive ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)
                }
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
            icon={<ListTree aria-hidden className="size-4" />}
          >
            {onChat ? "대화 목록" : "카테고리"}
          </Button>
          <div className="ml-auto md:hidden">
            <UserBlock compact />
          </div>
        </div>

        {/* One slot, filled by whatever the current route navigates within:
            conversations on the chat route, categories everywhere else. */}
        <div
          className={clsx(
            "min-h-0 flex-col border-t border-border md:flex",
            listOpen ? "flex max-h-64" : "hidden",
          )}
        >
          {onChat ? (
            <ChatNav onNavigate={() => setListOpen(false)} />
          ) : (
            <CategoryNav onNavigate={() => setListOpen(false)} />
          )}
        </div>

        <div className="mt-auto hidden border-t border-border px-3 py-2 md:block">
          <UserBlock compact={false} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col md:min-h-dvh">
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
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-border bg-surface px-5 py-3.5">
      {back}
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold text-fg">{title}</h1>
        {meta ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
