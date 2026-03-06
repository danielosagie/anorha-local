import { createFileRoute, redirect } from "@tanstack/react-router";
import Settings from "@/components/Settings";
import { isAppAuthEnabled, isAppSignedIn } from "@/lib/appAuth";

export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    if (isAppAuthEnabled() && !isAppSignedIn()) {
      throw redirect({ to: "/login" });
    }
  },
  component: Settings,
});
