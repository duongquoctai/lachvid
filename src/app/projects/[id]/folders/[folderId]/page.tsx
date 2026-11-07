import StudioWorkspace from "@/components/StudioWorkspace";

export default async function FolderWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; folderId: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id, folderId } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const initialTab = typeof sp?.tab === "string" ? sp.tab : undefined;

  return (
    <StudioWorkspace
      projectId={folderId}
      parentProjectId={id}
      initialTab={initialTab}
    />
  );
}
