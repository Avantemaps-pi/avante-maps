import { createFileRoute } from "@tanstack/react-router";
import UpdateRegistration from "@/pages/UpdateRegistration";

export const Route = createFileRoute("/update-registration/$businessId/")({
  component: UpdateRegistration,
});
