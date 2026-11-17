import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    return jsonError("Falta configurar APP_URL en el servidor.", 503);
  }

  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(appUrl).origin;
  } catch {
    return jsonError("APP_URL no tiene un formato válido.", 500);
  }

  const requestOrigin = request.headers.get("origin");
  if (requestOrigin) {
    try {
      if (new URL(requestOrigin).origin !== configuredOrigin) {
        return jsonError("Solicitud no permitida.", 403);
      }
    } catch {
      return jsonError("Solicitud no permitida.", 403);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("El cuerpo de la solicitud no es válido.", 400);
  }

  const emailValue =
    typeof body === "object" && body !== null && "email" in body
      ? body.email
      : null;
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError("Escribe un correo electrónico válido.", 400);
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return jsonError("Debes iniciar sesión para enviar invitaciones.", 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_access_profiles")
    .select("profile_key")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (profileError) {
    return jsonError("No se pudo comprobar el perfil del usuario.", 500);
  }
  if (profile?.profile_key !== "root") {
    return jsonError("Solo root puede enviar invitaciones.", 403);
  }

  if (!process.env.SUPABASE_SECRET_KEY) {
    return jsonError("Falta configurar SUPABASE_SECRET_KEY en el servidor.", 503);
  }

  const redirectTo = new URL("/auth/accept-invite", appUrl);

  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo.toString(),
    });

    if (error) {
      console.error("Supabase inviteUserByEmail failed", {
        status: error.status,
        code: error.code,
        message: error.message,
      });

      if (error.code === "email_exists") {
        return jsonError(
          "Ese correo ya tiene una cuenta en Supabase. Busca el usuario en la lista para asignarle acceso.",
          409,
        );
      }

      if (error.code === "email_address_not_authorized") {
        return jsonError(
          "Supabase sigue usando el SMTP predeterminado, que solo permite enviar correos a miembros de tu organización. Configura y activa el SMTP personalizado.",
          502,
        );
      }

      if (error.code === "over_email_send_rate_limit") {
        return jsonError(
          "Supabase alcanzó el límite de envío de correos. Espera antes de volver a intentarlo.",
          429,
        );
      }

      const diagnostic = [
        error.code ? `código ${error.code}` : null,
        typeof error.status === "number" ? `HTTP ${error.status}` : null,
        process.env.NODE_ENV === "development" ? error.message : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return jsonError(
        `Supabase no pudo enviar la invitación${diagnostic ? ` (${diagnostic})` : ""}. Revisa la configuración de Auth y del correo.`,
        502,
      );
    }
  } catch {
    return jsonError("No se pudo inicializar el servicio de invitaciones.", 503);
  }

  return NextResponse.json({ ok: true });
}
