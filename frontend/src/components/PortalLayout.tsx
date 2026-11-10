import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  ArrowRight,
  Bell,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  House,
  LogOut,
  Menu,
  MessageCircle,
  UserRound,
  X,
} from "lucide-react";
import type { Role, Ticket } from "@servicecare/contracts";
import { demoMode } from "../lib/auth";
import { ticketNotifications } from "../lib/support";
import { Brand } from "./Brand";

export function PortalLayout({
  role,
  onSignOut,
  tickets,
  children,
}: Readonly<{
  role: Role;
  onSignOut: () => void;
  tickets: Ticket[];
  children: ReactNode;
}>) {
  const advisor = role === "advisor";
  const menu = useRef<HTMLDialogElement>(null);
  const [drawer, setDrawer] = useState<"menu" | "notifications">("menu");
  const [closing, setClosing] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const notifications = ticketNotifications(tickets, role);
  const unread = notifications.filter((item) => !seen.has(item.id)).length;
  const notificationLabel = unread
    ? `Notifications, ${unread} unread`
    : "Notifications";
  const openCount = tickets.filter(
    (ticket) => !["RESOLVED", "CLOSED"].includes(ticket.status),
  ).length;
  const links = advisor
    ? [{ path: "/advisor", title: "Service queue", icon: ClipboardList }]
    : [
        { path: "/home", title: "Home", icon: House },
        { path: "/my-tickets", title: "My requests", icon: ClipboardList },
      ];
  useEffect(() => {
    menu.current?.close();
    setDrawerOpen(false);
    setClosing(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);
  function showDrawer(kind: "menu" | "notifications") {
    setDrawer(kind);
    setClosing(false);
    setDrawerOpen(true);
    menu.current?.showModal();
  }
  function closeDrawer() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      menu.current?.close();
      setDrawerOpen(false);
      return;
    }
    setClosing(true);
  }
  function closeForNavigation() {
    menu.current?.close();
    setDrawerOpen(false);
    setClosing(false);
  }
  return (
    <div
      className={`portal-shell ${advisor ? "advisor-portal" : "customer-portal"}`}
    >
      <a className="skip-link" href="#portal-main">
        Skip to content
      </a>
      <header className="portal-header">
        <div className="portal-header-inner">
          <Brand
            subtitle={advisor ? "SERVICE ADVISOR DESK" : "CUSTOMER SUPPORT"}
          />
          <nav className="portal-desktop-nav" aria-label="Main navigation">
            {links.map((item) => (
              <NavLink key={item.path} to={item.path}>
                {item.title}
                {item.path.endsWith("tickets") && openCount > 0 && (
                  <span className="request-count">{openCount}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="portal-header-tools">
            <button
              className="notification-toggle"
              aria-label={notificationLabel}
              title="Notifications"
              aria-haspopup="dialog"
              onClick={() => showDrawer("notifications")}
            >
              <Bell size={22} />
              {unread > 0 && <span>{unread}</span>}
            </button>
            <button
              className="portal-menu-toggle"
              aria-label="Open menu"
              title="Open menu"
              aria-haspopup="dialog"
              onClick={() => showDrawer("menu")}
            >
              <Menu size={23} />
            </button>
          </div>
        </div>
      </header>
      {advisor && (
        <div className="advisor-workspace-band">
          <div>
            <span className="advisor-status-dot" />
            SERVICE OPERATIONS
            <span className="workspace-account">
              {demoMode ? "Demo workspace" : "Advisor workspace"}
            </span>
          </div>
        </div>
      )}
      <main id="portal-main" className="portal-main" key={role}>
        {children}
      </main>
      {!advisor && location.pathname === "/home" && (
        <footer className="home-tagline">
          <span>OVERDRIVE</span>
          <p>More confidence. Every journey.</p>
        </footer>
      )}
      <nav className="portal-bottom-nav" aria-label="Bottom navigation">
        {links.map((item) => (
          <NavLink key={item.path} to={item.path}>
            <item.icon size={21} />
            <span>{item.title}</span>
            {item.path === "/my-tickets" && openCount > 0 && (
              <small>{openCount}</small>
            )}
          </NavLink>
        ))}
      </nav>
      {!advisor && location.pathname !== "/service-assistant" && (
        <Link
          to="/service-assistant"
          className="servicecare-fab"
          aria-label="Open Overdrive chat"
          title="Ask Overdrive"
        >
          <MessageCircle size={25} />
        </Link>
      )}
      <dialog
        ref={menu}
        className={`portal-side-drawer ${closing ? "is-closing" : ""}`}
        aria-labelledby="portal-menu-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDrawer();
        }}
        onClose={() => {
          setDrawerOpen(false);
          setClosing(false);
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && closing) {
            menu.current?.close();
            setDrawerOpen(false);
            setClosing(false);
          }
        }}
      >
        <div className="drawer-heading">
          <h2 id="portal-menu-title">
            {drawer === "menu" ? "Your account" : "Notifications"}
          </h2>
          <button
            className="icon-button"
            title="Close drawer"
            aria-label="Close drawer"
            onClick={closeDrawer}
          >
            <X size={23} />
          </button>
        </div>
        {drawer === "menu" ? (
          <>
            <div className="drawer-account-label">
              <UserRound size={25} />
              <div>
                <strong>
                  {advisor ? "Service advisor" : "My Overdrive"}
                </strong>
                <span>
                  {demoMode ? "Demo account" : "Authenticated account"}
                </span>
              </div>
            </div>
            <nav aria-label="Account navigation">
              <Link to="/profile" onClick={closeForNavigation}>
                <UserRound size={21} />
                <span>My profile</span>
                <ChevronRight size={17} />
              </Link>
            </nav>
            <button
              className="menu-signout"
              onClick={() => {
                closeForNavigation();
                onSignOut();
              }}
            >
              <LogOut size={18} />
              Sign out
            </button>
            <p className="drawer-brand">OVERDRIVE</p>
          </>
        ) : (
          <>
            <div className="notification-actions">
              <span>{unread} unread</span>
              <button
                disabled={!unread}
                onClick={() =>
                  setSeen(new Set(notifications.map((item) => item.id)))
                }
              >
                <CheckCheck size={16} />
                Mark all read
              </button>
            </div>
            {notifications.length ? (
              <div className="notification-list">
                {notifications.map((item) => (
                  <Link
                    to={`/ticket/${item.ticketId}`}
                    key={item.id}
                    className={seen.has(item.id) ? "" : "unread"}
                    onClick={() => {
                      setSeen((current) => new Set([...current, item.id]));
                      closeForNavigation();
                    }}
                  >
                    <span className="notification-dot" />
                    <div>
                      <strong>{item.text}</strong>
                      <p>{item.title}</p>
                      <time>
                        {new Date(item.at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </div>
                    <ArrowRight size={16} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="notification-empty">
                <Bell size={32} />
                <h3>You're all caught up.</h3>
                <p>Service request updates will appear here.</p>
              </div>
            )}
            <p className="notification-disclaimer">
              Updates from your loaded requests. Refresh Requests for the latest
              activity.
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}
