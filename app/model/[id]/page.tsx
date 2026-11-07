import { notFound } from "next/navigation";
import ViewerClient from "./ViewerClient";
import { demoModel } from "@/lib/demo";

export default async function ModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO(Person A): load saved models from /api/models storage. Only the demo exists for now.
  if (id !== "demo") notFound();
  return (
    <main className="h-dvh w-full">
      <ViewerClient model={demoModel} />
    </main>
  );
}
