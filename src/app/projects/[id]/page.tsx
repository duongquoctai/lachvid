import StudioWorkspace from "@/components/StudioWorkspace";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StudioWorkspace projectId={id} />;
}
