import clsx from "clsx";
import { ChevronDown, ListTree, LogOut, MessagesSquare, Mic } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { useLogout, useMe } from "../api/queries";
import { ChatNav } from "../features/chat/ChatNav";
import { CategoryNav } from "../features/meetings/CategoryNav";
import { InvitationBell } from "../features/meetings/InvitationBell";
import { Menu, MenuItem } from "./ui/Menu";
import { Button } from "./ui/Button";

const NAV = [
  { to: "/", label: "회의", icon: Mic, end: true },
  { to: "/chat", label: "채팅", icon: MessagesSquare, end: false },
];

/**
 * One row shape for everything selectable in the sidebar — a nav link and a
 * saved conversation are the same kind of thing, so they sit the same way.
 *
 * The *states* are not one thing, and used to be drawn as one. A row can be:
 *
 *   ACTIVE    the list this row points at is the list on screen. A quiet sunken
 *             surface, never a blue block.
 *   SELECTED  the record this row points at is open in the main pane. Tinted
 *             and marked down its left edge, because "I am filtering by this
 *             folder" and "I have this meeting open" are different answers and
 *             a second shade of the same grey made them look like one.
 *   IDLE      neither — and hover belongs to it alone.
 *
 * Expanded is not in this list: a folder being unfolded is the chevron's
 * business (`aria-expanded`), not the row's. Neither is keyboard focus, which
 * is the global `:focus-visible` ring in `index.css` and must stay legible on
 * top of any of the three.
 */
export const NAV_ROW =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors";
export const NAV_ROW_ACTIVE = "bg-surface-sunken font-medium text-fg";
export const NAV_ROW_SELECTED =
  "relative bg-primary-soft font-medium text-fg before:absolute before:inset-y-1 "
  + "before:left-0 before:w-[3px] before:rounded-full before:bg-primary";
export const NAV_ROW_IDLE = "text-fg-muted hover:bg-surface-muted hover:text-fg";

/**
 * Who is signed in, and the one thing you can do about it.
 *
 * A menu rather than a naked 로그아웃 button beside the bell: the top-right is
 * two controls, and one of them signing you out on a single click is not what
 * that corner is for.
 */
function AccountMenu() {
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <Menu
      label="계정 메뉴"
      trigger={
        <button
          type="button"
          aria-label={`계정 메뉴${me ? ` (${me.display_name})` : ""}`}
          className={clsx(
            "flex max-w-44 items-center gap-1.5 rounded-md py-1 pr-1 pl-1.5",
            "text-[13px] text-fg-muted transition-colors",
            "hover:bg-surface-muted hover:text-fg data-[state=open]:bg-surface-muted",
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[11px] font-semibold text-fg-muted">
            {me?.display_name?.slice(0, 1) ?? "?"}
          </span>
          <span className="hidden min-w-0 truncate sm:block">{me?.display_name}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      }
    >
      <div className="px-2 pt-1 pb-1.5">
        <p className="truncate text-[13px] font-medium text-fg">{me?.display_name}</p>
        <p className="truncate text-[11px] text-fg-subtle">{me?.username}</p>
      </div>
      <div className="my-1 h-px bg-border" />
      <MenuItem
        icon={<LogOut aria-hidden className="size-3.5" />}
        onSelect={() =>
          logout.mutate(undefined, {
            onSettled: () => navigate("/login", { replace: true }),
          })
        }
      >
        로그아웃
      </MenuItem>
    </Menu>
  );
}

/**
 * The top-right of every screen: notifications, then the account.
 *
 * It lives in `PageHeader` rather than in a bar of its own, because a second
 * full-width strip above every page header would be two headers stacked with
 * nothing in the first one. 공유 알림 used to be a row in the sidebar navigation,
 * which read as a place to go — it is a thing that happened, and things that
 * happen belong in the corner where a person already looks for them.
 */
function ShellUtilities() {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-2 sm:gap-1 sm:pl-3">
      <InvitationBell />
      <AccountMenu />
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
 *
 * From `md` the shell is exactly one viewport tall and nothing outside a page's
 * own content region scrolls: the sidebar, the page header, and the chat
 * composer stay where they are. Below it the whole document scrolls normally,
 * because a fixed chrome on a short screen leaves nothing for the content.
 */
export function AppShell() {
  const onChat = useLocation().pathname.startsWith("/chat");
  const [listOpen, setListOpen] = useState(false);

  return (
    <div className="min-h-dvh md:flex md:h-dvh md:overflow-hidden">
      {/* Named, because it is not the only `complementary` landmark on the chat
          route — the 출처 panel is the other one, and two unnamed ones are
          indistinguishable to anything navigating by landmark. */}
      <aside
        aria-label="사이드바"
        className="sticky top-0 z-30 flex shrink-0 flex-col border-b border-border bg-surface md:h-dvh md:w-60 md:border-r md:border-b-0"
      >
        <div className="flex items-center gap-2 px-3 py-2 md:flex-col md:items-stretch md:gap-3 md:px-2.5 md:py-3">
          {/* A way home, not a statement about where you are: as a `NavLink`
              without `end` it matched every path and wore aria-current="page"
              on every screen, beside whichever row was actually current. */}
          <Link
            to="/"
            className="flex items-center gap-2 px-1 text-[15px] font-semibold tracking-tight text-fg"
          >
            <span className="flex size-6 items-center justify-center rounded-md bg-fg text-[11px] font-bold text-surface">
              M
            </span>
            Minutes
          </Link>
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
            className="ml-auto md:hidden"
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
            icon={<ListTree aria-hidden className="size-4" />}
          >
            {onChat ? "대화 목록" : "카테고리"}
          </Button>
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
      </aside>

      <main className="flex min-w-0 flex-1 flex-col md:h-dvh md:overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The one header a page gets, inside the shell's main column.
 *
 * Left to right: where you are, what you can do here, and — always last, always
 * the same two controls — the shell's own utilities. Every screen renders
 * exactly one of these, so the bell and the account never move and never appear
 * twice.
 */
export function PageHeader({
  title, meta, actions, back,
}: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2.5 sm:px-5">
      {back}
      <div className="min-w-0 flex-1">
        <h1 className="text-title truncate">{title}</h1>
        {meta ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
      <ShellUtilities />
    </header>
  );
}

/**
 * The scrolling region under a page header.
 *
 * From `md` the shell is one viewport tall, so this is the only thing on the
 * page that moves; below it the height constraint is gone and the document
 * scrolls as usual. `max` is where the content stops widening — a table wants
 * more room than a form.
 */
export function PageBody({
  children, className, max = "max-w-6xl",
}: { children: ReactNode; className?: string; max?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={clsx("mx-auto w-full px-4 py-4 sm:px-5", max, className)}>{children}</div>
    </div>
  );
}
