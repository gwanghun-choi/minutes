import { Navigate, Route, Routes, useLocation } from "react-router";

import { useMe } from "./api/queries";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui/feedback";
import { CategoriesPage } from "./routes/CategoriesPage";
import { ChatPage } from "./routes/ChatPage";
import { LoginPage } from "./routes/LoginPage";
import { MeetingPage } from "./routes/MeetingPage";
import { MeetingsPage } from "./routes/MeetingsPage";
import { NotFoundPage } from "./routes/NotFoundPage";

/**
 * The gate is a convenience, not the boundary — every `/api/*` route is closed
 * server-side. This only decides which screen to render while the server does
 * the refusing.
 */
function RequireAuth() {
  const { data: me, isPending } = useMe();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6" />
        <span className="sr-only">불러오는 중</span>
      </div>
    );
  }
  if (!me) {
    // Remember where they were headed so login can send them back there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <AppShell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<MeetingsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:meetingId" element={<MeetingPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
