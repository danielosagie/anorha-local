import { createFileRoute, redirect } from "@tanstack/react-router";
import { isAppAuthEnabled, isAppSignedIn } from "@/lib/appAuth";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (isAppAuthEnabled() && !isAppSignedIn()) {
      throw redirect({ to: "/login" });
    }
    throw redirect({
      to: "/c/$chatId",
      params: { chatId: "new" },
      mask: {
        to: "/",
      },
    });
  },
});
