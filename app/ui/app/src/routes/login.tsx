import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  APP_AUTH_PROVIDER,
  APP_AUTH_SIGNIN_URL,
  APP_AUTH_SIGNUP_URL,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isAppAuthEnabled, isAppSignedIn, markAppSignedIn } from "@/lib/appAuth";

export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    if (!isAppAuthEnabled()) {
      throw redirect({ to: "/" });
    }
    if (isAppSignedIn()) {
      throw redirect({ to: "/c/$chatId", params: { chatId: "new" } });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);

  const openUrl = (url: string) => {
    if (!url) return;
    window.open(url, "_blank");
    setOpened(true);
  };

  const completeSignIn = () => {
    markAppSignedIn();
    navigate({
      to: "/c/$chatId",
      params: { chatId: "new" },
    });
  };

  return (
    <main className="min-h-screen w-full bg-neutral-950 text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-6 py-10">
        <div className="grid w-full gap-10 lg:grid-cols-[1.15fr,1fr]">
          <section className="space-y-5">
            <Badge color="blue">Anorha Local</Badge>
            <h1 className="text-4xl font-semibold tracking-tight">
              Sign in to Anorha
            </h1>
            <p className="max-w-xl text-sm text-neutral-300">
              App access is managed separately from provider accounts. After
              signing into Anorha, you can connect Ollama Cloud or other
              provider keys in Settings.
            </p>
            <div className="space-y-2 text-sm text-neutral-400">
              <div>1. Sign in or create your Anorha account.</div>
              <div>2. Return here and confirm to unlock the app.</div>
              <div>3. Connect Ollama/provider credentials separately.</div>
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/90 p-6 shadow-2xl">
            <div className="mb-5 text-sm text-neutral-300">
              Authentication provider:{" "}
              <span className="font-medium uppercase tracking-wide text-neutral-100">
                {APP_AUTH_PROVIDER}
              </span>
            </div>

            <div className="space-y-3">
              <Button
                type="button"
                color="white"
                className="w-full justify-center"
                onClick={() => openUrl(APP_AUTH_SIGNIN_URL)}
              >
                Sign In
              </Button>

              {APP_AUTH_SIGNUP_URL ? (
                <Button
                  type="button"
                  color="zinc"
                  className="w-full justify-center"
                  onClick={() => openUrl(APP_AUTH_SIGNUP_URL)}
                >
                  Create Account
                </Button>
              ) : null}

              <Button
                type="button"
                color="dark"
                className="w-full justify-center"
                onClick={completeSignIn}
                disabled={!opened}
              >
                I&apos;m signed in, continue
              </Button>
            </div>

            {!opened ? (
              <p className="mt-4 text-xs text-neutral-400">
                Open sign-in first. Then click continue.
              </p>
            ) : (
              <p className="mt-4 text-xs text-emerald-300">
                Sign-in window opened. Continue when authentication is complete.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

