import StudioWorkspace from "@/components/StudioWorkspace";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const initialTab = typeof sp?.tab === "string" ? sp.tab : undefined;
  return <StudioWorkspace projectId={id} initialTab={initialTab} />;
}
