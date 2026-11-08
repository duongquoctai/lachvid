import { redirect } from "next/navigation";
import StudioWorkspace from "@/components/StudioWorkspace";
import { getCurrentUser } from "@/lib/auth";
import { resolveFolderAccess } from "@/lib/db";

export default async function FolderWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; folderId: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id, folderId } = await params;
  const user = await getCurrentUser();
  const access = await resolveFolderAccess(folderId, user?.id, user?.email);

  if (access.role === "none") {
    redirect(`/projects/${id}`);
  }

  const sp = searchParams ? await searchParams : undefined;
  const initialTab = typeof sp?.tab === "string" ? sp.tab : undefined;

  return (
    <StudioWorkspace
      projectId={folderId}
      parentProjectId={id}
      initialTab={initialTab}
      access={access}
    />
  );
}
