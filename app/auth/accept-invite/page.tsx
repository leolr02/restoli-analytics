import { redirect } from "next/navigation";
import { AcceptInvitationForm } from "@/components/accept-invitation-form";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string }>;
}) {
  const { token_hash, type } = await searchParams;

  if (!token_hash || type !== "invite") {
    redirect("/auth/error");
  }

  return <AcceptInvitationForm tokenHash={token_hash} />;
}
