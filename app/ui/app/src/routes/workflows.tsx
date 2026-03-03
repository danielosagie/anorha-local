import { createFileRoute } from "@tanstack/react-router";
import { SidebarLayout } from "@/components/layout/layout";
import { ChatSidebar } from "@/components/ChatSidebar";
import WorkflowStudio from "@/components/workflows/WorkflowStudio";

export const Route = createFileRoute("/workflows")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarLayout sidebar={<ChatSidebar currentSection="workflows" />}>
      <WorkflowStudio />
    </SidebarLayout>
  );
}

