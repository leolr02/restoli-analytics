import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SetupInvitedPasswordForm } from "@/components/setup-invited-password-form";
import { createClient } from "@/lib/supabase/server";

export default async function SetupPasswordPage() {
  await connection();

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/");
  }

  return <SetupInvitedPasswordForm />;
}
