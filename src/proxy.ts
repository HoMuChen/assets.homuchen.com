import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/session";

export function proxy(request: NextRequest) {
  if (isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Exact-match the public paths (`$`) so look-alikes such as /login-x still require a session.
  // The PWA files must be public too: browsers fetch the manifest and icons without cookies.
  // api/heartbeat checks its own bearer token (HEARTBEAT_TOKEN).
  matcher: [
    "/((?!login$|api/health$|api/heartbeat$|_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$|sw\\.js$|offline\\.html$|icons/).*)",
  ],
};
