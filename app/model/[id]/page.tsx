import ModelScreen from "@/components/model/ModelScreen";

export default async function ModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="h-dvh w-full">
      <ModelScreen id={decodeURIComponent(id)} />
    </main>
  );
}
