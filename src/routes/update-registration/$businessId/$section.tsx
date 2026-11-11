import { createFileRoute } from '@tanstack/react-router';
import UpdateRegistrationSection from '@/pages/UpdateRegistrationSection';

export const Route = createFileRoute(
  '/update-registration/$businessId/$section',
)({
  component: UpdateRegistrationSection,
});
