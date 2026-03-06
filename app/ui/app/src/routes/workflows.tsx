import { createFileRoute, redirect } from "@tanstack/react-router";
import { SidebarLayout } from "@/components/layout/layout";
import { ChatSidebar } from "@/components/ChatSidebar";
import WorkflowStudio from "@/components/workflows/WorkflowStudio";
import { isAppAuthEnabled, isAppSignedIn } from "@/lib/appAuth";

export const Route = createFileRoute("/workflows")({
  beforeLoad: () => {
    if (isAppAuthEnabled() && !isAppSignedIn()) {
      throw redirect({ to: "/login" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarLayout sidebar={<ChatSidebar currentSection="workflows" />}>
      <WorkflowStudio />
    </SidebarLayout>
  );
}
