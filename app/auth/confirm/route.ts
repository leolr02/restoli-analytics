import { createClient } from "@/lib/supabase/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const requestedType = searchParams.get("type");
  const nextPath = searchParams.get("next");
  const next = nextPath === "/auth/setup-password" || nextPath === "/protected"
    ? nextPath
    : "/";
  const errorUrl = new URL("/auth/error", request.url);

  if (!token_hash || (requestedType !== "email" && requestedType !== "invite")) {
    return NextResponse.redirect(errorUrl);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: requestedType as EmailOtpType,
    token_hash,
  });

  if (error) {
    return NextResponse.redirect(errorUrl);
  }

  return NextResponse.redirect(new URL(next, request.url));
}
